/**
 * `doctor` — call every endpoint this client knows and report what came back.
 *
 * Adapted from aula-mcp's `apps/cli/src/commands/doctor.ts` (MIT, Copyright (c)
 * 2026 Casper Juel); see src/vendor/aula-auth/LICENSE.
 *
 * The point is the one thing `bun test src/` structurally cannot tell you: the
 * suite stubs `fetch`, so it proves the client is internally consistent and
 * says nothing about whether Aula still behaves. Nearly every trap in
 * API.md returns a *successful-looking* response, so this reports counts
 * rather than just "PASS" — an empty posts feed is indistinguishable from a
 * broken id set unless somebody prints the number.
 *
 * That is also why there is a `warn` status. A check that succeeded but
 * returned something that API.md says is a known symptom — no posts, no
 * step-up, a child with no `userId` — is not a pass, and pretending otherwise
 * is exactly the failure this command exists to catch. Warnings do not fail the
 * run; only a thrown error does.
 *
 * Checks run in sequence. Parallelising would halve the wall time and make
 * every per-endpoint timing meaningless, and the timings are half the value.
 */

import { AulaClient } from './client.ts';
import { startOfDay } from './cli-helpers.ts';
import { buildFamily, integrationContext, type Family } from './family.ts';
import { readWidget, SUPPORTED_WIDGET_IDS } from './integrations/index.ts';
import { isoDate, isoWeekString } from './integrations/types.ts';
import { fmt } from './io.ts';
import { errorMessage } from './validation.ts';
import { WIDGETS, WidgetTokens } from './widgets.ts';

type CheckStatus = 'ok' | 'warn' | 'skip' | 'fail';

type Check = {
  /** The Aula method, or a named step where there is no single method. */
  name: string;
  status: CheckStatus;
  ms: number;
  detail: string;
  /** Why a warn or fail matters, in terms of what it will do to your output. */
  note?: string;
};

type DoctorReport = {
  ok: boolean;
  generatedAt: string;
  apiVersion: number;
  summary: { passed: number; warned: number; skipped: number; failed: number; totalMs: number };
  checks: Check[];
};

