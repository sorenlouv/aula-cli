/**
 * MinUddannelse — two products, two widgets, one API shape:
 *
 *   0029  ugebrev    — the weekly letter home
 *   0030  opgaveliste — homework, with 0023 as an older id for the same thing
 *
 * Both take `Authorization: Bearer <widget token>` and identify the family
 * entirely through the query string. `sessionUUID` is the Aula guardian id,
 * not the MitID username that Meebook, Systematic and SkolePortal's Ugeplan widget
 * key on.
 */

import { htmlToText } from '../html.ts';
import { expectOptionalType, isArrayOf, isOptional, isRecord, isString } from '../validation.ts';
import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';

const TASKS_URL = 'https://api.minuddannelse.net/aula/opgaveliste';
const WEEKLY_LETTER_URL = 'https://api.minuddannelse.net/aula/ugebrev';

/**
 * MinUddannelse's `HoldDto` (a class/team) and `ForloebDto` (a course). Both
 * carry the name as `navn` — verified against the vendor's own published
 * schema at `api.minuddannelse.net/csv/metadata?op=OpgavelisteRequest`, which
 * lists `HoldDto` as `Id`, `Navn`, `FagId`, `FagNavn`.
 */
type MuTeam = { navn?: string | null };
type MuCourse = { navn?: string | null };

type MuTask = {
  /** The child the task belongs to — MinUddannelse calls this "kuvertnavn". */
  kuvertnavn?: string | null;
  title?: string | null;
  /** Danish weekday label. */
  ugedag?: string | null;
  opgaveType?: string | null;
  hold?: MuTeam[] | null;
  forloeb?: MuCourse | null;
};

type MuLetter = { indhold?: string | null };
type MuInstitution = { ugebreve?: MuLetter[] | null };
type MuPerson = { navn?: string | null; institutioner?: MuInstitution[] | null };

type MuWeeklyLetterResponse = { personer?: MuPerson[] | null };

type MuTasksResponse = { opgaver?: MuTask[] | null };

function isTeam(value: unknown): value is MuTeam {
  return isRecord(value) && isOptional(value.navn, isString);
}

function isMuTask(value: unknown): value is MuTask {
  return (
    isRecord(value) &&
    isOptional(value.kuvertnavn, isString) &&
    isOptional(value.title, isString) &&
    isOptional(value.ugedag, isString) &&
    isOptional(value.opgaveType, isString) &&
    isOptional(value.hold, (teams): teams is MuTeam[] => isArrayOf(teams, isTeam)) &&
    isOptional(
      value.forloeb,
      (course): course is MuCourse => isRecord(course) && isOptional(course.navn, isString),
    )
  );
}

function isMuTasksResponse(value: unknown): value is MuTasksResponse {
  return (
    isRecord(value) &&
    isOptional(value.opgaver, (tasks): tasks is MuTask[] => isArrayOf(tasks, isMuTask))
  );
}

function isMuWeeklyLetterResponse(value: unknown): value is MuWeeklyLetterResponse {
  const isLetter = (candidate: unknown): candidate is MuLetter =>
    isRecord(candidate) && isOptional(candidate.indhold, isString);
  const isInstitution = (candidate: unknown): candidate is MuInstitution =>
    isRecord(candidate) &&
    isOptional(candidate.ugebreve, (letters): letters is MuLetter[] =>
      isArrayOf(letters, isLetter),
    );
  const isPerson = (candidate: unknown): candidate is MuPerson =>
    isRecord(candidate) &&
    isOptional(candidate.navn, isString) &&
    isOptional(candidate.institutioner, (institutions): institutions is MuInstitution[] =>
      isArrayOf(institutions, isInstitution),
    );
  return (
    isRecord(value) &&
    isOptional(value.personer, (people): people is MuPerson[] => isArrayOf(people, isPerson))
  );
}

async function fetchMu<T>(
  url: string,
  ctx: IntegrationContext,
  widgetId: string,
  tokens: WidgetTokens,
  decode: (value: unknown) => T,
): Promise<T> {
  return tokens.withToken(widgetId, async (token) => {
    const params = new URLSearchParams({
      assuranceLevel: '2',
      // Comma-separated, and the numeric institution-profile ids — unlike
      // Meebook, which wants the opaque per-child userId here.
      childFilter: ctx.children.map((c) => c.id).join(','),
      currentWeekNumber: ctx.isoWeek,
      isMobileApp: 'false',
      placement: 'narrow',
      sessionUUID: ctx.guardianId,
      userProfile: 'guardian',
    });
    return widgetFetch(
      {
        url: `${url}?${params.toString()}`,
        widgetId,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      },
      decode,
    );
  });
}

export async function getTasks(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const data = await fetchMu(TASKS_URL, ctx, widgetId, tokens, (value) =>
    expectOptionalType(value, isMuTasksResponse, 'a MinUddannelse assignment response', {}),
  );
  const items: WeekPlanItem[] = [];
  for (const task of data?.opgaver ?? []) {
    const subjects = (task.hold ?? []).map((team) => team.navn).filter(Boolean);
    items.push({
      kind: task.opgaveType ?? 'task',
      ...(task.kuvertnavn ? { childName: task.kuvertnavn } : {}),
      ...(task.ugedag ? { date: task.ugedag } : {}),
      ...(subjects.length ? { subject: subjects.join(', ') } : {}),
      ...(task.title ? { title: task.title } : {}),
      ...(task.forloeb?.navn ? { content: task.forloeb.navn } : {}),
    });
  }
  return {
    provider: 'minuddannelse',
    capability: 'tasks',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
  };
}

export async function getWeeklyLetter(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const data = await fetchMu(WEEKLY_LETTER_URL, ctx, widgetId, tokens, (value) =>
    expectOptionalType(
      value,
      isMuWeeklyLetterResponse,
      'a MinUddannelse weekly letter response',
      {},
    ),
  );
  const items: WeekPlanItem[] = [];
  for (const person of data?.personer ?? []) {
    for (const institution of person.institutioner ?? []) {
      for (const letter of institution.ugebreve ?? []) {
        if (!letter.indhold) continue;
        items.push({
          kind: 'weekly-letter',
          ...(person.navn ? { childName: person.navn } : {}),
          // The letter is an HTML document, and the whole point of it is the
          // prose, so it is flattened rather than passed through.
          content: htmlToText(letter.indhold),
        });
      }
    }
  }
  return {
    provider: 'minuddannelse',
    capability: 'weekly-letter',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
  };
}
