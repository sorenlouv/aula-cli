/**
 * Provider dispatch.
 *
 * A capability ("give me this week's plan") maps to whichever widget the
 * family's schools actually have. Nobody outside this file should have to know
 * that 0004 means Meebook.
 */

import { ResponseCache } from '../cache.ts';
import type { Capability, DetectedWidget, WidgetTokens } from '../widgets.ts';
import { WIDGETS } from '../widgets.ts';
import * as easyiq from './easyiq.ts';
import * as skoleportal from './easyiq-skoleportal.ts';
import * as meebook from './meebook.ts';
import * as minUddannelse from './min-uddannelse.ts';
import * as systematic from './systematic.ts';
import type { IntegrationContext, WeekPlan } from './types.ts';

export type Fetcher = (
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
) => Promise<WeekPlan>;

/**
 * Widget id → the function that reads it. Keyed by widget rather than by
 * provider because that is what `profiles.getProfileContext` gives us, and
 * because two ids can map to the same provider but different products
 * (0128 and 0142 are both EasyIQ SkolePortal).
 */
const FETCHERS: Readonly<Record<string, Fetcher>> = Object.freeze({
  '0001': easyiq.getWeekPlan,
  '0004': meebook.getWeekPlan,
  '0023': minUddannelse.getOpgaver,
  '0029': minUddannelse.getUgebrev,
  '0030': minUddannelse.getOpgaver,
  '0062': systematic.getReminders,
  '0128': skoleportal.getWeekPlan,
  '0142': skoleportal.getLektier,
});

export const SUPPORTED_WIDGET_IDS = Object.keys(FETCHERS);

/** Every capability this project can serve, in the order `homework` reads them. */
export const CAPABILITIES: readonly Capability[] = [
  'ugeplan',
  'ugebrev',
  'opgaver',
  'lektier',
  'huskelisten',
];

export class NoProviderError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability, detected: DetectedWidget[]) {
    const known = Object.entries(WIDGETS)
      .filter(([, info]) => info.capability === capability)
      .map(([id, info]) => `${id} (${info.name})`)
      .join(', ');
    super(
      `No ${capability} widget is enabled for these institutions. ` +
        `Detected: ${detected.map((w) => `${w.widgetId} ${w.name}`).join(', ') || 'none'}. ` +
        `Widgets that would serve "${capability}": ${known}.`,
    );
    this.name = 'NoProviderError';
    this.capability = capability;
  }
}

/**
 * Every capability here is a school product, and a child at an institution
 * Aula labels `'Daycare'` has no weekly plan anywhere. Vendors asked about a
 * child they have never heard of do not decline cleanly — SkolePortal answers
 * HTTP 500, Meebook answers per-child error prose — and that then reads as an
 * outage on a page that promises every shown failure is real. So daycare
 * children are not asked about at all.
 *
 * Only an affirmative `'Daycare'` label excludes. An unknown or missing type
 * stays in, because over-asking a vendor is recoverable noise while silently
 * dropping a school child is the failure this project exists to prevent.
 */
export function schoolChildren(ctx: IntegrationContext): IntegrationContext['children'] {
  return ctx.children.filter((c) => (c.institutionType ?? '').toLowerCase() !== 'daycare');
}

/**
 * Read one capability from every detected widget that serves it.
 *
 * Plural because it genuinely can be: a family with a child at a Meebook
 * school and a child at an EasyIQ school has two ugeplan providers, and
 * picking one would silently drop a child.
 */
