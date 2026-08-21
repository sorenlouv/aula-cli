/**
 * EasyIQ SkolePortal — two widgets on one backend:
 *
 *   0128  Ugeplan  (/Calendar/CalendarGetWeekplanEvents)
 *   0142  Lektier  (/AulaHuskeliste/GetWeekplanEvents)
 *
 * Same vendor as {@link ../easyiq.ts} (widget 0001) but a different product on
 * a different host, with a different auth flow and PascalCase JSON. They are
 * in one file because they differ by about six header values.
 *
 * The flow is: exchange the Aula widget token for a SkolePortal `loginId`, then
 * ask for that login's events. The edge tier answers a wrong header set with a
 * 302 to its own login page rather than a 401, which `widgetFetch` maps to an
 * expired token — so a persistent "token rejected" here usually means a header
 * is wrong, not that the token is.
 */

import { decodeEntities, htmlToText } from '../html.ts';
import {
  describeShape,
  errorMessage,
  expectOptionalType,
  isArrayOf,
  isNumber,
  isOptional,
  isRecord,
  isString,
  isStringOrNumber,
} from '../validation.ts';
import { type WidgetTokens, widgetFetch } from '../widgets.ts';
import {
  BROWSER_USER_AGENT,
  type IntegrationContext,
  isoDate,
  isoWeekToMonday,
  type WeekPlan,
  type WeekPlanItem,
} from './types.ts';

const BASE = 'https://skoleportal.easyiqcloud.dk';
const AUTH_URL = `${BASE}/Aula/AuthenticateAulaUser`;
const CHILDREN_URL = `${BASE}/Aula/GetChildren`;
const UGEPLAN_URL = `${BASE}/Calendar/CalendarGetWeekplanEvents`;
const LEKTIER_URL = `${BASE}/AulaHuskeliste/GetWeekplanEvents`;

type AuthResponse = { loginId?: string | number | null; childName?: string | null };
type ChildRow = { Id: number; Login: string; Name?: string | null };

type SpEvent = {
  StartTime?: string | null;
  StartTimeISO?: string | null;
  CoursesDisplay?: string | null;
  ActivitiesDisplay?: string | null;
  ChapterTitle?: string | null;
  Title?: string | null;
  Description?: string | null;
};

function isAuthResponse(value: unknown): value is AuthResponse {
  return isRecord(value) &&
    isOptional(value.loginId, isStringOrNumber) &&
    isOptional(value.childName, isString);
}

function isChildRow(value: unknown): value is ChildRow {
  return isRecord(value) &&
    isNumber(value.Id) &&
    isString(value.Login) &&
    isOptional(value.Name, isString);
}

/**
 * The roster is a lookup table, so it degrades per row rather than as a whole:
 * a child SkolePortal has no UniLogin for cannot be matched anyway, and the
 * loop below already says so per child. Rejecting the array because one row is
 * unusable would take every sibling's homework down with it.
 */
function decodeRoster(value: unknown): ChildRow[] {
  if (value === null || value === undefined) return [];
  if (!isRecord(value)) throw new Error(`Expected a SkolePortal child roster, got ${describeShape(value)}`);
  if (value.Children === null || value.Children === undefined) return [];
  if (!Array.isArray(value.Children)) {
    throw new Error(`Expected a SkolePortal child roster, got Children as ${describeShape(value.Children)}`);
  }
  return value.Children.filter(isChildRow);
}

function isSpEvent(value: unknown): value is SpEvent {
  return isRecord(value) &&
    isOptional(value.StartTime, isString) &&
    isOptional(value.StartTimeISO, isString) &&
    isOptional(value.CoursesDisplay, isString) &&
    isOptional(value.ActivitiesDisplay, isString) &&
    isOptional(value.ChapterTitle, isString) &&
    isOptional(value.Title, isString) &&
    isOptional(value.Description, isString);
}

