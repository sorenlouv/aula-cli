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
  const groups = [...html.matchAll(/<div class="timeline-group" data-timeline-group="([^"]+)">/g)]
    .map((match) => ({ key: match[1] ?? '', index: match.index ?? -1 }))
    .filter((group) => group.index >= 0);
  const groupFor = (index: number) => groups.findLast((group) => group.index < index);
  const expectedGroup = (placement: string): string[] => {
    if (placement === 'upcoming') return ['day:', 'next-week'];
    return [placement];
  };

  // 1. Nothing required was dropped: every full or compact timeline entry the
  //    ranker kept is on the page, in the section its placement requires.
  for (const entry of brief.timeline) {
    if (!html.includes(`data-signal-id="${entry.id}"`)) {
      violations.push({
        rule: 'must-show',
        detail: `"${entry.title}" (${entry.id}) mangler på siden`,
      });
      continue;
    }
    const index = html.indexOf(`data-signal-id="${entry.id}"`);
    const openTagStart = html.lastIndexOf('<', index);
    const openTagEnd = html.indexOf('>', index);
    const tag = html.slice(openTagStart, openTagEnd + 1);
    if (!tag.includes(`data-placement="${entry.placement}"`)) {
      violations.push({
        rule: 'placement',
        detail: `"${entry.title}" (${entry.id}) står ikke som ${entry.placement}`,
      });
    }
    const group = groupFor(index);
    const expected = expectedGroup(entry.placement);
    if (
      !group ||
      !expected.some((key) => (key.endsWith(':') ? group.key.startsWith(key) : group.key === key))
    ) {
      violations.push({
        rule: 'placement',
        detail: `"${entry.title}" (${entry.id}) står i sektionen ${group?.key || 'ingen'}, ikke ${expected.join(' eller ')}`,
      });
    }
  }

  // The section names and order are part of the parent-facing contract. The
  // card-level data attribute alone cannot catch a template that labels the
  // future group as next week or moves actions below the dated timeline.
  const fixedLabels: Record<string, string> = {
    action: 'Skal gøres',
    'next-week': 'Næste uge',
    future: 'Senere',
    undated: 'Uden fast dato',
    past: 'Tidligere',
  };
  const groupOrder = (key: string): number => {
    if (key === 'action') return 0;
    if (key.startsWith('day:')) return 1;
    if (key === 'next-week') return 2;
    if (key === 'future') return 3;
    if (key === 'undated') return 4;
    if (key === 'past') return 5;
    return Number.POSITIVE_INFINITY;
  };
  let previousOrder = -1;
  for (const [groupIndex, group] of groups.entries()) {
    const order = groupOrder(group.key);
    if (order < previousOrder) {
      violations.push({
        rule: 'section-order',
        detail: `sektionen ${group.key} står i forkert rækkefølge`,
      });
    }
    previousOrder = order;
    const label = fixedLabels[group.key];
    if (!label) continue;
    const nextGroupIndex = groups[groupIndex + 1]?.index ?? html.length;
    const section = html.slice(group.index, nextGroupIndex);
    if (!section.includes(`<h3 class="timeline-heading">${label}</h3>`)) {
      violations.push({
        rule: 'section-label',
        detail: `sektionen ${group.key} mangler overskriften "${label}"`,
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
