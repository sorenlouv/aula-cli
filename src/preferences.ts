/**
 * What this family wants out of the overview: `~/.aula/preferences.md`.
 *
 * One plain sentence per line, written by the user — *"beskeder fra John
 * (Hjaltes far) er altid vigtige"*, *"jeg er ligeglad med billeder"*. The file
 * is the whole feature: `aula remember` appends to it, the brief's prompts
 * carry it, and the model answers with a verdict per source that `rank.ts`
 * acts on — see `Relevance` in `brief/types.ts`. Nothing else reads the prose.
 *
 * Three choices worth keeping:
 *
 * - **Markdown, not JSON.** Nobody should have to learn a schema to say what
 *   matters to them, and a preference that must be structured before it can be
 *   recorded is a preference most people will not bother recording. The model
 *   is the consumer here, and prose is its native format.
 * - **The CLI owns the file, not the agent.** Claude records a preference by
 *   running `aula remember`, never by editing this file: the format stays
 *   stable, duplicates are caught, and `aula preferences` / `aula forget` give
 *   the user a way to see and undo what was written on their behalf. A file an
 *   agent hand-edits is a file nobody can predict the shape of.
 * - **`~/.aula`, `0600`.** These lines name other people's children and other
 *   people's parents. They belong outside the repository, with the tokens and
 *   the cache — see `data/README.md`. `$AULA_DIR` moves them, like every other
 *   stored path, which is what keeps the tests off the real one.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AULA_DIR } from './auth.ts';
import { UsageError } from './errors.ts';

export const PREFERENCES_PATH = join(AULA_DIR, 'preferences.md');

/**
 * A ceiling, not a target. Every line goes into every brief prompt, so an
 * unbounded list quietly turns into an unbounded instruction block — and a
 * hundred half-remembered wishes is not a preference list, it is a mess. The
 * limit refuses loudly rather than dropping the tail silently.
 */
export const MAX_PREFERENCES = 30;

/**
 * What aula-cli believes about a family's week, before it is told otherwise.
 *
 * These used to sit in the extraction prompt, where nobody could reach them:
 * a family who *did* want the municipal course offers, or who reads every
 * school-wide post, had no way to say so. They are opinions, not mechanism, so
 * they belong on the same list as the user's own — seeded on first use,
 * numbered like everything else, and dropped with `aula forget <nr>`.
 *
 * What stayed behind in the prompt is the part that is not an opinion: quote
 * a source verbatim, never invent a date, answer in the given JSON shape. No
 * edit to this file can loosen those.
 *
 * Phrased as the user would phrase it, because that is what the file is: from
 * the moment it exists, every line in it is theirs — including the municipal
 * one, which is the only line that asks for something to be *hidden* rather
 * than sorted. Nothing in the code matches these by wording: reword one and
 * the model reads the new wording, drop it and the model stops applying it.
 */
export const DEFAULT_PREFERENCES: readonly string[] = [
  'Det vigtigste for mig er ting der skal medbringes, afleveres, tilmeldes eller besvares — og nye faste aftaler i ugen.',
  'Beskeder og opslag fra mit barns egen klasse eller stue er næsten altid relevante.',
  'En besked til hele skolen tæller kun, når den handler om mit barns dag: skolefoto, som hele klassen skal med til, er relevant — et forældrekursus er ikke.',
  'Tilbud vi selv kan vælge til — kurser, forløb, netværk, temaaftener, foredrag — er mindre relevante.',
  'Fællesbeskeder til alle forældre i kommunen er aldrig relevante for os.',
];

/**
 * Every line is a preference. Nothing else is in this file.
 *
 * It used to open with a paragraph explaining itself, and that paragraph was a
 * trap: it invited hand-editing while the parser accepted bullets only, so a
 * line typed without a dash was dropped in silence — and the explanation came
 * back by itself on the next write, because every write reproduced it. The file
 * holds the list and nothing else now; the explaining is done by
 * `aula preferences`, where it cannot be mistaken for content.
 *
 * So the dash is decoration, stripped if present and not required. Blank lines
 * and Markdown headings are the only things skipped, because neither is
 * something a person types meaning "remember this".
 */
