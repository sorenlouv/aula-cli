/**
 * The schedule half of `~/.aula/config.json`.
 *
 * `config.test.ts` next door is about the fleet's *lint* configuration, which
 * is an unrelated file that happens to share a word; this is about the times
 * the overview is generated.
 *
 * The times live in config rather than only in the launchd agent because a
 * plist cannot be asked what it says. The run that the wake-up heartbeat
 * starts has to know which slot the clock is in before it can decide whether
 * it owes anybody a brief, and config is the only surface both the installer
 * and every later process share.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefSlots, ConfigError, readConfig, updateConfig } from './config.ts';
import { DEFAULT_SLOTS } from './slots.ts';

const dirs: string[] = [];
function configPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aula-config-test-'));
  dirs.push(dir);
  return join(dir, 'config.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('briefSchedule', () => {
  test('an unconfigured install runs morning and evening', () => {
    expect(briefSlots(configPath())).toEqual(DEFAULT_SLOTS);
  });

  test('round-trips through the file', () => {
    const path = configPath();
    updateConfig({ briefSchedule: ['06:00', '18:00'] }, path);
    expect(readConfig(path).briefSchedule).toEqual(['06:00', '18:00']);
    expect(briefSlots(path)).toEqual(DEFAULT_SLOTS);
  });

  // Hand-editing this file is supported, so `6:00` has to mean what it looks
  // like — and be stored back in the one spelling, or the same time could sit
  // in the list twice.
  test('a hand-edited time is normalised and sorted', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ briefSchedule: ['18:00', '6:00', '06:00'] }));
    expect(readConfig(path).briefSchedule).toEqual(['06:00', '18:00']);
  });

  test('a time no clock can show names the file to fix', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ briefSchedule: ['06:00', 'morgen'] }));
    expect(() => readConfig(path)).toThrow(ConfigError);
    expect(() => readConfig(path)).toThrow(/briefSchedule/);
  });

  /**
   * `briefSlots` is read by the scheduled run, which has no terminal and no
   * one watching. A corrupt file must not be the reason no brief is generated
   * at all — the default pair is a better answer than a crash.
   */
  test('briefSlots falls back to the default rather than throwing', () => {
    const path = configPath();
    writeFileSync(path, 'not json at all');
    expect(briefSlots(path)).toEqual(DEFAULT_SLOTS);
  });

  /**
   * `aula schedule --remove` clears the times. It must not take the family's
   * calendars or their deploy target with it — two unrelated commands write
   * this file and neither knows what the other stores.
   */
  test('clearing the schedule leaves everything else alone', () => {
    const path = configPath();
    updateConfig(
      {
        briefSchedule: ['06:00', '18:00'],
        calendars: [{ id: 'a@eksempel.dk', name: 'Familie' }],
      },
      path,
    );
    updateConfig({ briefSchedule: undefined }, path);
    const config = readConfig(path);
    expect(config.briefSchedule).toBeUndefined();
    expect(config.calendars).toEqual([{ id: 'a@eksempel.dk', name: 'Familie' }]);
  });
});