export async function runDoctor(
  client: AulaClient,
  opts: { asText: boolean; days: number },
): Promise<number> {
  const checks: Check[] = [];
  const run = runner(checks);

  // --------------------------------------------------------------- identity

  const profiles = await run('profiles.getProfilesByLogin', async () => {
    const found = await client.getProfiles();
    const children = found.flatMap((p) => p.children ?? []).length;
    // This is the call the version probe rides on, so a retired API version
    // surfaces here rather than three checks later.
    return {
      value: found,
      detail: `${found.length} profile(s), ${children} child(ren), API v${client.apiVersion}`,
      ...(found.length === 0 ? { status: 'warn' as const, note: 'no profiles — nothing else can work' } : {}),
    };
  });

  const context = await run('profiles.getProfileContext', async () => {
    const ctx = await client.getProfileContext();
    const widgets = (ctx.pageConfiguration?.widgetConfigurations ?? []).length;
    return { value: ctx, detail: `userId=${ctx.userId ?? 'missing'}, ${widgets} widget(s) configured` };
  });

  if (!profiles || profiles.length === 0 || !context) {
    // Without both of these there are no ids to call anything else with, and a
    // screen of "skipped" would bury the one failure that matters. An empty
    // profile list counts as missing: it is truthy, so letting it through here
    // meant buildFamily threw on profiles[0] and doctor died without printing
    // the report — losing the warning it had just recorded about that very
    // state, which is the one thing it exists to tell you.
    return finish(checks, client, opts);
  }

  const family = buildFamily(profiles, context, client.mitidUsername);

  await run('session step-up', async () => ({
    value: family.isSteppedUp,
    detail: family.isSteppedUp ? 'stepped up' : 'not stepped up',
    ...(family.isSteppedUp
      ? {}
      : {
          status: 'warn' as const,
          note: 'sensitive threads read as empty rather than erroring — run `refresh-stepup`',
        }),
  }));

  await run('resolved id sets', async () => {
    const missing = family.children.filter((c) => !c.userId).map((c) => c.name);
    return {
      value: family,
      detail:
        `${family.postInstitutionProfileIds.length} post id(s), ` +
        `${family.childInstitutionProfileIds.length} child id(s), ` +
        `institutions ${family.institutionCodes.join(', ') || 'none'}`,
      ...(missing.length
        ? {
            status: 'warn' as const,
            note: `no userId for ${missing.join(', ')} — the vendor widgets cannot see them`,
          }
        : {}),
    };
  });

  // ------------------------------------------------------------------ Aula

  const threads = await run('messaging.getThreads', async () => {
    const { threads: found } = await client.getThreads(0);
    const unread = found.filter((t) => !t.read).length;
    const sensitive = found.filter((t) => t.sensitive).length;
    return {
      value: found,
      detail: `${found.length} thread(s), ${unread} unread, ${sensitive} sensitive`,
    };
  });

  await run('messaging.getMessagesForThread', async () => {
    const first = threads?.[0];
    if (!first) return { value: null, status: 'skip' as const, detail: 'no thread to open' };
    const detail = await client.getThread(first.id, 0);
    const messages = (detail.messages ?? []).length;
    return {
      value: detail,
      detail: `thread ${first.id}: ${messages}/${detail.totalMessageCount ?? '?'} message(s)`,
      ...(messages === 0
        ? { status: 'warn' as const, note: 'a thread with no readable messages is the step-up symptom' }
        : {}),
    };
  });

  await run('posts.getAllPosts', async () => {
    const { posts } = await client.getPosts({
      institutionProfileIds: family.postInstitutionProfileIds,
      limit: 5,
    });
    return {
      value: posts,
      detail: `${posts.length} post(s)`,
      // The trap worth spending a check on: an incomplete institutionProfileIds
      // set returns `{posts: [], status: {code: 0}}` — success, and empty.
      ...(posts.length === 0
        ? { status: 'warn' as const, note: 'an empty feed and a wrong id set look identical here' }
        : {}),
    };
  });

  await run('gallery.getAlbums', async () => {
    const albums = await client.getAlbums({
      childInstitutionProfileIds: family.childInstitutionProfileIds,
      limit: 5,
    });
    // The first row is the synthetic tagged-media bucket, which arrives even
    // when the filter is wrong — so counting real albums is the only signal.
    const real = albums.filter((a) => a.id != null);
    return {
      value: real,
      detail: `${real.length} album(s)`,
      ...(real.length === 0
        ? { status: 'warn' as const, note: 'an empty gallery and a wrong id set look identical here' }
        : {}),
    };
  });

  await run('calendar.getEventsByProfileIdsAndResourceIds', async () => {
    const start = startOfDay(new Date());
    const events = await client.getCalendarEvents({
      childInstitutionProfileIds: family.childInstitutionProfileIds,
      start,
      end: new Date(start.getTime() + opts.days * 86_400_000),
    });
    return { value: events, detail: `${events.length} event(s) in ${opts.days} days` };
  });

  await run('presence.getDailyOverview', async () => {
    const entries = await client.getDailyPresence(family.childInstitutionProfileIds);
    return {
      value: entries,
      detail: `${entries.length} entry/entries`,
      ...(entries.length === 0
        ? { status: 'skip' as const, detail: 'no entries — these institutions may not use komme/gå' }
        : {}),
    };
  });

  await run('presence.getPresenceTemplates', async () => {
    const from = startOfDay(new Date());
    const templates = await client.getPresenceTemplates({
      childInstitutionProfileIds: family.childInstitutionProfileIds,
      fromDate: isoDate(from),
      toDate: isoDate(new Date(from.getTime() + 7 * 86_400_000)),
    });
    return {
      value: templates,
      detail: `${(templates.presenceWeekTemplates ?? []).length} template(s) over 7 days`,
    };
  });

  const groups = await run('groups.getGroupsByContext', async () => {
    const contexts = await client.getGroupsByContext(family.childInstitutionProfileIds);
    const total = contexts.flatMap((c) => c.groups ?? []).length;
    return { value: contexts, detail: `${contexts.length} context(s), ${total} group(s)` };
  });

  await run('profiles.getContactlist', async () => {
    const groupId = groups?.flatMap((c) => c.groups ?? [])[0]?.id;
    if (groupId === undefined) return { value: null, status: 'skip' as const, detail: 'no group id to ask about' };
    const contacts = await client.getContactList({ groupId, page: 1 });
    const birthdays = contacts.filter((c) => c.birthday).length;
    return {
      value: contacts,
      detail: `group ${groupId}: ${contacts.length} contact(s), ${birthdays} with a birthday`,
    };
  });

  await run('notifications.getNotificationsForActiveProfile', async () => {
    const notifications = await client.getNotifications();
    return { value: notifications, detail: `${notifications.length} notification(s)` };
  });

  await run('commonFiles.getCommonFiles', async () => {
    const page = await client.getCommonFiles({ institutionCodes: family.institutionCodes, limit: 5 });
    return { value: page, detail: `${page.totalAmount} shared file(s) on the shelf` };
  });

  // --------------------------------------------------------------- widgets

  await checkWidgets(run, client, family);

  return finish(checks, client, opts);
}

