/**
 * Systematic "Huskelisten" (widget 0062) — homework reminders.
 *
 * Date-ranged rather than week-based, so it takes `fromDate`/`toDate` and
 * ignores `isoWeek`.
 *
 * Two oddities: the bearer goes in `Aula-Authorization`, not `Authorization`,
 * and `sessionId` is the MitID username — Systematic is the second of the two
 * vendors that wants that rather than the Aula guardian id.
 */

import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import { type IntegrationContext, isoDate, type WeekPlan, type WeekPlanItem } from './types.ts';

const SYSTEMATIC_URL = 'https://systematic-momo.dk/api/aula/reminders/v1';
export const SYSTEMATIC_WIDGET = '0062';

type Reminder = {
  id?: number;
  institutionName?: string;
  dueDate?: string;
  teamId?: number;
  teamName?: string;
  reminderText?: string;
  createdBy?: string;
  subjectName?: string;
  /** Assignment reminders carry this instead of `reminderText`. */
  assignmentText?: string;
  teamNames?: string[];
};

type Person = {
  userName?: string;
  userId?: number;
  teamReminders?: Reminder[];
  courseReminders?: Reminder[];
  assignmentReminders?: Reminder[];
};

export async function getReminders(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string = SYSTEMATIC_WIDGET,
): Promise<WeekPlan> {
  const warnings: string[] = [];
  if (ctx.sessionIdIsFallback) {
    warnings.push(
      'No MitID username on the stored login; Huskelisten may reject the fallback ' +
        'session id. Log in again with `bun run login`.',
    );
  }

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
    return ((await widgetFetch<Person[]>({
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
    })) ?? []);
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
    ...(warnings.length ? { warnings } : {}),
  };
}
