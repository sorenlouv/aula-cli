/**
 * The invariants, checked against the generated HTML.
 *
 * These used to be guaranteed by a fixed renderer. Letting the model design the
 * page means they have to be *verified* instead — and verification is strictly
 * better, because it also catches the fallback path and any future renderer.
 *
 * The dangerous failure is not an ugly page. It is a page that looks perfectly
 * fine and silently left out the meeting.
 */

import type { RankedBrief } from './types.ts';

export type Violation = { rule: string; detail: string };

const EXTERNAL_RESOURCE =
  /<img\b|<script\b[^>]*\bsrc=|<link\b|@import|url\(\s*['"]?https?:/i;

export function validatePage(html: string, brief: RankedBrief): Violation[] {
  const violations: Violation[] = [];

  // 1. Nothing required was dropped.
  for (const signal of brief.signals.filter((s) => s.mustShow)) {
    if (!html.includes(`data-signal-id="${signal.id}"`)) {
      violations.push({
        rule: 'must-show',
        detail: `"${signal.title}" (${signal.id}) mangler på siden`,
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
  }

  // 3. Failures are visible.
  if (!/data-block="datastatus"/.test(html)) {
    violations.push({ rule: 'datastatus', detail: 'datastatus-blokken mangler' });
  } else {
    for (const note of brief.input.health.filter((h) => h.level === 'warn')) {
      // Match on a distinctive fragment; the composer may reword around it.
      const stem = note.message.split(' — ')[0]?.slice(0, 40) ?? note.message.slice(0, 40);
      if (!html.includes(stem)) {
        violations.push({ rule: 'datastatus', detail: `advarsel mangler: "${stem}…"` });
      }
    }
  }

  // 4. Noise stays down: nothing suppressed may appear as a card.
  for (const signal of brief.signals.filter((s) => s.tier === 'hidden')) {
    if (html.includes(`data-signal-id="${signal.id}"`)) {
      violations.push({
        rule: 'noise',
        detail: `fællesbesked "${signal.title}" er vist som et punkt`,
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
