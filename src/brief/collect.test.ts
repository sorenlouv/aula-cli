import { expect, test } from 'bun:test';
import type { WeekPlan } from '../integrations/types.ts';
import { sourcesFromPlans } from './collect.ts';

test('weekly-plan capabilities keep distinct keys and every task field', () => {
  const plans: WeekPlan[] = [
    {
      provider: 'minuddannelse',
      capability: 'weekly-letter',
      widgetId: '0029',
      isoWeek: '2026-W33',
      items: [{ title: 'Ugebrev', content: 'Velkommen tilbage.', kind: 'weekly-letter' }],
    },
    {
      provider: 'minuddannelse',
      capability: 'tasks',
      widgetId: '0030',
      isoWeek: '2026-W33',
      items: [
        {
          subject: '5A',
          title: 'Aflever novelle',
          content: 'Noveller',
          kind: 'task',
        },
      ],
    },
  ];

  const sources = sourcesFromPlans(plans);
  const task = sources[1];

  expect(new Set(sources.map((source) => source.key)).size).toBe(2);
  expect(sources[0]?.key).toContain(':weekly-letter:');
  expect(task?.key).toContain(':tasks:');
  expect(task?.title).toBe('Aflever novelle');
  expect(task?.text).toContain('5A');
  expect(task?.text).toContain('Aflever novelle');
  expect(task?.text).toContain('Noveller');
  expect(task?.text).toContain('Opgave');
});

test('dated plan keys survive reordering across days', () => {
  const items = [
    { date: '2026-08-24', title: 'Mandag' },
    { date: '2026-08-25', title: 'Tirsdag' },
  ];
  const plan: WeekPlan = {
    provider: 'easyiq',
    capability: 'weekly-plan',
    widgetId: '0001',
    isoWeek: '2026-W35',
    items,
  };
  const keys = (entries: typeof items) =>
    new Map(
      sourcesFromPlans([{ ...plan, items: entries }]).map((source) => [source.title, source.key]),
    );

  expect(keys([...items].reverse())).toEqual(keys(items));
});
