/**
 * Meebook (widget 0004) — weekly plans.
 *
 * Two traps, both of which return something that looks like "no data" rather
 * than an error:
 *
 *  - `childFilter[]` takes the child's *UniLogin* (`Child.userId`, e.g.
 *    `alma0101`), not the numeric institution-profile id. The numeric id
 *    yields HTTP 400 "Fandt et unilogin i child filter med et ugyldigt
 *    format".
 *  - `sessionuuid` is the MitID username. Aula's own guardian id is not
 *    accepted, so a session that never supplied one gets an empty plan.
 *
 * Meebook also requires a one-time interactive SSO: the guardian must open the
 * Meebook widget inside aula.dk once before the API will answer at all.
 */

import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import {
  expectType,
  isArrayOf,
  isOptional,
  isRecord,
  isString,
} from '../validation.ts';
import type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';

const MEEBOOK_URL = 'https://app.meebook.com/aulaapi/relatedweekplan/all';

type MeebookTask = {
  type?: string;
  /** Subject chip. Literally "Ingen fag tilknyttet" when there is none. */
  pill?: string;
  title?: string;
  content?: string;
  editUrl?: string;
};

type MeebookPerson = {
  name?: string;
  weekPlan?: Array<{ date?: string; tasks?: MeebookTask[] }>;
  exceptionMessage?: string;
};

type MeebookDay = NonNullable<MeebookPerson['weekPlan']>[number];

function isMeebookTask(value: unknown): value is MeebookTask {
  return isRecord(value) &&
    isOptional(value.type, isString) &&
    isOptional(value.pill, isString) &&
    isOptional(value.title, isString) &&
    isOptional(value.content, isString) &&
    isOptional(value.editUrl, isString);
}

function isMeebookDay(value: unknown): value is MeebookDay {
  return isRecord(value) &&
    isOptional(value.date, isString) &&
    isOptional(value.tasks, (tasks): tasks is MeebookTask[] => isArrayOf(tasks, isMeebookTask));
}

function isMeebookPerson(value: unknown): value is MeebookPerson {
  return isRecord(value) &&
    isOptional(value.name, isString) &&
    isOptional(value.weekPlan, (days): days is MeebookDay[] => isArrayOf(days, isMeebookDay)) &&
    isOptional(value.exceptionMessage, isString);
}

function decodePeople(value: unknown): MeebookPerson[] {
  return expectType(value, (people): people is MeebookPerson[] =>
    isArrayOf(people, isMeebookPerson), 'a Meebook week plan');
}

const NO_SUBJECT = 'Ingen fag tilknyttet';

export async function getWeekPlan(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const warnings: string[] = [];

  const params = new URLSearchParams({
    currentWeekNumber: ctx.isoWeek,
    userProfile: 'guardian',
  });
  for (const child of ctx.children) {
    if (!child.userId) {
      warnings.push(`${child.name}: no UniLogin on the Aula profile — Meebook cannot look them up.`);
      continue;
    }
    params.append('childFilter[]', child.userId);
  }
  for (const code of ctx.institutionCodes) params.append('institutionFilter[]', code);

  const people = await tokens.withToken(widgetId, async (token) => {
    return await widgetFetch({
      url: `${MEEBOOK_URL}?${params}`,
      widgetId,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        sessionuuid: ctx.sessionId,
        'x-version': '1.0',
        origin: 'https://www.aula.dk',
        referer: 'https://www.aula.dk/',
      },
    }, decodePeople);
  });

  const items: WeekPlanItem[] = [];
  for (const person of Array.isArray(people) ? people : []) {
    // Meebook reports the "you must log in via the browser once" prerequisite
    // per person, with HTTP 200. Surfacing it verbatim is the only useful
    // thing to do — it is an instruction for the user, not a bug.
    if (person.exceptionMessage) {
      warnings.push(`${person.name ?? 'unknown child'}: ${person.exceptionMessage}`);
      continue;
    }
    for (const day of person.weekPlan ?? []) {
      for (const task of day.tasks ?? []) {
        items.push({
          kind: task.type ?? 'task',
          ...(person.name ? { childName: person.name } : {}),
          ...(day.date ? { date: day.date } : {}),
          ...(task.pill && task.pill !== NO_SUBJECT ? { subject: task.pill } : {}),
          ...(task.title ? { title: task.title } : {}),
          ...(task.content ? { content: task.content } : {}),
          ...(task.editUrl ? { url: task.editUrl } : {}),
        });
      }
    }
  }

  return {
    provider: 'meebook',
    capability: 'ugeplan',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
    ...(warnings.length ? { warnings } : {}),
  };
}