export async function readCapability(
  capability: Capability,
  detected: DetectedWidget[],
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  cache: ResponseCache = ResponseCache.disabled(),
): Promise<WeekPlan[]> {
  const widgets = detected.filter(
    (w) => w.capability === capability && FETCHERS[w.widgetId] !== undefined,
  );
  if (widgets.length === 0) throw new NoProviderError(capability, detected);

  const children = schoolChildren(ctx);
  if (children.length === 0) throw new NoProviderError(capability, detected);
  const scoped = { ...ctx, children };

  // MinUddannelse ships two ids for one opgaveliste (0030 superseded 0023);
  // an institution that advertises both would otherwise be read twice.
  const byProvider = new Map<string, DetectedWidget>();
  for (const widget of widgets) {
    if (!byProvider.has(String(widget.provider))) byProvider.set(String(widget.provider), widget);
  }

  return Promise.all(
    [...byProvider.values()].map(async (widget) => {
      const fetcher = FETCHERS[widget.widgetId];
      if (!fetcher) throw new NoProviderError(capability, detected);
      return cached(widget.widgetId, scoped, cache, () => fetcher(scoped, tokens, widget.widgetId));
    }),
  );
}

/**
 * Read a specific widget by id, bypassing detection. For when a school has
 * the product but does not advertise the widget on the guardian's page — rare,
 * but it happens, and re-deriving it by hand is worse.
 */
export async function readWidget(
  widgetId: string,
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  cache: ResponseCache = ResponseCache.disabled(),
): Promise<WeekPlan> {
  const fetcher = FETCHERS[widgetId];
  if (!fetcher) {
    throw new Error(
      `No integration for widget "${widgetId}". Supported: ${SUPPORTED_WIDGET_IDS.join(', ')}.`,
    );
  }
  const children = schoolChildren(ctx);
  if (children.length === 0) {
    const info = WIDGETS[widgetId];
    return {
      provider: info?.provider ?? 'unavailable',
      capability: info?.capability ?? 'ugeplan',
      widgetId,
      isoWeek: ctx.isoWeek,
      items: [],
      warnings: [
        'None of the selected children attend a school-type institution, and this ' +
          'is a school product — the vendor was not asked.',
      ],
    };
  }
  const scoped = { ...ctx, children };
  return cached(widgetId, scoped, cache, () => fetcher(scoped, tokens, widgetId));
}

/**
 * Cached at the *plan* level rather than inside `widgetFetch`, because a hit
 * has to skip the widget token too. The token is minted by `WidgetTokens`
 * before the vendor call is made, so caching any further in would still cost an
 * `aulaToken.getAulaToken` round-trip per widget — and those are deliberately
 * never cached (see src/cache.ts). It also means one entry covers SkolePortal's
 * three-request authenticate-then-read dance instead of three.
 */
async function cached(
  widgetId: string,
  ctx: IntegrationContext,
  cache: ResponseCache,
  read: () => Promise<WeekPlan>,
): Promise<WeekPlan> {
  // Every field the vendors actually filter on. `sessionId` is in here because
  // setting the MitID username changes what Meebook and Systematic return.
  const key = {
    isoWeek: ctx.isoWeek,
    from: ctx.fromDate ?? null,
    to: ctx.toDate ?? null,
    guardianId: ctx.guardianId,
    sessionId: ctx.sessionId,
    children: ctx.children.map((c) => `${c.id}:${c.userId}`).sort(),
  };
  const hit = cache.get<WeekPlan>(`widget-${widgetId}`, key);
  if (hit !== undefined) return hit;
  const plan = await read();
  // A plan with no items and a warning is a vendor that failed, not a quiet
  // week — and cache.ts's rule is that nothing which failed gets pinned for the
  // TTL. Storing it would throw away the retry that leaving widget tokens
  // uncached exists to buy: the vendor recovers seconds later and every digest,
  // ugeplan and brief for the next ten minutes still answers "nothing
  // published" without contacting it. A partial read is kept, because the
  // warnings there are usually structural (a child whose institution has no
  // such widget at all) and the items are real.
  const failedOutright = plan.items.length === 0 && (plan.warnings ?? []).length > 0;
  if (!failedOutright) cache.set(`widget-${widgetId}`, key, plan);
  return plan;
}

export type { IntegrationContext, WeekPlan, WeekPlanItem } from './types.ts';
export { isoWeekString, isoWeekToMonday, isoDate, localIsoDate, weekOffset } from './types.ts';