export function parsePreferences(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Missing, empty or unreadable all mean "no preferences" — never an error. A
 * broken file must not be able to stop the morning brief.
 */
export function readPreferences(path = PREFERENCES_PATH): string[] {
  try {
    return parsePreferences(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The list as everything else should see it: seeded with the defaults the first
 * time, and from then on whatever the user has made of it.
 *
 * Seeding on first *use* rather than on install is what makes deleting a
 * default stick — the file exists from then on, so nothing writes it back. A
 * user who empties the list entirely gets an empty list, which is a legitimate
 * thing to want and the point of the exercise.
 */
export function loadPreferences(path = PREFERENCES_PATH): string[] {
  if (!existsSync(path)) writePreferences([...DEFAULT_PREFERENCES], path);
  return readPreferences(path);
}

export function writePreferences(lines: string[], path = PREFERENCES_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Written as a Markdown list so the file reads well anywhere, parsed as if
  // the dashes were not there — see `parsePreferences`.
  const body = lines.length ? `${lines.map((line) => `- ${line}`).join('\n')}\n` : '';
  writeFileSync(path, body, { mode: 0o600 });
  // `mode` on write only applies when the file is created, and this one may
  // predate the rule — or have been created by hand.
  chmodSync(path, 0o600);
}

/** A preference is one line. Pasted newlines and stray bullets are the user's, not ours. */
function normalise(text: string): string {
  return text
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type RememberResult = {
  /** False when this was already on the list — saying so beats writing it twice. */
  added: boolean;
  text: string;
  preferences: string[];
};

export function addPreference(text: string, path = PREFERENCES_PATH): RememberResult {
  const line = normalise(text);
  if (!line) {
    throw new UsageError(
      'Usage: aula remember "det du vil huskes på" — fx "beskeder fra John (Hjaltes far) er altid vigtige".',
    );
  }
  const preferences = loadPreferences(path);
  const already = preferences.find((existing) => existing.toLowerCase() === line.toLowerCase());
  if (already) return { added: false, text: already, preferences };
  if (preferences.length >= MAX_PREFERENCES) {
    throw new UsageError(
      `There are already ${preferences.length} preferences, which is the limit.\n` +
        'Run `aula preferences` to see them and `aula forget <nr>` to drop one first.',
    );
  }
  const next = [...preferences, line];
  writePreferences(next, path);
  return { added: true, text: line, preferences: next };
}

/**
 * Back to factory settings.
 *
 * Returns what it threw away as well as what it restored: a reset drops lines
 * the user wrote themselves, and a destructive command that cannot say what it
 * destroyed is one nobody should run. There is no prompt — this has to work
 * from a script and from Claude — so printing the casualties is the whole
 * safety net.
 */
export function resetPreferences(path = PREFERENCES_PATH): {
  dropped: string[];
  preferences: string[];
} {
  const defaults = new Set<string>(DEFAULT_PREFERENCES);
  const dropped = readPreferences(path).filter((line) => !defaults.has(line));
  const preferences = [...DEFAULT_PREFERENCES];
  writePreferences(preferences, path);
  return { dropped, preferences };
}

/** `index` is 1-based: the number `aula preferences` printed next to the line. */
export function removePreference(
  index: number,
  path = PREFERENCES_PATH,
): { removed: string; preferences: string[] } {
  const preferences = loadPreferences(path);
  const removed = preferences[index - 1];
  if (removed === undefined) {
    throw new UsageError(
      preferences.length === 0
        ? 'Nothing is remembered yet — `aula remember "…"` records the first one.'
        : `There is no preference ${index}. Run \`aula preferences\` to see the numbers (1–${preferences.length}).`,
    );
  }
  const next = preferences.filter((_, i) => i !== index - 1);
  writePreferences(next, path);
  return { removed, preferences: next };
}
