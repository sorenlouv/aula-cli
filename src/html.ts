/**
 * Aula returns message and post bodies as HTML fragments. Claude reads these
 * far more cheaply as plain text, and the markup carries no meaning worth
 * keeping, so we flatten it.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aelig: 'æ',
  oslash: 'ø',
  aring: 'å',
  AElig: 'Æ',
  Oslash: 'Ø',
  Aring: 'Å',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  euro: '€',
  copy: '©',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let text = html;

  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Aula's editor pretty-prints its output, so block tags are separated by
  // literal newlines that carry no meaning. Left in, every `</div>\n<div>` pair
  // would turn into a blank line. Real blank lines are written as `<div> </div>`
  // or `<br><br>`, both of which survive this.
  text = text.replace(/>[ \t]*\r?\n[ \t]*</g, '><');

  // Keep link targets — teachers often put the real information behind a link.
  text = text.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const clean = stripTags(label).trim();
      if (!clean) return href;
      return href.includes(clean) ? clean : `${clean} (${href})`;
    },
  );

  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Paragraphs and headings read as separated blocks in Aula, so they keep a
  // blank line; plain divs are just line breaks.
  text = text.replace(/<\/(p|h[1-6]|blockquote)>/gi, '\n\n');
  // `</li>` is deliberately absent: the opening `<li>` already starts the line.
  text = text.replace(/<\/(div|tr|ul|ol|table)>/gi, '\n');
  text = text.replace(/<\/t[dh]>/gi, '\t');

  text = stripTags(text);
  text = decodeEntities(text);

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ /g, ' ')
    .trim();
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/** Single-line preview for list output. */
export function preview(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
