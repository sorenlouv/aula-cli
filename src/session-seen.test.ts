/**
 * `status` answers "does Aula accept this login?" from this note, so the note
 * has to survive a round trip exactly and refuse to be read when it does not.
 */

import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AULA_DIR } from './auth.ts';
import { forgetSessionSeen, readSessionSeen, recordSessionSeen } from './session-seen.ts';

describe('session-seen', () => {
  test('round-trips an observation with its time', () => {
    forgetSessionSeen();
    expect(readSessionSeen()).toBeNull();

    recordSessionSeen({ state: 'accepted', steppedUp: true }, new Date('2026-09-18T06:00:00Z'));
    expect(readSessionSeen()).toEqual({
      state: 'accepted',
      checkedAt: '2026-09-18T06:00:00.000Z',
      steppedUp: true,
    });

    recordSessionSeen({ state: 'rejected', steppedUp: null });
    expect(readSessionSeen()?.state).toBe('rejected');

    forgetSessionSeen();
    expect(readSessionSeen()).toBeNull();
  });

  // A note that cannot be read is no note: better `null` than a state invented
  // from half a file.
  test('a malformed note reads as none', () => {
    const path = join(AULA_DIR, 'session-seen.json');
    writeFileSync(path, '{"state":"maybe","checkedAt":1}');
    expect(readSessionSeen()).toBeNull();
    writeFileSync(path, 'not json');
    expect(readSessionSeen()).toBeNull();
    forgetSessionSeen();
  });
});
