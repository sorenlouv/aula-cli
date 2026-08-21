/**
 * MinUddannelse — two products, two widgets, one API shape:
 *
 *   0029  ugebrev    — the weekly letter home
 *   0030  opgaveliste — homework, with 0023 as an older id for the same thing
 *
 * Both take `Authorization: Bearer <widget token>` and identify the family
 * entirely through the query string. `sessionUUID` is the Aula guardian id,
 * not the MitID username that Meebook, Systematic and SkolePortal's ugeplan
 * key on.
 */

import { htmlToText } from '../html.ts';
import {
  expectOptionalType,
  isArrayOf,
  isOptional,
  isRecord,
  isString,
} from '../validation.ts';
import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';

const OPGAVER_URL = 'https://api.minuddannelse.net/aula/opgaveliste';
const UGEBREV_URL = 'https://api.minuddannelse.net/aula/ugebrev';

type MuNamed = { name?: string | null };
type MuForloeb = { navn?: string | null };

type MuOpgave = {
  /** The child the task belongs to — MinUddannelse calls this "kuvertnavn". */
  kuvertnavn?: string | null;
  title?: string | null;
  /** Danish weekday label. */
  ugedag?: string | null;
  opgaveType?: string | null;
  hold?: MuNamed[] | null;
  forloeb?: MuForloeb | null;
};

type MuLetter = { indhold?: string | null };
type MuInstitution = { ugebreve?: MuLetter[] | null };
type MuPerson = { navn?: string | null; institutioner?: MuInstitution[] | null };

type MuUgebrev = { personer?: MuPerson[] | null };

type MuOpgaverResponse = { opgaver?: MuOpgave[] | null };

function isNamed(value: unknown): value is MuNamed {
  return isRecord(value) && isOptional(value.name, isString);
}

function isMuOpgave(value: unknown): value is MuOpgave {
  return isRecord(value) &&
    isOptional(value.kuvertnavn, isString) &&
    isOptional(value.title, isString) &&
    isOptional(value.ugedag, isString) &&
    isOptional(value.opgaveType, isString) &&
    isOptional(value.hold, (groups): groups is MuNamed[] => isArrayOf(groups, isNamed)) &&
    isOptional(value.forloeb, (course): course is MuForloeb =>
      isRecord(course) && isOptional(course.navn, isString));
}

function isMuOpgaverResponse(value: unknown): value is MuOpgaverResponse {
  return isRecord(value) &&
    isOptional(value.opgaver, (tasks): tasks is MuOpgave[] => isArrayOf(tasks, isMuOpgave));
}

function isMuUgebrev(value: unknown): value is MuUgebrev {
  const isLetter = (candidate: unknown): candidate is MuLetter =>
    isRecord(candidate) && isOptional(candidate.indhold, isString);
  const isInstitution = (candidate: unknown): candidate is MuInstitution =>
    isRecord(candidate) &&
    isOptional(candidate.ugebreve, (letters): letters is MuLetter[] => isArrayOf(letters, isLetter));
  const isPerson = (candidate: unknown): candidate is MuPerson =>
    isRecord(candidate) &&
    isOptional(candidate.navn, isString) &&
    isOptional(candidate.institutioner, (institutions): institutions is MuInstitution[] =>
      isArrayOf(institutions, isInstitution));
  return isRecord(value) &&
    isOptional(value.personer, (people): people is MuPerson[] => isArrayOf(people, isPerson));
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
    return widgetFetch({
      url: `${url}?${params}`,
      widgetId,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    }, decode);
  });
}

export async function getOpgaver(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const data = await fetchMu(OPGAVER_URL, ctx, widgetId, tokens, (value) =>
    expectOptionalType(value, isMuOpgaverResponse, 'a MinUddannelse assignment response', {}));
  const items: WeekPlanItem[] = [];
  for (const opgave of data?.opgaver ?? []) {
    const subjects = (opgave.hold ?? []).map((h) => h.name).filter(Boolean);
    items.push({
      kind: opgave.opgaveType ?? 'opgave',
      ...(opgave.kuvertnavn ? { childName: opgave.kuvertnavn } : {}),
      ...(opgave.ugedag ? { date: opgave.ugedag } : {}),
      ...(subjects.length ? { subject: subjects.join(', ') } : {}),
      ...(opgave.title ? { title: opgave.title } : {}),
      ...(opgave.forloeb?.navn ? { content: opgave.forloeb.navn } : {}),
    });
  }
  return {
    provider: 'minuddannelse',
    capability: 'opgaver',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
  };
}

export async function getUgebrev(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const data = await fetchMu(UGEBREV_URL, ctx, widgetId, tokens, (value) =>
    expectOptionalType(value, isMuUgebrev, 'a MinUddannelse weekly letter response', {}));
  const items: WeekPlanItem[] = [];
  for (const person of data?.personer ?? []) {
    for (const institution of person.institutioner ?? []) {
      for (const letter of institution.ugebreve ?? []) {
        if (!letter.indhold) continue;
        items.push({
          kind: 'ugebrev',
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
    capability: 'ugebrev',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
  };
}
