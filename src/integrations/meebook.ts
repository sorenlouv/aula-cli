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
import type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';

const MEEBOOK_URL = 'https://app.meebook.com/aulaapi/relatedweekplan/all';
export const MEEBOOK_WIDGET = '0004';

type MeebookTask = {
  id?: number;
  type?: string;
  author?: string;
  group?: string;
  /** Subject chip. Literally "Ingen fag tilknyttet" when there is none. */
  pill?: string;
  title?: string;
  content?: string;
  editUrl?: string;
};

type MeebookPerson = {
  id?: number;
  name?: string;
  unilogin?: string;
  weekPlan?: Array<{ date?: string; tasks?: MeebookTask[] }>;
  exceptionMessage?: string;
};

const NO_SUBJECT = 'Ingen fag tilknyttet';

export async function getWeekPlan(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string = MEEBOOK_WIDGET,
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

  if (ctx.sessionIdIsFallback) {
    warnings.push(
      'No MitID username on the stored login; Meebook may reject the fallback ' +
        'session id. Log in again with `bun run login`.',
    );
  }

  const people = await tokens.withToken(widgetId, async (token) => {
    return ((await widgetFetch<MeebookPerson[]>({
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
    })) ?? []);
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
