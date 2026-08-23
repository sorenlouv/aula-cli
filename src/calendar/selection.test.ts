import { describe, expect, test } from 'bun:test';
import {
  calendarChoices,
  resolveCalendarSelection,
  resolveConfiguredSelection,
} from './selection.ts';

describe('calendar selection', () => {
  test('selected calendars stay first and use their current names', () => {
    const choices = calendarChoices(
      [{ id: 'family', name: 'Old name' }],
      [
        { id: 'work', summary: 'Work' },
        { id: 'family', summary: 'Family' },
      ],
    );
    expect(choices).toEqual([
      { id: 'family', name: 'Family', selected: true },
      { id: 'work', name: 'Work', selected: false },
    ]);
  });

  test('exact names survive a reordered connector listing', () => {
    const first = calendarChoices([], [
      { id: 'family', summary: 'Family' },
      { id: 'work', summary: 'Work' },
    ]);
    const second = calendarChoices([], [
      { id: 'work', summary: 'Work' },
      { id: 'family', summary: 'Family' },
    ]);
    expect(resolveCalendarSelection(first, ['Family']).map((calendar) => calendar.id)).toEqual([
      'family',
    ]);
    expect(resolveCalendarSelection(second, ['Family']).map((calendar) => calendar.id)).toEqual([
      'family',
    ]);
  });

  test('duplicate names are refused instead of guessed', () => {
    const choices = calendarChoices([], [
      { id: 'a@example.com', summary: 'Family' },
      { id: 'b@example.com', summary: 'Family' },
    ]);
    expect(() => resolveCalendarSelection(choices, ['Family'])).toThrow(
      'Use one of these exact ids: a@example.com, b@example.com',
    );
    expect(resolveCalendarSelection(choices, ['b@example.com'])[0]?.id).toBe('b@example.com');
  });

  test('narrowing by saved ids needs no connector listing', () => {
    const configured = [
      { id: 'family', name: 'Family' },
      { id: 'work', name: 'Work' },
    ];
    expect(resolveConfiguredSelection(configured, ['work'])?.map((calendar) => calendar.id)).toEqual([
      'work',
    ]);
    // A saved name may collide with an unselected calendar we cannot see
    // offline, so resolving it without the live list would be a guess.
    expect(resolveConfiguredSelection(configured, ['Work'])).toBeNull();
    expect(resolveConfiguredSelection(configured, ['Something new'])).toBeNull();
  });
});
