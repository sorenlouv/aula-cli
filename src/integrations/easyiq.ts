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
import {
  errorMessage,
  expectOptionalType,
  isArrayOf,
  isOptional,
  isRecord,
  isString,
  isStringOrNumber,
} from '../validation.ts';
import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';

const EASYIQ_URL = 'https://api.easyiqcloud.dk/api/aula/weekplaninfo';

type EasyIqEvent = {
  /** `YYYY/MM/DD HH:mm`, not ISO. */
  start?: string | null;
  /** 5 marks a note rather than a timetabled event. */
  itemType?: number | string | null;
  title?: string | null;
  /** The teacher or team that owns the event. */
  ownername?: string | null;
  description?: string | null;
};

type EasyIqResponse = { Events?: EasyIqEvent[] | null };

function isEasyIqEvent(value: unknown): value is EasyIqEvent {
  return (
    isRecord(value) &&
    isOptional(value.start, isString) &&
    isOptional(value.itemType, isStringOrNumber) &&
    isOptional(value.title, isString) &&
    isOptional(value.ownername, isString) &&
    isOptional(value.description, isString)
  );
}

function isEasyIqResponse(value: unknown): value is EasyIqResponse {
  return (
    isRecord(value) &&
    isOptional(value.Events, (events): events is EasyIqEvent[] => isArrayOf(events, isEasyIqEvent))
  );
}

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
        return widgetFetch(
          {
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
          },
          (value) => expectOptionalType(value, isEasyIqResponse, 'an EasyIQ response', {}),
        );
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
      warnings.push(`${child.name}: ${errorMessage(err)}`);
    }
  }

  return {
    provider: 'easyiq',
    capability: 'weekly-plan',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
    ...(warnings.length ? { warnings } : {}),
  };
}
