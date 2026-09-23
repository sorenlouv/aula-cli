/**
 * Ticking something off.
 *
 * A brief that keeps asking for something you did last Tuesday is worse than
 * one that never asked: you stop reading the section. So every full or compact
 * card in the timeline carries a tick, and a ticked one stays ticked tomorrow.
 *
 * **The record is the hosted copy's, and it is shared.** Two parents read the
 * same page on two phones, and a thing one of them did is done for both. So on
 * the hosted page a tick goes to the Worker behind it (`src/hosting/worker.ts`),
 * which keeps one row per key, and every answer carries the whole set back: the
 * page learns the other phone's ticks whenever it sends its own, loads, or
 * comes back into view. `localStorage` is only a cache in front of that. It
 * paints the last known state before the first answer arrives, so a done card
 * does not flash back into the list on every open, and the answer replaces it.
 *
 * A page opened from disk has no server to ask, and there `localStorage` is the
 * record, as it always was. Either way the pipeline never learns: `state.json`
 * does not read the ticks, so the ranker still ranks a done item and the
 * topline may still count it.
 *
 * **The key is not the card id.** See `doneKeys`.
 */

import { DONE_PATH, KEEP_DAYS } from '../hosting/protocol.ts';
import type { Card } from './types.ts';

/**
 * What a tick is recorded against.
 *
 * Not `card.id`: model cards are numbered `model:0`, `model:1` … by their
 * position in whatever came back and survived validation, so yesterday's
 * `model:3` is tomorrow's something else entirely. Storing that would tick off
 * a *different* item each morning — the "page looks fine and quietly left out
 * the meeting" failure, arrived at from the other direction.
 *
 * So the key is built from the two fields that mean the same thing tomorrow:
 * the source keys are Aula's own ids, and `date` is grounded against the source
 * text by `dates.ts` before it is allowed to exist. Deliberately *not* in the
 * key: `title` and `summary`, which the model words differently each morning.
 *
 * Including the date is also what scopes a tick correctly for something
 * recurring: next Monday's *husk løbetøj* has a different `dueAt`, so it comes
 * back, which is the whole point. An undated obligation gets `-` and stays
 * ticked until the sweep in the page script drops it.
 *
 * A card carries *several* keys, one per source it gathers — the same meeting
 * arriving as an invitation and a reminder is the normal case, and which
 * sources a card gathers can change between runs. Writing every key on the
 * tick, and matching on any of them, is what stops a regrouping resurrecting
 * something already dealt with.
 *
 * The cost, stated plainly: two *distinct* obligations from one source on one
 * date share a key, so ticking one hides both. Rare, and recoverable — a ticked
 * card is hidden behind the section's done-toggle, never dropped.
 *
 * A vendor plan has no item id. Its source key therefore includes provider,
 * capability and week, then the entry date plus its same-day occurrence when
 * dated, or its list position when undated. Dates keep an item stable when a
 * vendor reorders days; two entries on one day, or an undated entry, can still
 * move when the vendor reorders them. Changing from the older all-positional
 * key format makes existing plan items appear new once.
 *
 * The keys go onto the card space-separated, which is safe because a source key
 * cannot contain one: they are built in `collect.ts` from numeric ids, ISO
 * weeks and snake_case provider names.
 */
export function doneKeys(card: Pick<Card, 'sourceKeys' | 'date'>): string[] {
  const day = card.date ?? '-';
  return card.sourceKeys.map((key) => `${key}|${day}`);
}

/**
 * The behaviour half, inlined into the document by `publish.ts`.
 *
 * Written as a plain script rather than as markup, because `render.ts` is the
 * one place page markup is written and that rule is worth more than the
 * convenience of building the ticks here. Everything this touches — the tick
 * buttons, the done-toggle, the empty-state panel — is rendered by the
 * renderer and simply wired up here. What makes something tickable is the
 * `data-done-keys` attribute, not its class: full and compact cards share the
 * same contract.
 *
 * `var` and `function` throughout, and no template literals: this string is
 * carried inside one, and the fewer characters that need escaping on the way
 * to the page, the fewer ways it can arrive subtly broken.
 */
