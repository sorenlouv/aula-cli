/**
 * Standing preferences: `~/.aula/config.json`.
 *
 * Everything else under `~/.aula` is state the tool produces — tokens, cache,
 * generated pages. This file is the one place for choices the *user* makes and
 * expects to stick: the URL of the hosted copy of the brief, which of their own
 * calendars the overview may read, and the times of day it is generated.
 *
 * It lives under `$AULA_DIR` like every other stored path, which is what keeps
 * it out of the repository: a clone of this project has no `~/.aula`, so it
 * inherits no preferences and — the case that matters — no deploy target.
 * Each installation configures its own. The file is written `0600` because
 * the URL of a private artifact is a secret in the practical sense: anyone who
 * has it can read the page once it has been shared.
 *
 * **Reads keep what they do not understand, and writes merge.** This file now
 * holds two unrelated things written by two unrelated commands, and the earlier
 * version rebuilt the whole object from the one field it knew about — so
 * `aula publish` would have silently deleted the family's calendars, which is
 * user data lost in a command that has nothing to do with calendars. Anything a
 * future version adds is carried through untouched for the same reason.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AULA_DIR } from './auth.ts';
import { isArtifactUrl } from './llm/requests/artifact-deploy.ts';
import { clock, DEFAULT_SLOTS, parseSlots, type Slot, SlotFormatError } from './slots.ts';
import { isRecord } from './validation.ts';

export const CONFIG_PATH = join(AULA_DIR, 'config.json');

/** One calendar the overview may read. See `src/calendar/types.ts`. */
export type ConfiguredCalendar = {
  id: string;
  name: string;
};

export type AulaConfig = {
  /** Where `aula new` redeploys the brief. Absent means: keep it local. */
  artifactUrl?: string;
  /** The family's own calendars. Absent or empty means: read none. */
  calendars?: ConfiguredCalendar[];
  /**
   * When the overview is generated, as `HH:MM` strings. Absent means the
   * default morning-and-evening pair.
   *
   * Written by `aula schedule`, and read by everything that has to agree with
   * it: the scheduler's own wake-up logic and `new --catch-up`. The times are
   * baked into a launchd agent as well, but the agent cannot be asked what it
   * says, and a run started by the wake-up heartbeat has to know which slot it
   * is in — so the answer lives where every process can read it.
   */
  briefSchedule?: string[];
  /** Anything a newer version wrote. Never inspected, never dropped. */
  [key: string]: unknown;
};

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function configError(path: string, detail: string): ConfigError {
  return new ConfigError(`Konfigurationen i ${path} er ugyldig: ${detail}. Ret eller fjern filen.`);
}

/** A missing file is unconfigured; a present but malformed file is actionable. */
export function readConfig(path = CONFIG_PATH): AulaConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return {};
    throw configError(path, err instanceof Error ? err.message : String(err));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw configError(path, err instanceof Error ? err.message : 'JSON kunne ikke læses');
  }
  if (!isRecord(parsed)) throw configError(path, 'topniveauet skal være et objekt');

  // Unknown keys ride along untouched; the known ones are validated, because a
  // hand-edited file is a supported way to configure this.
  const config: AulaConfig = { ...parsed };

  if (parsed.artifactUrl !== undefined && typeof parsed.artifactUrl !== 'string') {
    throw configError(path, 'artifactUrl skal være tekst');
  }
  const url = typeof parsed.artifactUrl === 'string' ? parsed.artifactUrl.trim() : '';
  if (url && !isArtifactUrl(url)) throw configError(path, 'artifactUrl har et ugyldigt format');
  if (url) config.artifactUrl = url;
  else delete config.artifactUrl;

  const calendars = readCalendars(parsed.calendars, path);
  if (calendars.length > 0) config.calendars = calendars;
  else delete config.calendars;

  const schedule = readSchedule(parsed.briefSchedule, path);
  if (schedule.length > 0) config.briefSchedule = schedule;
  else delete config.briefSchedule;

  return config;
}

function readSchedule(value: unknown, path = CONFIG_PATH): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw configError(path, 'briefSchedule skal være en liste');
  try {
    // Round-tripped through the parser rather than kept verbatim, so a
    // hand-edited `6:00` is stored back as `06:00` and the two spellings of
    // one time cannot both sit in the file.
    return parseSlots(value.join(',')).map(clock);
  } catch (err) {
    if (err instanceof SlotFormatError) throw configError(path, `briefSchedule: ${err.message}`);
    throw err;
  }
}

/**
 * The times the overview is generated. Never throws: a caller that already had
 * to read the config would have hit {@link readConfig}'s error first, and a
 * caller reaching for the schedule alone is better served by the default than
 * by a crash.
 */
export function briefSlots(path = CONFIG_PATH): Slot[] {
  try {
    return parseSlots(readConfig(path).briefSchedule?.join(','));
  } catch {
    return DEFAULT_SLOTS;
  }
}

function readCalendars(value: unknown, path = CONFIG_PATH): ConfiguredCalendar[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw configError(path, 'calendars skal være en liste');
  const seen = new Set<string>();
  const calendars: ConfiguredCalendar[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) throw configError(path, `calendars[${index}] skal være et objekt`);
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) throw configError(path, `calendars[${index}].id mangler`);
    if (seen.has(id)) throw configError(path, `kalender-id ${id} står flere gange`);
    seen.add(id);
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw configError(path, `calendars[${index}].name mangler`);
    }
    const name = entry.name.trim();
    calendars.push({ id, name });
  }
  return calendars;
}

/**
 * Merge `changes` onto what is already on disk.
 *
 * A field set to `undefined` is removed; a field left out is kept. Two
 * commands write this file and neither knows what the other stores, so
 * whole-object writes are not offered at all.
 *
 * Typed as a loose record rather than a partial `AulaConfig` on purpose:
 * `exactOptionalPropertyTypes` makes an optional field and an explicitly
 * `undefined` one different types, and "set this to undefined to remove it" is
 * exactly the second one.
 */
export function updateConfig(changes: Record<string, unknown>, path = CONFIG_PATH): AulaConfig {
  const merged: AulaConfig = { ...readConfig(path) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  writeConfig(merged, path);
  return merged;
}

/** Replaces the file. Prefer {@link updateConfig} unless you mean to drop keys. */
export function writeConfig(config: AulaConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
