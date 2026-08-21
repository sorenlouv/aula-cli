/**
 * Systematic "Huskelisten" (widget 0062) — homework reminders.
 *
 * Date-ranged rather than week-based, so it takes `fromDate`/`toDate` and
 * ignores `isoWeek`.
 *
 * Two oddities: the bearer goes in `Aula-Authorization`, not `Authorization`,
 * and `sessionId` is the MitID username — one of the three consumers of it,
 * with Meebook and SkolePortal's ugeplan — rather than the Aula guardian id.
 */

import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import {
  expectType,
  isArrayOf,
  isOptional,
  isRecord,
  isString,
} from '../validation.ts';
import { type IntegrationContext, isoDate, type WeekPlan, type WeekPlanItem } from './types.ts';

const SYSTEMATIC_URL = 'https://systematic-momo.dk/api/aula/reminders/v1';

type Reminder = {
  dueDate?: string;
  teamName?: string;
  reminderText?: string;
  subjectName?: string;
  /** Assignment reminders carry this instead of `reminderText`. */
  assignmentText?: string;
  teamNames?: string[];
};

type Person = {
  userName?: string;
  teamReminders?: Reminder[];
  courseReminders?: Reminder[];
  assignmentReminders?: Reminder[];
};

function isReminder(value: unknown): value is Reminder {
  return isRecord(value) &&
    isOptional(value.dueDate, isString) &&
    isOptional(value.teamName, isString) &&
    isOptional(value.reminderText, isString) &&
    isOptional(value.subjectName, isString) &&
    isOptional(value.assignmentText, isString) &&
    isOptional(value.teamNames, (names): names is string[] => isArrayOf(names, isString));
}

function isPerson(value: unknown): value is Person {
  const reminders = (candidate: unknown): candidate is Reminder[] => isArrayOf(candidate, isReminder);
  return isRecord(value) &&
    isOptional(value.userName, isString) &&
    isOptional(value.teamReminders, reminders) &&
    isOptional(value.courseReminders, reminders) &&
    isOptional(value.assignmentReminders, reminders);
}

function decodePeople(value: unknown): Person[] {
  return expectType(value, (people): people is Person[] => isArrayOf(people, isPerson), 'a reminder list');
}

export async function getReminders(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const params = new URLSearchParams({
    children: ctx.children.map((c) => c.id).join(','),
    institutions: ctx.institutionCodes.join(','),
    from: ctx.fromDate ?? isoDate(new Date()),
    dueNoLaterThan: ctx.toDate ?? isoDate(new Date(Date.now() + 30 * 86_400_000)),
    widgetVersion: '1.10',
    userProfile: 'guardian',
    sessionId: ctx.sessionId,
  });

  const people = await tokens.withToken(widgetId, async (token) => {
    return await widgetFetch({
      url: `${SYSTEMATIC_URL}?${params}`,
      widgetId,
      headers: {
        'aula-authorization': `Bearer ${token}`,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9,da;q=0.8',
        origin: 'https://www.aula.dk',
        referer: 'https://www.aula.dk/',
        zone: 'Europe/Copenhagen',
      },
    }, decodePeople);
  });

  const items: WeekPlanItem[] = [];
  for (const person of Array.isArray(people) ? people : []) {
    const buckets: Array<[string, Reminder[] | undefined]> = [
      ['team', person.teamReminders],
      ['course', person.courseReminders],
      ['assignment', person.assignmentReminders],
    ];
    for (const [kind, reminders] of buckets) {
      for (const reminder of reminders ?? []) {
        const team = reminder.teamName ?? reminder.teamNames?.join(', ');
        items.push({
          kind: `huskelisten:${kind}`,
          ...(person.userName ? { childName: person.userName } : {}),
          ...(reminder.dueDate ? { date: reminder.dueDate } : {}),
          ...(reminder.subjectName ? { subject: reminder.subjectName } : {}),
          ...(team ? { title: team } : {}),
          ...(reminder.reminderText || reminder.assignmentText
            ? { content: reminder.reminderText ?? reminder.assignmentText }
            : {}),
        });
      }
    }
  }

  return {
    provider: 'systematic',
    capability: 'huskelisten',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
  };
}