function decodeEvents(value: unknown): SpEvent[] {
  return expectOptionalType(
    value,
    (events): events is SpEvent[] => isArrayOf(events, isSpEvent),
    'an event list',
    [],
  );
}

/**
 * `date` is `YYYY-MM-DDT00:00:00.000Z`. A plain `YYYY-MM-DD` is accepted and
 * silently returns nothing, which is the worst of both worlds.
 */
function weekParam(isoWeek: string): string {
  return `${isoDate(isoWeekToMonday(isoWeek))}T00:00:00.000Z`;
}

type HeaderOptions = {
  token: string;
  /** Which widget's UI we are pretending to be — the referer must match. */
  referer: string;
  /** `x-childfilter`: the child, or every child, depending on the product. */
  childFilter: string;
  /** `x-child`, only sent by Lektier. */
  child?: string;
  institutions: string;
  login: string;
  requestedWith: string;
};

function headers(opts: HeaderOptions): Record<string, string> {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9,da;q=0.8',
    authorization: `Bearer ${opts.token}`,
    // Not aula.dk: SkolePortal checks these against its own origin.
    origin: BASE,
    referer: `${BASE}/${opts.referer}`,
    'user-agent': BROWSER_USER_AGENT,
    ...(opts.child ? { 'x-child': opts.child } : {}),
    'x-childfilter': opts.childFilter,
    'x-institutionfilter': opts.institutions,
    'x-login': opts.login,
    'x-requested-with': opts.requestedWith,
    'x-userprofile': 'guardian',
  };
}

function toItem(event: SpEvent, childName: string, kind: string): WeekPlanItem {
  const subject = decodeEntities(event.CoursesDisplay ?? '').trim();
  const activity = decodeEntities(event.ActivitiesDisplay ?? '').trim();
  // Lektier usually leaves `Title` blank and puts the real one in ChapterTitle.
  const title = decodeEntities(event.ChapterTitle || event.Title || '').trim();
  const description = event.Description ? htmlToText(event.Description) : '';
  const date = event.StartTimeISO ?? event.StartTime;
  return {
    kind,
    ...(childName ? { childName } : {}),
    ...(date ? { date } : {}),
    ...(subject || activity ? { subject: [subject, activity].filter(Boolean).join(' / ') } : {}),
    ...(title ? { title } : {}),
    ...(description ? { content: description } : {}),
  };
}

// ------------------------------------------------------------------- ugeplan

/**
 * Widget 0128. Authenticates per child, because the `loginId` SkolePortal
 * hands back is scoped to whichever child was in `x-childfilter`.
 */
export async function getWeekPlan(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const date = weekParam(ctx.isoWeek);
  const institutions = ctx.institutionCodes.join(',');
  const items: WeekPlanItem[] = [];
  const warnings: string[] = [];

  for (const child of ctx.children) {
    if (!child.userId) {
      warnings.push(`${child.name}: no userId on the Aula profile — SkolePortal needs it.`);
      continue;
    }
    const base = {
      referer: 'UgeplanWidget',
      childFilter: child.userId,
      institutions,
      login: ctx.sessionId,
      requestedWith: 'XMLHttpRequest',
    };
    try {
      const auth = await tokens.withToken(widgetId, async (token) => {
        return widgetFetch({
          url: AUTH_URL,
          method: 'POST',
          widgetId,
          headers: headers({ ...base, token }),
        }, (value) => expectOptionalType(value, isAuthResponse, 'a SkolePortal authentication response', {}));
      });
      if (auth?.loginId === undefined || auth.loginId === null) {
        warnings.push(`${child.name}: SkolePortal authenticated but returned no loginId.`);
        continue;
      }

      const events = await tokens.withToken(widgetId, async (token) => {
        const url = `${UGEPLAN_URL}?loginId=${encodeURIComponent(String(auth.loginId))}&date=${encodeURIComponent(date)}`;
        return widgetFetch({
          url,
          widgetId,
          headers: headers({ ...base, token }),
        }, decodeEvents);
      });

      const childName = decodeEntities(auth.childName ?? '').trim() || child.name;
      for (const event of Array.isArray(events) ? events : []) {
        items.push(toItem(event, childName, 'event'));
      }
    } catch (err) {
      warnings.push(`${child.name}: ${errorMessage(err)}`);
    }
  }

  return {
    provider: 'easyiq_skoleportal',
    capability: 'ugeplan',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
    ...(warnings.length ? { warnings } : {}),
  };
}

