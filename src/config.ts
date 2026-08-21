/**
 * Standing preferences: `~/.aula/config.json`.
 *
 * Everything else under `~/.aula` is state the tool produces — tokens, cache,
 * generated pages. This file is the one place for choices the *user* makes and
 * expects to stick, starting with the URL of the hosted copy of the brief.
 *
 * It lives under `$AULA_DIR` like every other stored path, which is what keeps
 * it out of the repository: a clone of this project has no `~/.aula`, so it
 * inherits no preferences and — the case that matters — no deploy target.
 * Each installation configures its own. The file is written `0600` because
 * the URL of a private artifact is a secret in the practical sense: anyone who
 * has it can read the page once it has been shared.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AULA_DIR } from './auth.ts';
import { isRecord } from './validation.ts';

export const CONFIG_PATH = join(AULA_DIR, 'config.json');

export type AulaConfig = {
  /** Where `aula new` redeploys the brief. Absent means: keep it local. */
  artifactUrl?: string;
};

/** Missing or unreadable both mean "nothing configured"; never an error. */
export function readConfig(path = CONFIG_PATH): AulaConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const url = isRecord(parsed) && typeof parsed.artifactUrl === 'string' ? parsed.artifactUrl.trim() : '';
    return url ? { artifactUrl: url } : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: AulaConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
