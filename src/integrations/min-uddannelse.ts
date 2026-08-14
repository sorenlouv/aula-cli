/**
 * MinUddannelse — two products, two widgets, one API shape:
 *
 *   0029  ugebrev    — the weekly letter home
 *   0030  opgaveliste — homework, with 0023 as an older id for the same thing
 *
 * Both take `Authorization: Bearer <widget token>` and identify the family
 * entirely through the query string. `sessionUUID` is the Aula guardian id,
 * not the MitID username — MinUddannelse is one of the two vendors that gets
 * that right.
 */

import { htmlToText } from '../html.ts';
import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';

const OPGAVER_URL = 'https://api.minuddannelse.net/aula/opgaveliste';
const UGEBREV_URL = 'https://api.minuddannelse.net/aula/ugebrev';

export const MU_OPGAVER_WIDGETS = ['0030', '0023'] as const;
export const MU_UGEBREV_WIDGET = '0029';

type MuOpgave = {
  /** The child the task belongs to — MinUddannelse calls this "kuvertnavn". */
  kuvertnavn?: string;
  title?: string;
  /** Danish weekday label. */
  ugedag?: string;
  opgaveType?: string;
  hold?: Array<{ name?: string }>;
  forloeb?: { navn?: string };
};

type MuUgebrev = {
  personer?: Array<{
    navn?: string;
    institutioner?: Array<{ ugebreve?: Array<{ indhold?: string }> }>;
  }>;
};

async function fetchMu<T>(
  url: string,
  ctx: IntegrationContext,
  widgetId: string,
  tokens: WidgetTokens,
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
    return widgetFetch<T>({
      url: `${url}?${params}`,
      widgetId,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  });
}

export async function getOpgaver(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string = MU_OPGAVER_WIDGETS[0],
): Promise<WeekPlan> {
  const data = await fetchMu<{ opgaver?: MuOpgave[] }>(OPGAVER_URL, ctx, widgetId, tokens);
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
  widgetId: string = MU_UGEBREV_WIDGET,
): Promise<WeekPlan> {
  const data = await fetchMu<MuUgebrev>(UGEBREV_URL, ctx, widgetId, tokens);
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