/**
 * The vendor half, which is the half that breaks. These are third-party
 * products that go down independently of Aula, and a family only ever has one
 * or two of them — so a widget with no integration is reported as skipped
 * rather than dragged through a call that cannot work.
 */
async function checkWidgets(run: Runner, client: AulaClient, family: Family): Promise<void> {
  if (family.widgets.length === 0) {
    await run('widgets', async () => ({
      value: null,
      status: 'skip' as const,
      detail: 'these institutions expose no widgets',
    }));
    return;
  }

  const tokens = new WidgetTokens(client);
  const isoWeek = isoWeekString();

  for (const widget of family.widgets) {
    const label = `${widget.widgetId} ${WIDGETS[widget.widgetId]?.name ?? widget.name}`;

    await run(`aulaToken.getAulaToken (${label})`, async () => {
      const token = await client.getWidgetToken(widget.widgetId);
      return { value: token, detail: `token issued (${token.length} chars)` };
    });

    if (!SUPPORTED_WIDGET_IDS.includes(widget.widgetId)) {
      await run(`widget read (${label})`, async () => ({
        value: null,
        status: 'skip' as const,
        detail: 'no integration for this widget',
      }));
      continue;
    }

    await run(`widget read (${label})`, async () => {
      const plan = await readWidget(
        widget.widgetId,
        integrationContext(family, { isoWeek }),
        tokens,
      );
      const warnings = plan.warnings ?? [];
      return {
        value: plan,
        detail: `${plan.capability}: ${plan.items.length} item(s) for week ${isoWeek}`,
        // Vendors answer HTTP 200 with an instruction in the body — Meebook's
        // "open the widget in aula.dk once" is the common one — and that is a
        // configuration problem, not a failure.
        ...(warnings.length ? { status: 'warn' as const, note: warnings.join('; ') } : {}),
      };
    });
  }
}

// ------------------------------------------------------------------ plumbing

type CheckOutcome<T> = {
  value: T;
  detail: string;
  status?: CheckStatus;
  note?: string;
};

type Runner = <T>(name: string, fn: () => Promise<CheckOutcome<T>>) => Promise<T | undefined>;

/**
 * Times one check and records it. Returns the check's value so a later check
 * can use it (the first thread id, the first group id), or `undefined` if it
 * failed — which is what makes the dependent check report "skipped" instead of
 * failing a second time for the same reason.
 */
function runner(checks: Check[]): Runner {
  return async <T>(name: string, fn: () => Promise<CheckOutcome<T>>): Promise<T | undefined> => {
    const start = Date.now();
    try {
      const outcome = await fn();
      checks.push({
        name,
        status: outcome.status ?? 'ok',
        ms: Date.now() - start,
        detail: outcome.detail,
        ...(outcome.note ? { note: outcome.note } : {}),
      });
      return outcome.value;
    } catch (err) {
      checks.push({
        name,
        status: 'fail',
        ms: Date.now() - start,
        detail: 'failed',
        note: errorMessage(err).split('\n')[0] ?? errorMessage(err),
      });
      return undefined;
    }
  };
}

function finish(checks: Check[], client: AulaClient, opts: { asText: boolean }): number {
  const count = (status: CheckStatus) => checks.filter((c) => c.status === status).length;
  const report: DoctorReport = {
    ok: count('fail') === 0,
    generatedAt: new Date().toISOString(),
    apiVersion: client.apiVersion,
    summary: {
      passed: count('ok'),
      warned: count('warn'),
      skipped: count('skip'),
      failed: count('fail'),
      totalMs: checks.reduce((sum, c) => sum + c.ms, 0),
    },
    checks,
  };
  console.log(opts.asText ? renderDoctor(report) : JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

const TAGS: Record<CheckStatus, string> = {
  ok: fmt.green('PASS'),
  warn: fmt.yellow('WARN'),
  skip: fmt.dim('SKIP'),
  fail: fmt.red('FAIL'),
};

function renderDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length), 10);
  const lines = [
    `aula doctor — API v${report.apiVersion}`,
    '',
    ...report.checks.flatMap((c) => {
      const row = `  [${TAGS[c.status]}] ${c.name.padEnd(width)}  ${c.detail} ${fmt.dim(`(${c.ms} ms)`)}`;
      return c.note ? [row, `           ${fmt.dim(c.note)}`] : [row];
    }),
    '',
    `${report.summary.passed} passed, ${report.summary.warned} warned, ` +
      `${report.summary.skipped} skipped, ${report.summary.failed} failed ` +
      `in ${(report.summary.totalMs / 1000).toFixed(1)}s`,
  ];
  if (report.summary.warned > 0) {
    lines.push(fmt.dim('Warnings are successful calls that returned a known symptom — see API.md.'));
  }
  return lines.join('\n');
}