// -------------------------------------------------------------------- lektier

/**
 * Widget 0142. Differs from the ugeplan flow in four ways, all of which are
 * load-bearing: the referer is `/LektierWidget`, `x-login` is the Aula
 * guardian id rather than the MitID username, `x-requested-with` is `Fetch`,
 * and there is an extra `GetChildren` call.
 *
 * `GetChildren` exists because Lektier keys events on its own internal child
 * id, which is neither of Aula's. It authenticates once as the first child —
 * mirroring the browser, where the widget mounts with the first child selected
 * and then enumerates the rest.
 */
export async function getLektier(
  ctx: IntegrationContext,
  tokens: WidgetTokens,
  widgetId: string,
): Promise<WeekPlan> {
  const date = weekParam(ctx.isoWeek);
  const institutions = ctx.institutionCodes.join(',');
  const childFilter = ctx.children.map((c) => c.userId).filter(Boolean).join(',');
  const items: WeekPlanItem[] = [];
  const warnings: string[] = [];

  const first = ctx.children.find((c) => c.userId);
  if (!first) {
    return {
      provider: 'easyiq_lektier',
      capability: 'lektier',
      widgetId,
      isoWeek: ctx.isoWeek,
      items,
      warnings: ['No child has a userId on their Aula profile — Lektier cannot be queried.'],
    };
  }

  const base = {
    referer: 'LektierWidget',
    childFilter,
    child: first.userId,
    institutions,
    login: ctx.guardianId,
    requestedWith: 'Fetch',
  };

  // Called for the session it establishes, not for its body — nothing below
  // reads the response, so decoding it here would only add a way to fail.
  await tokens.withToken(widgetId, async (token) => {
    return widgetFetch({
      url: AUTH_URL,
      method: 'POST',
      widgetId,
      headers: headers({ ...base, token }),
    }, () => undefined);
  });

  const roster = await tokens.withToken(widgetId, async (token) => {
    return widgetFetch({
      url: CHILDREN_URL,
      widgetId,
      headers: headers({ ...base, token }),
    }, decodeRoster);
  });

  const rowByLogin = new Map((Array.isArray(roster) ? roster : []).map((row) => [row.Login, row]));

  for (const child of ctx.children) {
    if (!child.userId) {
      warnings.push(`${child.name}: no userId on the Aula profile — Lektier needs it.`);
      continue;
    }
    const row = rowByLogin.get(child.userId);
    if (!row) {
      warnings.push(`${child.name}: not listed by SkolePortal's GetChildren — no Lektier access.`);
      continue;
    }
    try {
      const events = await tokens.withToken(widgetId, async (token) => {
        const url =
          `${LEKTIER_URL}?loginId=${encodeURIComponent(String(row.Id))}` +
          `&date=${encodeURIComponent(date)}&activityFilter=null`;
        return widgetFetch({
          url,
          widgetId,
          headers: headers({ ...base, token, child: child.userId }),
        }, decodeEvents);
      });
      const childName = decodeEntities(row.Name ?? '').trim() || child.name;
      for (const event of Array.isArray(events) ? events : []) {
        items.push(toItem(event, childName, 'lektier'));
      }
    } catch (err) {
      warnings.push(`${child.name}: ${errorMessage(err)}`);
    }
  }

  return {
    provider: 'easyiq_lektier',
    capability: 'lektier',
    widgetId,
    isoWeek: ctx.isoWeek,
    items,
    ...(warnings.length ? { warnings } : {}),
  };
}
