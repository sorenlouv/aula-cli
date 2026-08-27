/**
 * `doctor`'s own failure modes.
 *
 * The command exists to report truthfully on a broken session, which makes the
 * ways it can fail to report at all the thing worth pinning. It talks to Aula
 * through the client, so the tests hand it a stub and read the JSON report.
 */

import { describe, expect, test } from 'bun:test';
import type { AulaClient } from './client.ts';
import { claudeCliCheck, runDoctor } from './doctor.ts';

/** Just enough client for the two identity checks and the report header. */
function stubClient(over: Partial<Record<'getProfiles' | 'getProfileContext', () => unknown>>) {
  return {
    apiVersion: 23,
    authKind: 'token',
    mitidUsername: null,
    getProfiles: async () => [],
    getProfileContext: async () => ({ userId: 'vald42a1', pageConfiguration: {} }),
    ...over,
  } as unknown as AulaClient;
}

/** Runs doctor with stdout captured, returning the parsed report. */
async function report(client: AulaClient) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    const code = await runDoctor(client, { asText: false, days: 7 });
    return { code, report: JSON.parse(lines.join('\n')) };
  } finally {
    console.log = original;
  }
}

describe('runDoctor', () => {
  test('reports rather than crashing when Aula returns no profiles', async () => {
    // An empty list is truthy, so it used to sail past the `!profiles` guard
    // into buildFamily, which threw on profiles[0] — doctor died with a stack
    // trace and printed nothing, losing the warning it had just recorded about
    // exactly this state.
    const { code, report: got } = await report(stubClient({ getProfiles: async () => [] }));

    const profiles = got.checks.find(
      (c: { name: string }) => c.name === 'profiles.getProfilesByLogin',
    );
    expect(profiles.status).toBe('warn');
    expect(profiles.note).toContain('no profiles');
    // A warning is not a failure: the run still reports ok.
    expect(code).toBe(0);
  });

  test('a thrown identity check still produces a report', async () => {
    const { code, report: got } = await report(
      stubClient({
        getProfiles: async () => {
          throw new Error('401 Unauthorized');
        },
      }),
    );

    const profiles = got.checks.find(
      (c: { name: string }) => c.name === 'profiles.getProfilesByLogin',
    );
    expect(profiles.status).toBe('fail');
    expect(got.ok).toBe(false);
    expect(code).toBe(1);
  });
});

describe('claudeCliCheck', () => {
  test('passes with the resolved path when claude is on PATH', () => {
    const outcome = claudeCliCheck(() => '/Users/x/.local/bin/claude');

    expect(outcome.status).toBeUndefined(); // defaults to ok
    expect(outcome.detail).toBe('/Users/x/.local/bin/claude');
    expect(outcome.note).toBeUndefined();
  });

  test('warns — not fails — when claude is missing, and says how to install it', () => {
    // A warn keeps `report.ok` true: every Aula read still works without
    // `claude`, and only the overview breaks. Failing the run would overstate
    // it, but staying silent is what let a doomed schedule get installed.
    const outcome = claudeCliCheck(() => null);

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toBe('not on PATH');
    expect(outcome.note).toContain('claude.ai/install.sh');
  });

  test('a missing claude does not fail the run', async () => {
    const { code, report: got } = await report(stubClient({}));
    const claude = got.checks.find((c: { name: string }) => c.name === 'claude CLI');

    // Whichever way this machine answers, the check is present and never the
    // reason doctor exits non-zero.
    expect(claude).toBeDefined();
    expect(claude.status === 'ok' || claude.status === 'warn').toBe(true);
    expect(code).toBe(0);
  });
});