export const DONE_SCRIPT = `
(function () {
  var STORE = 'aula.done.v1';
  var KEEP_DAYS = ${KEEP_DAYS};

  // The hosted copy serves this page and its API from one origin. A page
  // opened from disk has nothing to ask, and its own storage is the record.
  var API =
    typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? '${DONE_PATH}' : null;

  // Private browsing, a blocked frame and Safari on file:// throw on access
  // rather than returning null, so both ends are wrapped. Nothing is done
  // about it beyond that: the ticks keep working against the object in memory
  // and forget on reload, which beats an inert button, and there is no third
  // behaviour worth the branch it would cost.
  var state = {};
  try { state = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) {}

  var now = Date.now();
  for (var key in state) {
    var stamp = Date.parse(state[key]);
    if (!isFinite(stamp) || now - stamp > KEEP_DAYS * 86400000) delete state[key];
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  }

  function keysOf(card) {
    return (card.getAttribute('data-done-keys') || '').split(' ').filter(Boolean);
  }

  function markDone(card, done) {
    card.classList.toggle('is-done', done);
    var tick = card.querySelector('.tick');
    if (tick) {
      tick.setAttribute('aria-pressed', done ? 'true' : 'false');
      tick.setAttribute('aria-label', done ? 'Fortryd — vis igen' : 'Markér som klaret');
    }
  }

  function refresh(section) {
    var cards = [].slice.call(section.querySelectorAll('[data-done-keys]'));
    var done = cards.filter(function (card) { return card.classList.contains('is-done'); }).length;
    var live = cards.length - done;

    // Nothing left to do is a result, not an empty section — the renderer
    // renders the sentence for it and this is where it earns its place.
    var empty = section.querySelector('[data-empty]');
    if (empty) empty.hidden = live > 0;

    if (done === 0) section.classList.remove('reveal');
    var toggle = section.querySelector('[data-done-toggle]');
    if (toggle) {
      var open = section.classList.contains('reveal');
      toggle.hidden = done === 0;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = done + ' klaret · ' + (open ? 'skjul' : 'vis');
    }

    // A date heading with no visible cards is as misleading as an empty
    // section. Keep the whole group hidden until completed cards are revealed.
    var reveal = section.classList.contains('reveal');
    [].slice.call(section.querySelectorAll('[data-timeline-group]')).forEach(function (group) {
      var groupCards = [].slice.call(group.querySelectorAll('[data-done-keys]'));
      var groupLive = groupCards.some(function (card) {
        return !card.classList.contains('is-done');
      });
      group.hidden = groupCards.length > 0 && !groupLive && !reveal;
    });
  }

  var sections = [].slice.call(document.querySelectorAll('[data-section]'));

  // Restoring a visual state must not renew its timestamp or add keys from a
  // card that the model grouped differently today. Only a click writes.
  function paint() {
    sections.forEach(function (section) {
      [].slice.call(section.querySelectorAll('[data-done-keys]')).forEach(function (card) {
        markDone(card, keysOf(card).some(function (key) { return !!state[key]; }));
      });
      refresh(section);
    });
  }

  // Every answer is the whole set, and replaces the cache whole. Only the
  // newest request's answer is applied: a load still in flight when a tick is
  // sent answers with the world as it was before the tick.
  //
  // A failure changes nothing on screen. A tick that did not arrive stays
  // ticked until the server's next answer says otherwise — the same bargain as
  // storage that forgets, and better than a button that ignores the press. An
  // expired Access login fails here too (its redirect to the login page is
  // cross-origin); the next load of the page is what signs in again.
  var latest = 0;
  function sync(init) {
    if (!API) return;
    var ticket = ++latest;
    fetch(API, init)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (body) {
        if (ticket !== latest || !body || !body.done || typeof body.done !== 'object') return;
        state = body.done;
        save();
        paint();
      })
      .catch(function () {});
  }

  function setDone(card, done) {
    var stamp = new Date().toISOString();
    var keys = keysOf(card);
    keys.forEach(function (key) {
      if (done) state[key] = stamp; else delete state[key];
    });
    save();
    sync({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: keys, done: done }),
    });
  }

  sections.forEach(function (section) {
    [].slice.call(section.querySelectorAll('[data-done-keys]')).forEach(function (card) {
      var tick = card.querySelector('.tick');
      if (!tick) return;
      tick.addEventListener('click', function () {
        var done = !card.classList.contains('is-done');
        setDone(card, done);
        markDone(card, done);
        refresh(section);
      });
    });

    var toggle = section.querySelector('[data-done-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        section.classList.toggle('reveal');
        refresh(section);
      });
    }
  });

  paint();
  sync();
  // A phone keeps the tab open for days, and coming back to it is when the
  // other parent's ticks matter — so that is when to ask again.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') sync();
  });
})();
`;
