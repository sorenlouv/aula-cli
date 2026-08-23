/**
 * The invariants, checked against the generated HTML.
 *
 * `buildPage` is the only renderer and satisfies these by construction — so
 * this is a regression net, not a gate the model can fail. It stays because
 * the invariants are the product: a template edit that drops `data-source-id`,
 * or a path that lets a hidden source through as a card, must fail loudly here
 * rather than ship quietly.
 *
 * The dangerous failure is not an ugly page. It is a page that looks perfectly
 * fine and silently left out the meeting.
 */

import { escapeHtml } from '../html.ts';
import type { RankedBrief } from './types.ts';

export type Violation = { rule: string; detail: string };

/**
 * Tags that could pull something in over the network — plus `<style>`, which
 * the body never has any business containing.
 *
 * Only *tags* are matched, and that is deliberate. Since the page grew its
 * more-blocks, verbatim Aula prose reaches the markup, and this check
 * runs over the rendered string with no way to tell a rendered tag from a
 * quoted one. `escapeHtml` turns a literal `<` into `&lt;`, so no amount of
 * angle brackets in a school post can trip these — whereas the CSS patterns
 * this used to carry (`@import`, `url(https:`) have no such protection, and a
 * parent who pasted a stylesheet URL into a message would have failed the whole
 * layout. Those patterns only ever mattered inside a stylesheet anyway, and
 * `<style\b` below is the stronger check for that.
 */
const EXTERNAL_RESOURCE = /<(?:img|script|link|style|iframe|object|embed|base)\b/i;

export function validatePage(html: string, brief: RankedBrief): Violation[] {
  const violations: Violation[] = [];

  // 1. Nothing required was dropped: every card the ranker kept is on the page.
  for (const card of brief.cards) {
    if (!html.includes(`data-signal-id="${card.id}"`)) {
      violations.push({
        rule: 'must-show',
        detail: `"${card.title}" (${card.id}) mangler på siden`,
      });
    }
  }

  // 2. Every claim is attributable. A card asserting something with no source
  //    is exactly the kind of confident, uncheckable statement to avoid.
  const signalIds = [...html.matchAll(/data-signal-id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of signalIds) {
    const index = html.indexOf(`data-signal-id="${id}"`);
    const openTagStart = html.lastIndexOf('<', index);
    const openTagEnd = html.indexOf('>', index);
    const tag = html.slice(openTagStart, openTagEnd + 1);
    if (!tag.includes('data-source-id=')) {
      violations.push({ rule: 'attribution', detail: `signal ${id} har ingen data-source-id` });
    }
    // A card the reader cannot tick off is a card that will still be there
    // tomorrow after they have dealt with it — the complaint this whole
    // mechanism exists to answer. The key is derived, so a renderer that
    // forgets to write it fails here rather than shipping a dead tick.
    if (!tag.includes('data-done-keys=')) {
      violations.push({ rule: 'dismissible', detail: `signal ${id} har ingen data-done-keys` });
    }
  }

  // 3. Failures are visible.
  if (!/data-block="datastatus"/.test(html)) {
    violations.push({ rule: 'datastatus', detail: 'datastatus-blokken mangler' });
  } else {
    for (const note of brief.input.health.filter((h) => h.level === 'warn')) {
      // Match on a distinctive fragment; the renderer may reword around it.
      // Escaped, because the page carries the escaped form — a vendor error
      // with an `&` in its first characters must not read as a missing warning.
      const stem = escapeHtml(
        note.message.split(' — ')[0]?.slice(0, 40) ?? note.message.slice(0, 40),
      );
      if (!html.includes(stem)) {
        violations.push({ rule: 'datastatus', detail: `advarsel mangler: "${stem}…"` });
      }
    }
  }

  // 4. Noise stays down: nothing the model hid may appear as a card. The first
  //    source has its own attribute; every source is also present as the prefix
  //    of a done key, so a merged card must be checked there too.
  const cardTags = [...html.matchAll(/<div class="card[^"]*"[^>]*>/g)].map((m) => m[0]);
  for (const item of brief.hidden) {
    if (
      cardTags.some((tag) => {
        if (tag.includes(`data-source-id="${item.key}"`)) return true;
        const done = /data-done-keys="([^"]*)"/.exec(tag)?.[1] ?? '';
        return done.split(' ').some((key) => key.startsWith(`${item.key}|`));
      })
    ) {
      violations.push({
        rule: 'noise',
        detail: `skjult "${item.title}" er vist som et kort`,
      });
    }
  }

  // 5. Self-contained. The page has to survive being a local file and a PDF.
  if (EXTERNAL_RESOURCE.test(html)) {
    violations.push({ rule: 'self-contained', detail: 'siden henter en ekstern ressource' });
  }

  // 6. Body markup only — the wrapper supplies the document.
  if (/<\/?(?:html|head|body|!doctype)\b/i.test(html)) {
    violations.push({ rule: 'fragment', detail: 'siden indeholder html/head/body-tags' });
  }

  // 7. Something was actually produced.
  if (html.trim().length < 200) {
    violations.push({ rule: 'empty', detail: 'siden er tom eller næsten tom' });
  }

  return violations;
}
