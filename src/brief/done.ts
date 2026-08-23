/**
 * Ticking something off.
 *
 * A brief that keeps asking for something you did last Tuesday is worse than
 * one that never asked: you stop reading the section. So every card in the two
 * action sections, and every row in the calendar fold, carries a tick, and a
 * ticked one stays ticked tomorrow.
 *
 * **The store is the browser's, not the pipeline's.** The page is read on a
 * phone, and nothing on a phone can write to `~/.aula`. So the record lives in
 * `localStorage` on the origin the page is served from, and each morning's
 * fresh page hides what has already been ticked. `state.json` never learns —
 * which means the ranker still ranks a done item, the model still plans around
 * it, and the topline may still count it. That is the price of the reader
 * being the one who knows, and it is worth paying: the alternative is reading
 * the hosted page back over the network on every run, in the one leg of the
 * pipeline that already needs the network, a model and claude.ai credentials.
 *
 * Two things make this survive the daily republish:
 *
 * - **The origin is per-artifact and stable.** The page runs in a sandboxed
 *   frame on `<artifact-uuid>.frame.claudeusercontent.com`, with
 *   `allow-same-origin` set — measured on the real deployment, not assumed,
 *   because without that flag the frame gets an opaque origin and every
 *   `localStorage` access throws. Storage is keyed by origin and not by
 *   version, so `force: true` replacing the whole page each morning leaves it
 *   untouched.
 * - **The key is not the card id.** See `doneKeys`.
 */

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
 * Written as a plain script rather than as markup, because `compose.ts` is the
 * one place page markup is written and that rule is worth more than the
 * convenience of building the ticks here. Everything this touches — the tick
 * buttons, the done-toggle, the empty-state panel — is rendered by the
 * composer and simply wired up here. What makes something tickable is the
 * `data-done-keys` attribute, not its class: a card and a calendar row are
 * different shapes with the same contract.
 *
 * `var` and `function` throughout, and no template literals: this string is
 * carried inside one, and the fewer characters that need escaping on the way
 * to the page, the fewer ways it can arrive subtly broken.
 */
export const DONE_SCRIPT = `
(function () {
  var STORE = 'aula.done.v1';
  // Long enough that a fortnight's window can never outlive a tick, short
  // enough that the store cannot grow forever. Nothing depends on the exact
  // number: an entry that expires early re-shows an item, which is the safe
  // direction to fail in.
  var KEEP_DAYS = 45;

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

  function setDone(card, done) {
    var stamp = new Date().toISOString();
    keysOf(card).forEach(function (key) {
      if (done) state[key] = stamp; else delete state[key];
    });
    save();
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

    var count = section.querySelector('[data-count]');
    if (count) count.textContent = String(live);

    // Nothing left to do is a result, not an empty section — the composer
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
  }

  [].slice.call(document.querySelectorAll('[data-section]')).forEach(function (section) {
    [].slice.call(section.querySelectorAll('[data-done-keys]')).forEach(function (card) {
      if (keysOf(card).some(function (key) { return !!state[key]; })) setDone(card, true);
      var tick = card.querySelector('.tick');
      if (!tick) return;
      tick.addEventListener('click', function () {
        setDone(card, !card.classList.contains('is-done'));
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

    refresh(section);
  });
})();
`;
