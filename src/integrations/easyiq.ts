/**
 * EasyIQ Ugeplan (widget 0001).
 *
 * The simplest of the vendors: one POST, one response, all children at once.
 * The POST is a read — the body is the child/institution filter, which does
 * not fit in a query string.
 *
 * `sessionId` here is the Aula guardian id, despite the name.
 */

import { htmlToText } from '../html.ts';
import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';

const EASYIQ_URL = 'https://api.easyiqcloud.dk/api/aula/weekplaninfo';

type EasyIqEvent = {
  /** `YYYY/MM/DD HH:mm`, not ISO. */
  start?: string;
  end?: string;
  /** 5 marks a note rather than a timetabled event. */
  itemType?: number | string;
  title?: string;
  /** The teacher or team that owns the event. */
  ownername?: string;
  description?: string;
};

export async function getWeekPlan(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const items: WeekPlanItem[] = [];
  const warnings: string[] = [];

  // EasyIQ returns one child's events per call — `childFilter` is an array,
  // but passing several collapses the result to the first. Both prior-art
  // projects iterate, so we do too.
  for (const child of ctx.children) {
    if (!child.userId) {
      warnings.push(`${child.name}: no userId on the Aula profile — EasyIQ cannot look them up.`);
      continue;
    }
    try {
      const data = await tokens.withToken(widgetId, async (token) => {
        return widgetFetch<{ Events?: EasyIqEvent[] }>({
          url: EASYIQ_URL,
          method: 'POST',
          widgetId,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            origin: 'https://www.aula.dk',
            referer: 'https://www.aula.dk/',
            'x-aula-institutionfilter': ctx.institutionCodes.join(','),
            'x-aula-userprofile': 'guardian',
          },
          body: {
            sessionId: ctx.guardianId,
            currentWeekNr: ctx.isoWeek,
            userProfile: 'guardian',
            institutionFilter: ctx.institutionCodes,
            childFilter: [child.userId],
          },
        });
      });

      for (const event of data?.Events ?? []) {
        items.push({
          kind: String(event.itemType) === '5' ? 'note' : 'event',
          childName: child.name,
          ...(event.start ? { date: event.start } : {}),
          ...(event.ownername ? { subject: event.ownername } : {}),
          ...(event.title ? { title: event.title } : {}),
          ...(event.description ? { content: htmlToText(event.description) } : {}),
        });
      }
    } catch (err) {
      warnings.push(`${child.name}: ${(err as Error).message}`);
    }
  }

  return {
    provider: 'easyiq',
    capability: 'ugeplan',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
    ...(warnings.length ? { warnings } : {}),
  };
}
