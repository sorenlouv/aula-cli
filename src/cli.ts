#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { downloadAttachment, listAttachments, type ResolvedAttachment } from './attachments.ts';
import { isCliCommand, parseCommandLine } from './cli-options.ts';
import {
  type BirthdayContact,
  formatDate,
  formatWhen,
  indent,
  type NormalCommonFile,
  normaliseCommonFile,
  normaliseSchedule,
  parseKeyValues,
  parseSince,
  resolveWeek,
  selectCommonFile,
  startOfDay,
  upcomingBirthdays,
} from './cli-helpers.ts';
import {
  CACHE_PATH,
  type CacheStats,
  DEFAULT_TTL_MS,
  cacheStats,
  clearCache,
  flushCache,
} from './cache.ts';
import { AulaApiError, AulaAuthError, AulaClient } from './client.ts';
import {
  buildDigest,
  collectAlbums,
  collectPosts,
  collectThreads,
  type ChildGroups,
  loadCalendar,
  loadGroups,
  normaliseAlbum,
  normaliseEvent,
  normaliseMessage,
  normalisePost,
  normalisePresence,
  normaliseThread,
  readManyPlans,
  readPlans,
  withFullMessages,
} from './digest.ts';
import { BRIEF_TITLE, runBrief } from './brief/index.ts';
import { deployArtifact, readTarget, setTarget } from './brief/deploy.ts';
import { explain } from './brief/rank.ts';
import { BRIEF_DIR, loadState, recordDeploy, saveState, todayIsComplete } from './brief/state.ts';
import { runDoctor } from './doctor.ts';
import { AulaSessionError, UsageError } from './errors.ts';
import { fmt } from './io.ts';
import { AulaAuthFlowError } from './vendor/aula-auth/index.ts';
import { resolveFamily, selectChildren, type Family } from './family.ts';
import { runLogin, runLogout, runRefreshStepUp, runStatus } from './login.ts';
import {
  addPreference,
  loadPreferences,
  PREFERENCES_PATH,
  removePreference,
  resetPreferences,
} from './preferences.ts';
import { runSchedule } from './schedule.ts';
import { SUPPORTED_WIDGET_IDS, type WeekPlan } from './integrations/index.ts';
import { isoDate, localIsoDate } from './integrations/types.ts';
import type { CommonFile, Contact, ThreadDetail } from './types.ts';
import { errorMessage, parseInteger, parseIsoDateParts } from './validation.ts';
import type { Capability } from './widgets.ts';

const USAGE = `
aula — your kids' school and daycare, read from Aula (aula.dk)

Usage: aula <command> [options]        (or: bun src/cli.ts <command>)

Everyday:
  new                          Generate today's AI overview — the local page and,
                               where configured, the hosted copy — then open it
  open                         Open the newest overview without regenerating
  open --web                   Open the hosted copy instead (readable anywhere)
  publish                      Keep a hosted copy, readable on a phone: publishes
                               the newest page as a private artifact and redeploys
                               to it on every run from then on
  publish --off                Stop updating the hosted copy and forget its URL
  schedule [--at HH:MM]        Generate the overview automatically every weekday,
                               retrying through the morning if the Mac was asleep
  schedule --remove            Stop generating it automatically
  remember "<ønske>"           Teach the overview what matters to you — a sender
                               to always highlight, something you never need
  preferences                  Everything it has been told to remember
  preferences reset            Back to the preferences aula-cli ships with
  forget <n>                   Drop preference number n
  login                        Log in with MitID (tokens refresh themselves)
  logout                       Forget the stored login
  status                       Whether you are logged in, and for how much longer

Options for new:
  --days <n>                   How much history to read (default 14)
  --no-open                    Do not open the page (a pipe or scheduler never opens)
  --no-llm                     Danish rules only — skip the model calls
  --no-deploy                  Do not update the hosted copy this run
  --catch-up                   Do nothing if today's overview is already complete
                               (every scheduled trigger passes this)
  --explain                    Print the score breakdown behind the ranking
  --pdf, --png                 Also write a PDF / PNG
  --out <dir>                  Write somewhere other than ~/.aula/brief

For Claude — the aula skill drives these to answer questions; humans rarely
type them:
  digest                       Everything relevant in one payload
  whoami                       Guardian, children, institutions, widgets, id sets
  messages / thread <id>       Message threads / one thread with every message
  posts                        Posts ("opslag") from schools and daycare
  galleries                    Photo albums — titles and dates, not the photos
  calendar / presence          Upcoming events / today's check-in and check-out
  pickup-times                 The recurring komme/gå plan
  groups / contacts            Group membership / class contact list
  birthdays                    Classmates' birthdays, soonest first
  notifications                Unread badges Aula is currently showing
  attachments <threadId>       List a thread's attachments
  attachment <threadId> <n>    Download attachment n of a thread
  commonfiles / commonfile <x> "Fælles Filer" — the shared shelf / download one
  widgets                      Which vendor widgets these schools expose
  ugeplan / ugebrev            Weekly plan / weekly letter, whichever vendor
  opgaver / lektier / huskelisten / homework
                               Homework, per vendor and combined
  refresh-stepup               Restore step-up so sensitive threads read again
  doctor                       Call every endpoint and report status + timing
  cache status|clear           Inspect or drop the response cache
  raw <method> [k=v ...]       Any un-wrapped Aula read method

  Their options: --text --limit <n> --since <7d|2026-08-01> --child <name|id>
  --days <n> --full --unread --important --week <2026-W33> --next --page <n>
  --widget <id> --group <id> --role <child|guardian> --out <path>
  --from <date> --to <date> --no-cache --cache-ttl <seconds>

Login options:
  --username <name>            MitID username
  --method <APP|CODE_TOKEN>    App approval (default) or kodeviser
  --debug                      Write a sanitised wire transcript during login

Examples:
  aula new
  aula remember "beskeder fra John (Peters far) er altid vigtige"
  aula open --web
  aula digest --days 14 --text
  aula messages --limit 30 --full --since 30d
  aula ugeplan --next --text
`.trim();

// ---------------------------------------------------------------- entrypoint

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (!isCliCommand(command)) throw new UsageError(`Unknown command "${command}". Run \`aula --help\`.`);

  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(command, argv.slice(1));
  } catch (err) {
    throw new UsageError(`${errorMessage(err)}\nRun \`aula --help\` for the commands and options.`);
  }
  const { values, positionals } = parsed;

  const asText = values.text === true;
  const limit = optionalInteger(values.limit, '--limit', { min: 1 });
  const days = optionalInteger(values.days, '--days', { min: 1, max: 50 }) ?? 14;
  const page = optionalInteger(values.page, '--page', { min: 0 });
  const groupId = optionalInteger(values.group, '--group', { min: 1 });
  const fromDate = optionalIsoDate(values.from, '--from');
  const toDate = optionalIsoDate(values.to, '--to');
  const contactRole = parseContactRole(values.role);
  const threadId = command === 'thread' || command === 'attachments' || command === 'attachment'
    ? requireId(positionals[0], `${command} <threadId>`)
    : undefined;
  const attachmentIndex = command === 'attachment'
    ? requireInteger(positionals[1], 'attachment index', { min: 0 })
    : undefined;
  if (fromDate && toDate && fromDate > toDate) {
    throw new UsageError(`--from (${fromDate}) must not be after --to (${toDate}).`);
  }
  const since = values.since ? parseSince(values.since) : undefined;
  const week = resolveWeek(values.week, values.next === true);
  const ttlMs = parseCacheTtl(values['cache-ttl']);

  if (command === 'cache') return runCache(positionals, asText, ttlMs);
  if (command === 'open') return runOpen(values.web === true);
  if (command === 'publish') return runPublish(positionals[0], values.off === true);
  if (command === 'remember') return runRemember(positionals);
  if (command === 'preferences') return runPreferences(positionals);
  if (command === 'forget') return runForget(positionals[0]);
  // The scheduler's retries: a morning that already went right costs nothing,
  // not even a login check — this is answered from the state file alone.
  if (command === 'new' && values['catch-up'] === true) {
    const state = loadState();
    if (todayIsComplete(state)) {
      return emit({ skipped: true, lastRun: state.lastRun ?? null }, asText, (r) => {
        const at = r.lastRun ? new Date(r.lastRun.at) : null;
        const when = at ? at.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }) : '';
        return `Dagens oversigt er allerede komplet${when ? ` (kl. ${when})` : ''} — intet at gøre.`;
      });
    }
  }
  if (command === 'schedule') {
    return runSchedule({ remove: values.remove === true, ...(values.at ? { at: values.at } : {}) });
  }
  if (command === 'login') {
    return runLogin({
      ...(values.username ? { username: values.username } : {}),
      method: parseAuthMethod(values.method),
      debug: values.debug === true,
    });
  }
  if (command === 'logout') return runLogout();
  if (command === 'status') return runStatus(asText);
  if (command === 'refresh-stepup') return runRefreshStepUp();

  const client = await AulaClient.create({
    // `doctor` answers "is the API behaving right now", so it has to make every
    // call for real — a cached PASS would be a report on a request it did not
    // send, which is worse than no report.
    cache: command === 'doctor' || values['no-cache'] === true ? { enabled: false } : { ttlMs },
  });

  switch (command) {
    case 'doctor':
      return runDoctor(client, { asText, days });

    case 'whoami': {
      const family = await resolveFamily(client);
      return emit(family, asText, renderWhoami);
    }

    case 'messages': {
      const family = await resolveFamily(client);
      const threads = await collectThreads(client, {
        limit: limit ?? 20,
        unreadOnly: values.unread === true,
        family,
        ...(since ? { since } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      const result = values.full
        ? await withFullMessages(client, threads)
        : threads.map(normaliseThread);
      return emit(result, asText, renderThreads);
    }

    case 'thread': {
      if (threadId === undefined) throw new Error('thread id was not validated');
      const detail = await client.getThread(threadId, page ?? 0);
      const result = {
        id: detail.id,
        subject: detail.subject ?? '(no subject)',
        sensitive: detail.sensitive,
        startedAt: detail.threadStartedDateTime,
        totalMessageCount: detail.totalMessageCount,
        moreMessagesExist: detail.moreMessagesExist,
        participants: (detail.recipients ?? []).map((r) => r.fullName).filter(Boolean),
        messages: (detail.messages ?? []).map(normaliseMessage),
      };
      return emit(result, asText, (r) => renderThreadDetail(r));
    }

    case 'posts': {
      const family = await resolveFamily(client);
      const posts = await collectPosts(client, family, {
        limit: limit ?? 20,
        important: values.important === true,
        ...(since ? { since } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      return emit(posts, asText, renderPosts);
    }

    case 'galleries': {
      const family = await resolveFamily(client);
      const albums = await collectAlbums(client, family, {
        limit: limit ?? 20,
        ...(since ? { since } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      return emit(albums, asText, renderAlbums);
    }

    case 'calendar': {
      const family = await resolveFamily(client);
      const events = await loadCalendar(client, family, {
        days,
        ...(values.child ? { child: values.child } : {}),
      });
      return emit(events, asText, renderCalendar);
    }

    case 'presence': {
      const family = await resolveFamily(client);
      const children = selectChildren(family, values.child);
      const entries = await client.getDailyPresence(children.map((c) => c.id));
      return emit(entries.map(normalisePresence), asText, renderPresence);
    }

    case 'notifications': {
      const notifications = await client.getNotifications();
      const grouped = notifications.map((n) => ({
        type: n.notificationEventType,
        area: n.notificationArea,
        child: n.relatedChildName ?? null,
        institution: n.institutionCode,
        threadId: n.threadId ?? null,
        postId: n.postId ?? null,
        triggered: n.triggered ?? null,
      }));
      return emit(grouped, asText, (rows) =>
        rows.map((r) => `${r.area}/${r.type}${r.child ? ` — ${r.child}` : ''}`).join('\n'),
      );
    }

    case 'pickup-times': {
      const family = await resolveFamily(client);
      const children = selectChildren(family, values.child);
      const from = fromDate ?? isoDate(startOfDay(new Date()));
      const to = toDate ?? isoDate(new Date(Date.now() + days * 86_400_000));
      const templates = await client.getPresenceTemplates({
        childInstitutionProfileIds: children.map((c) => c.id),
        fromDate: from,
        toDate: to,
      });
      const result = normaliseSchedule(templates, { from, to });
      return emit(result, asText, renderSchedule);
    }

    case 'groups': {
      const family = await resolveFamily(client);
      const children = selectChildren(family, values.child);
      const result = await loadGroups(client, children);
      return emit(result, asText, (rows) =>
        rows
          .map(
            (r) =>
              `${r.child}${r.className ? ` — class ${r.className} (group ${r.classGroupId})` : ''}\n` +
              indent(r.groups.map((g) => `${g.name} (${g.id})`).join('\n') || '(no groups)', 4),
          )
          .join('\n\n'),
      );
    }

    case 'contacts': {
      const family = await resolveFamily(client);
      const contacts = await loadContacts(client, family, {
        role: contactRole,
        ...(values.child ? { child: values.child } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
      });
      return emit(contacts, asText, renderContacts);
    }

    case 'birthdays': {
      const family = await resolveFamily(client);
      const contacts = await loadContacts(client, family, {
        role: 'child',
        ...(values.child ? { child: values.child } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
      });
      const result = upcomingBirthdays(contacts, limit);
      return emit(result, asText, (rows) =>
        rows.length === 0
          ? '(no birthdays shared in these classes)'
          : rows
              .map(
                (r) =>
                  `${String(r.inDays).padStart(3)}d  ${r.date}  ${r.name}` +
                  `${r.turns ? ` (turns ${r.turns})` : ''} — ${r.group}`,
              )
              .join('\n'),
      );
    }

    case 'attachments': {
      if (threadId === undefined) throw new Error('thread id was not validated');
      const detail = await client.getThread(threadId, page ?? 0);
      const found = threadAttachments(detail);
      return emit(found, asText, (rows) =>
        rows.length === 0
          ? '(no attachments in this thread)'
          : rows
              .map((a) => `[${a.index}] ${a.name} (${a.kind}) — from ${a.from ?? 'unknown'}`)
              .join('\n'),
      );
    }

    case 'attachment': {
      if (threadId === undefined || attachmentIndex === undefined) {
        throw new Error('attachment positionals were not validated');
      }
      const detail = await client.getThread(threadId);
      const found = threadAttachments(detail);
      const wanted = found[attachmentIndex];
      if (!wanted) {
        throw new UsageError(
          `Thread ${threadId} has ${found.length} attachment(s); there is no index ${attachmentIndex}.` +
            (found.length ? `\n${found.map((a) => `  [${a.index}] ${a.name}`).join('\n')}` : ''),
        );
      }
      if (wanted.kind === 'link') {
        throw new UsageError(`Attachment ${attachmentIndex} is a link, not a file: ${wanted.url}`);
      }
      const saved = await downloadAttachment({
        attachment: wanted,
        prefix: `${threadId}-${attachmentIndex}`,
        ...(values.out ? { out: values.out } : {}),
      });
      return emit(saved, asText, (r) => `Saved ${r.filename} (${r.bytes} bytes) to ${r.path}`);
    }

    case 'commonfiles': {
      const family = await resolveFamily(client);
      const files = await collectCommonFiles(client, family, limit);
      return emit(files, asText, renderCommonFiles);
    }

    case 'commonfile': {
      const family = await resolveFamily(client);
      const ref = positionals[0];
      if (!ref) throw new UsageError('Usage: commonfile <id|text from the title>');
      const files = await collectCommonFiles(client, family);
      const wanted = selectCommonFile(files, ref);
      if (!wanted.url) {
        throw new UsageError(
          `"${wanted.title}" has no downloadable file` +
            (wanted.status && wanted.status !== 'available'
              ? ` — Aula reports its status as "${wanted.status}".`
              : '.'),
        );
      }
      const saved = await downloadAttachment({
        attachment: { index: 0, name: wanted.filename ?? wanted.title, url: wanted.url, kind: 'file' },
        prefix: `commonfile-${wanted.id}`,
        ...(values.out ? { out: values.out } : {}),
      });
      return emit(saved, asText, (r) => `Saved ${r.filename} (${r.bytes} bytes) to ${r.path}`);
    }

    case 'widgets': {
      const family = await resolveFamily(client);
      const result = family.widgets.map((w) => ({
        widgetId: w.widgetId,
        name: w.name,
        provider: w.provider ?? null,
        capability: w.capability ?? null,
        supported: SUPPORTED_WIDGET_IDS.includes(w.widgetId),
      }));
      return emit(result, asText, (rows) =>
        rows.length === 0
          ? '(no widgets exposed by these institutions)'
          : rows
              .map(
                (r) =>
                  `${r.widgetId}  ${r.name}` +
                  `${r.capability ? ` — ${r.capability} via ${r.provider}` : ''}` +
                  `${r.supported ? '' : '  <no integration>'}`,
              )
              .join('\n'),
      );
    }

    case 'ugeplan':
    case 'ugebrev':
    case 'opgaver':
    case 'lektier':
    case 'huskelisten': {
      const family = await resolveFamily(client);
      const capability: Capability = command;
      const plans = await readPlans(client, family, {
        capability,
        isoWeek: week,
        ...(values.child ? { child: values.child } : {}),
        ...(values.widget ? { widget: values.widget } : {}),
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      });
      return emit(plans, asText, renderPlans);
    }

    case 'homework': {
      const family = await resolveFamily(client);
      const plans = await readManyPlans(client, family, ['opgaver', 'lektier', 'huskelisten'], {
        isoWeek: week,
        ...(values.child ? { child: values.child } : {}),
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      });
      return emit(plans, asText, renderPlans);
    }

    case 'raw': {
      const method = positionals[0];
      if (!method) {
        throw new UsageError('Usage: raw <method> [key=value ...]');
      }
      const result = await client.getRaw(method, parseKeyValues(positionals.slice(1)));
      return emit(result, asText, (r) => JSON.stringify(r, null, 2));
    }

    case 'digest': {
      const digest = await buildDigest(client, {
        days,
        isoWeek: week,
        ...(limit !== undefined ? { limit } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      return emit(digest, asText, renderDigest);
    }

    case 'new': {
      const run = await runBrief(client, {
        days,
        isoWeek: week,
        useModel: !values['no-llm'],
        deploy: !values['no-deploy'],
        useCache: !values['no-cache'],
        pdf: values.pdf === true,
        png: values.png === true,
        ...(values.out ? { outDir: values.out } : {}),
      });
      if (values.explain) {
        console.error(explain(run.brief));
      }
      // Opens in a terminal, stays quiet everywhere else: the launchd agent
      // runs this exact command through a pipe and must not pop a browser.
      if (process.stdout.isTTY && values['no-open'] !== true && run.published.htmlPath) {
        openInBrowser(run.published.htmlPath);
      }
      return emit(
        {
          html: run.published.htmlPath,
          artifact: run.published.artifactPath,
          pdf: run.published.pdfPath,
          png: run.published.pngPath,
          layout: run.origin,
          deployed: run.deployment.status === 'ok' ? run.deployment.url : null,
          complete: run.complete,
          topline: run.topline,
          signals: run.brief.signals.filter((s) => s.tier !== 'hidden').length,
          hidden: run.brief.signals.filter((s) => s.tier === 'hidden').length,
          notes: run.notes,
        },
        asText,
        renderBrief,
      );
    }

    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

// ------------------------------------------------------------------ commands

function runCache(positionals: string[], asText: boolean, ttlMs: number): number {
  const sub = positionals[0] ?? 'status';
  if (sub === 'clear') {
    const cleared = clearCache();
    return emit({ cleared, path: CACHE_PATH }, asText, (r) =>
      r.cleared ? `Cleared ${r.path}.` : 'Nothing was cached.',
    );
  }
  if (sub === 'status') {
    return emit(cacheStats({ ttlMs }), asText, renderCacheStats);
  }
  console.error(`Unknown cache subcommand "${sub}". Use "status" or "clear".`);
  return 1;
}

/**
 * `open` / `open --web` — show the overview that already exists.
 *
 * The scheduled run refreshes `latest.html` (and, where configured, the hosted
 * copy) each weekday morning, so this is the "just show me today's page"
 * command. It needs no credentials, so it works even when the login has
 * expired.
 */
function runOpen(web: boolean): number {
  if (web) {
    const url = readTarget();
    if (!url) {
      console.error(
        'No hosted copy is configured — `aula publish` sets one up. `aula open` shows the local page.',
      );
      return 1;
    }
    // Same courtesy as the local page below: say when the link is stale rather
    // than let a day-old brief read as today's.
    const deploy = loadState().lastDeploy;
    if (deploy && deploy.url === url && deploy.day !== localIsoDate(new Date())) {
      console.error(`The hosted copy was last updated ${deploy.day} — \`aula new\` refreshes it.`);
    }
    openInBrowser(url);
    console.log(url);
    return 0;
  }

  const path = join(BRIEF_DIR, 'latest.html');
  if (!existsSync(path)) {
    console.error(`No overview found at ${path} — run \`aula new\` to generate one.`);
    return 1;
  }
  const day = localIsoDate(new Date(statSync(path).mtimeMs));
  const today = localIsoDate(new Date());
  if (day !== today) {
    console.error(`The newest overview is from ${day} — \`aula new\` generates today's.`);
  }
  openInBrowser(path);
  console.log(path);
  return 0;
}

/**
 * `publish` / `publish --off` — the hosted copy, configured.
 *
 * The preference lives in `~/.aula/config.json`, per installation: nothing a
 * clone of this repository inherits, and nothing another user of the tool can
 * see or redeploy. `publish` creates the artifact when none is configured and
 * redeploys to it when one is; either way today's page goes up immediately, so
 * the command ends with a link that works — not with a promise about
 * tomorrow's run.
 */
async function runPublish(extra: string | undefined, off: boolean): Promise<number> {
  if (extra !== undefined) {
    throw new UsageError('publish takes no arguments — it creates the artifact itself; `publish --off` stops it.');
  }
  const target = readTarget();
  if (off) {
    setTarget(null);
    console.log(target ? `The hosted copy is off — ${target} will not be updated again.` : 'No hosted copy was configured.');
    return 0;
  }
  const artifactPath = join(BRIEF_DIR, 'artifact.html');
  if (!existsSync(artifactPath)) {
    console.error('No overview to publish yet — run `aula new` first, then `aula publish`.');
    return 1;
  }

  console.error(
    target
      ? `Redeploying the newest overview to ${target}…`
      : 'Publishing the newest overview as a new artifact (private to your claude.ai account)…',
  );
  const result = await deployArtifact(artifactPath, { title: BRIEF_TITLE, create: !target });
  if (result.status !== 'ok') {
    console.error(`Publishing failed: ${result.reason}`);
    return 1;
  }
  // Saved only after a deploy that worked — the URL is only known from the reply.
  if (!target) setTarget(result.url);
  const state = loadState();
  recordDeploy(state, result.url);
  saveState(state);
  console.error('Every `aula new` (and the schedule) keeps it current; `aula publish --off` stops it.');
  console.log(result.url);
  return 0;
}

/**
 * `remember` / `preferences` / `forget` — curation, in the user's own words.
 *
 * Three plain verbs and no flags, because this is the one part of the tool a
 * non-technical user drives themselves: they say "husk at John altid er
 * vigtig" to Claude, the skill maps that onto `remember`, and the sentence is
 * stored as they said it. Anything that needed a category, a weight or a
 * syntax would end the sentence they were willing to say.
 *
 * Claude never edits `preferences.md` directly — see the note in
 * `preferences.ts`. `preferences` and `forget` exist so the user can see and
 * undo what was written on their behalf; a memory nobody can inspect is one
 * nobody can trust.
 */
function runRemember(positionals: string[]): number {
  // Unquoted works too: `aula remember beskeder fra John er vigtige`. A wish
  // typed as a sentence is the normal case, not the odd one.
  const result = addPreference(positionals.join(' '));
  if (!result.added) {
    console.log(`Already remembered: "${result.text}" — nothing changed.`);
    return 0;
  }
  console.log(
    `Remembered: "${result.text}"\n` +
      `It takes effect on the next \`aula new\`. ${result.preferences.length} preference(s) in total — ` +
      '`aula preferences` lists them.',
  );
  return 0;
}

function runPreferences(positionals: string[]): number {
  const sub = positionals[0];
  if (sub === 'reset') return runPreferencesReset();
  if (sub !== undefined) {
    throw new UsageError(`Unknown subcommand "${sub}". Use \`aula preferences\` or \`aula preferences reset\`.`);
  }
  // Seeds on first use: the tool's own opinions are the first thing this
  // prints, which is the only way a user finds out they can be argued with.
  const preferences = loadPreferences();
  if (preferences.length === 0) {
    console.log(
      `The list is empty (${PREFERENCES_PATH}) — the overview is ranked on its own judgement alone.\n` +
        '`aula remember "beskeder fra John (Peters far) er altid vigtige"` puts something back.',
    );
    return 0;
  }
  console.log(
    [
      `What the overview is written to: ${PREFERENCES_PATH}`,
      '',
      ...preferences.map((line, i) => `  ${i + 1}. ${line}`),
      '',
      '`aula remember "…"` adds one, `aula forget <n>` drops one — including the ones this tool',
      'started with. The file is one preference per line — editing it by hand works just as well.',
    ].join('\n'),
  );
  return 0;
}

function runPreferencesReset(): number {
  const { dropped } = resetPreferences();
  const lines = ['Reset preferences to the defaults the cli ships with'];
  if (dropped.length) {
    // Say what was destroyed, in full, so it can be typed back in.
    lines.push(
      '',
      `Dropped ${dropped.length} of your own — \`aula remember\` puts any of them back:`,
      ...dropped.map((line) => `  · ${line}`),
    );
  }
  console.log(lines.join('\n'));
  return 0;
}

function runForget(raw: string | undefined): number {
  const index = Number(raw);
  if (raw === undefined || !Number.isInteger(index)) {
    throw new UsageError('Usage: aula forget <n> — the number shown by `aula preferences`.');
  }
  const { removed, preferences } = removePreference(index);
  console.log(`Forgotten: "${removed}"\n${preferences.length} preference(s) left.`);
  return 0;
}

function openInBrowser(target: string): void {
  Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', target]);
}

function renderCacheStats(stats: CacheStats): string {
  const byNamespace = Object.entries(stats.byNamespace).sort((a, b) => b[1] - a[1]);
  return [
    `Cache file:  ${stats.path}`,
    `TTL:         ${Math.round(stats.ttlMs / 1000)}s`,
    `Live entries: ${stats.entries} (${(stats.bytes / 1024).toFixed(0)} KiB on disk)`,
    ...byNamespace.map(([name, count]) => `  ${String(count).padStart(4)}  ${name}`),
  ].join('\n');
}

/** `--cache-ttl` in seconds; `$AULA_CACHE_TTL` is the same thing for the skill. */
function parseCacheTtl(raw: string | undefined): number {
  const value = raw ?? process.env.AULA_CACHE_TTL;
  if (value === undefined) return DEFAULT_TTL_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new UsageError(`--cache-ttl must be a number of seconds (got "${value}").`);
  }
  return seconds * 1000;
}

// --------------------------------------------------------- groups & contacts

type ContactRow = BirthdayContact & { group: string; groupId: number };

/** Pages the contact list, which is 1-based and stops on an empty page. */
async function collectContacts(
  client: AulaClient,
  groupId: number,
  role: string,
): Promise<Contact[]> {
  const collected: Contact[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await client.getContactList({ groupId, filter: role, page });
    if (batch.length === 0) break;
    collected.push(...batch);
  }
  return collected;
}

async function loadContacts(
  client: AulaClient,
  family: Family,
  opts: { child?: string; groupId?: number; role: string },
): Promise<ContactRow[]> {
  let targets: Array<{ id: number; name: string }>;
  if (opts.groupId !== undefined) {
    targets = [{ id: opts.groupId, name: `group ${opts.groupId}` }];
  } else {
    const children = selectChildren(family, opts.child);
    const groups = await loadGroups(client, children);
    targets = groups
      .filter((g): g is ChildGroups & { classGroupId: number } => g.classGroupId !== null)
      .map((g) => ({ id: g.classGroupId, name: g.className ?? `group ${g.classGroupId}` }));
    if (targets.length === 0) {
      throw new UsageError(
        `Could not work out a class group for ${children.map((c) => c.name).join(', ')}. ` +
          `Run \`groups\` to see what Aula reports, then pass --group <id>.`,
      );
    }
  }

  const rows: ContactRow[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    for (const contact of await collectContacts(client, target.id, opts.role)) {
      // Siblings in the same class, or a guardian listed for two children,
      // would otherwise appear once per group.
      const key = `${target.id}:${contact.profileId ?? contact.fullName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...contact, group: target.name, groupId: target.id });
    }
  }
  return rows;
}

// --------------------------------------------------------------- attachments

type ThreadAttachment = ResolvedAttachment & { from: string | null; at: string | null };

/** Every attachment in a thread, flattened in message order. */
function threadAttachments(detail: ThreadDetail): ThreadAttachment[] {
  const out: ThreadAttachment[] = [];
  for (const message of detail.messages ?? []) {
    for (const attachment of listAttachments(message.attachments)) {
      out.push({
        ...attachment,
        index: out.length,
        from: message.sender?.fullName ?? null,
        at: message.sendDateTime ?? null,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------- parsing

function requireId(raw: string | undefined, usage: string): number {
  const id = parseInteger(raw, { min: 1 });
  if (id === undefined) throw new UsageError(`Usage: ${usage} — the id must be a positive integer.`);
  return id;
}

function optionalInteger(
  raw: string | undefined,
  name: string,
  range: { min: number; max?: number },
): number | undefined {
  if (raw === undefined) return undefined;
  return requireInteger(raw, name, range);
}

function requireInteger(
  raw: string | undefined,
  name: string,
  range: { min: number; max?: number },
): number {
  const value = parseInteger(raw, range);
  if (value === undefined) {
    const upper = range.max === undefined ? '' : ` and at most ${range.max}`;
    throw new UsageError(`${name} must be an integer of at least ${range.min}${upper} (got "${raw ?? ''}").`);
  }
  return value;
}

function optionalIsoDate(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (!parseIsoDateParts(raw)) throw new UsageError(`${name} must be a real date in YYYY-MM-DD form (got "${raw}").`);
  return raw;
}

function parseContactRole(raw: string | undefined): 'child' | 'guardian' {
  if (raw === undefined || raw === 'child' || raw === 'guardian') return raw ?? 'child';
  throw new UsageError(`--role must be "child" or "guardian" (got "${raw}").`);
}

// ---------------------------------------------------------------- rendering

function renderWhoami(family: Family): string {
  const lines = [
    `Guardian: ${family.guardian.name} (${family.guardian.userId})`,
    `Session stepped up: ${family.isSteppedUp} ${family.isSteppedUp ? '' : '(sensitive threads will be unreadable)'}`,
    `MitID username: ${family.mitidUsername ?? 'not set (Meebook, Huskelisten and SkolePortal may refuse)'}`,
    '',
    'Children:',
    ...family.children.map(
      (c) =>
        `  ${c.name} [${c.shortName}] — ${c.institutionName} (institutionProfileId ${c.id}` +
        `${c.userId ? `, userId ${c.userId}` : ', no userId — widgets cannot see them'})`,
    ),
    '',
    'Institutions:',
    ...family.institutions.map(
      (i) => `  ${i.institutionName} (${i.institutionCode}) — ${i.groups.length} groups`,
    ),
    '',
    'Widgets:',
    ...(family.widgets.length === 0
      ? ['  (none exposed)']
      : family.widgets.map(
          (w) =>
            `  ${w.widgetId} ${w.name}` +
            `${w.capability ? ` — ${w.capability} via ${w.provider}` : ' — no integration'}`,
        )),
  ];
  return lines.join('\n');
}

type NormalThread = ReturnType<typeof normaliseThread> & {
  messages?: ReturnType<typeof normaliseMessage>[];
};

function renderThreads(threads: NormalThread[]): string {
  return threads
    .map((t) => {
      const flags = [t.unread ? 'UNREAD' : null, t.sensitive ? 'SENSITIVE' : null]
        .filter(Boolean)
        .join(' ');
      const head =
        `[${t.id}] ${formatWhen(t.lastMessageAt)} — ${t.subject}` +
        `${flags ? `  <${flags}>` : ''}` +
        `${t.regarding.length ? `  (re: ${t.regarding.join(', ')})` : ''}`;
      if (!t.messages) return `${head}\n    ${t.latestMessagePreview}`;
      const body = t.messages
        .map((m) => `    ${formatWhen(m.at)} ${m.from ?? 'unknown'}:\n${indent(m.text, 6)}`)
        .join('\n');
      return `${head}\n${body}`;
    })
    .join('\n\n');
}

function renderThreadDetail(thread: {
  id: number;
  subject: string;
  sensitive: boolean;
  messages: ReturnType<typeof normaliseMessage>[];
}): string {
  const head = `[${thread.id}] ${thread.subject}${thread.sensitive ? '  <SENSITIVE>' : ''}`;
  const body = thread.messages
    .map((m) => {
      const attachments = m.attachments.length
        ? `\n${indent(m.attachments.map((a) => `attachment: ${a.name}`).join('\n'), 4)}`
        : '';
      return `  ${formatWhen(m.at)} ${m.from ?? 'unknown'}:\n${indent(m.text, 4)}${attachments}`;
    })
    .join('\n\n');
  return `${head}\n\n${body}`;
}

function renderPosts(posts: ReturnType<typeof normalisePost>[]): string {
  return posts
    .map((p) => {
      const attachments = p.attachments.length
        ? `\n    attachments: ${p.attachments.map((a) => a.name).join(', ')}`
        : '';
      return (
        `[${p.id}] ${formatWhen(p.publishedAt)} — ${p.title}${p.important ? '  <IMPORTANT>' : ''}\n` +
        `    by ${p.author ?? 'unknown'}${p.groups.length ? ` → ${p.groups.join(', ')}` : ''}\n` +
        `${indent(p.text, 4)}${attachments}`
      );
    })
    .join('\n\n');
}

function renderAlbums(albums: ReturnType<typeof normaliseAlbum>[]): string {
  if (albums.length === 0) return '(no albums in window)';
  return albums
    .map((a) => {
      const by = [a.author ?? 'unknown', a.groups.join(', ') || a.institution]
        .filter(Boolean)
        .join(' → ');
      return (
        `[${a.id}] ${formatDate(a.createdAt)} — ${a.title}\n` +
        `    by ${by}` +
        (a.description ? `\n${indent(a.description, 4)}` : '')
      );
    })
    .join('\n');
}

function renderCalendar(events: ReturnType<typeof normaliseEvent>[]): string {
  if (events.length === 0) return '(no events in window)';
  return events
    .map((e) => {
      const when = e.allDay ? `${formatDate(e.start)} (all day)` : formatWhen(e.start);
      const response = e.responseRequired ? `  <needs answer: ${e.responseStatus ?? 'none'}>` : '';
      return (
        `${when} — ${e.title}${response}\n` +
        `    ${[e.children.join(', '), e.location, e.institution].filter(Boolean).join(' · ')}`
      );
    })
    .join('\n');
}

function renderPresence(rows: ReturnType<typeof normalisePresence>[]): string {
  if (rows.length === 0) return '(no presence data — the institution may not use komme/gå)';
  return rows
    .map(
      (r) =>
        `${r.child} — ${r.statusDanish} (${r.status})${r.location ? ` @ ${r.location}` : ''}` +
        `${r.checkInTime ? ` (in ${r.checkInTime}${r.checkOutTime ? `, out ${r.checkOutTime}` : ''})` : ''}` +
        `${r.exitWith ? `\n  picked up by: ${r.exitWith}` : ''}` +
        `${r.comment ? `\n  note: ${r.comment}` : ''}`,
    )
    .join('\n');
}

function renderSchedule(schedule: ReturnType<typeof normaliseSchedule>): string {
  if (schedule.days.length === 0) {
    return `(no komme/gå templates registered between ${schedule.window.from} and ${schedule.window.to})`;
  }
  return schedule.days
    .map((d) => {
      const times = [d.entryTime, d.exitTime].filter(Boolean).join(' – ') || 'no times';
      const extra = [d.henteform, d.exitWith && `with ${d.exitWith}`, d.comment]
        .filter(Boolean)
        .join(' · ');
      return `${d.date ?? 'unknown date'}  ${d.child ?? 'unknown child'}: ${times}${extra ? `  (${extra})` : ''}`;
    })
    .join('\n');
}

function renderContacts(contacts: ContactRow[]): string {
  if (contacts.length === 0) return '(no contacts shared for this group)';
  return contacts
    .map((c) => {
      const details = [c.mobilePhone, c.homePhone, c.email].filter(Boolean).join(' · ');
      const relations = (c.relations ?? []).map((r) => r.name).filter(Boolean).join(', ');
      return (
        `${c.fullName ?? 'unknown'} — ${c.group}${c.birthday ? `  (b. ${c.birthday})` : ''}\n` +
        `${details ? `    ${details}\n` : ''}` +
        `${relations ? `    related: ${relations}\n` : ''}`
      ).trimEnd();
    })
    .join('\n');
}

function renderPlans(plans: WeekPlan[]): string {
  if (plans.length === 0) return '(no weekly-plan provider available)';
  return plans
    .map((plan) => {
      const head = `${plan.capability} — ${plan.provider} (widget ${plan.widgetId}), week ${plan.isoWeek}`;
      const warnings = (plan.warnings ?? []).map((w) => `  ! ${w}`).join('\n');
      if (plan.items.length === 0) {
        // "Nothing published" and "the vendor refused to answer" are the same
        // shape on the wire and must never read the same on the page. Saying
        // the week is empty when the fetch failed is how an answer like "der er
        // ingen ugeplan for uge 33" gets given about a week that contains
        // "husk skiftetøj og badeting".
        return warnings
          ? `${head}\n  COULD NOT BE READ — the vendor did not answer. ` +
            `This is NOT an empty week; the plan may contain items.\n${warnings}`
          : `${head}\n  (nothing published — the vendor answered, the week is genuinely empty)`;
      }
      // Grouped by child, then by the vendor's own date label — the shape a
      // parent reads it in, rather than the flat list the APIs return.
      const byChild = new Map<string, typeof plan.items>();
      for (const item of plan.items) {
        const key = item.childName ?? 'everyone';
        const bucket = byChild.get(key);
        if (bucket) bucket.push(item);
        else byChild.set(key, [item]);
      }
      const body = [...byChild.entries()]
        .map(([child, items]) => {
          const lines = items
            .map((item) => {
              const heading = [item.date, item.subject, item.title].filter(Boolean).join(' · ');
              const content = item.content ? indent(item.content, 6) : '';
              return `    ${heading || item.kind || 'item'}${content ? `\n${content}` : ''}`;
            })
            .join('\n');
          return `  ${child}\n${lines}`;
        })
        .join('\n\n');
      return `${head}\n${body}${warnings ? `\n${warnings}` : ''}`;
    })
    .join('\n\n');
}

function renderDigest(digest: Awaited<ReturnType<typeof buildDigest>>): string {
  const a = digest.attention;
  const sections = [
    `Aula digest — last ${digest.window.days} days (generated ${formatWhen(digest.generatedAt)})`,
    `Children: ${digest.family.children.map((c) => `${c.name} (${c.institution})`).join(', ')}` +
      (digest.scope.child ? `  <narrowed to --child ${digest.scope.child}>` : ''),
    '',
    'NEEDS ATTENTION',
    `  Unread threads: ${a.unreadThreads.length}`,
    ...a.unreadThreads.map((t) => `    - [${t.id}] ${t.subject}`),
    `  Awaiting calendar response: ${a.eventsAwaitingResponse.length}`,
    ...a.eventsAwaitingResponse.map((e) => `    - ${formatWhen(e.start)} ${e.title}`),
    `  Important posts: ${a.importantPosts.length}`,
    ...a.importantPosts.map((p) => `    - [${p.id}] ${p.title}`),
    '',
    `THREADS (${digest.threads.length})`,
    renderThreads(digest.threads),
    '',
    `POSTS (${digest.posts.length})`,
    renderPosts(digest.posts),
    '',
    `CALENDAR (${digest.calendar.length})`,
    renderCalendar(digest.calendar),
    '',
    `PRESENCE TODAY (${digest.presence.length})`,
    renderPresence(digest.presence),
    '',
    `WEEKLY PLANS — week ${digest.week}`,
    renderPlans(digest.weeklyPlans),
  ];
  return sections.join('\n');
}

// ------------------------------------------------------------------- helpers

function renderBrief(result: {
  html: string;
  pdf: string | null;
  png: string | null;
  layout: string;
  deployed: string | null;
  complete: boolean;
  topline: string | null;
  signals: number;
  hidden: number;
  notes: string[];
}): string {
  const lines = [
    result.topline ?? '(ingen topline)',
    '',
    `${result.signals} punkt(er) vist, ${result.hidden} skjult efter jeres ønsker — layout: ${result.layout}`,
    `HTML: ${result.html}`,
  ];
  if (result.pdf) lines.push(`PDF:  ${result.pdf}`);
  if (result.png) lines.push(`PNG:  ${result.png}`);
  if (result.deployed) lines.push(`Delt: ${result.deployed}`);
  if (result.notes.length) lines.push('', ...result.notes.map((n) => `! ${n}`));
  if (!result.complete) lines.push('! Ufuldstændig kørsel — planlæggerens næste forsøg gør det om.');
  return lines.join('\n');
}

function emit<T>(value: T, asText: boolean, render: (value: T) => string): number {
  console.log(asText ? render(value) : JSON.stringify(value, null, 2));
  return 0;
}

/**
 * Fælles Filer filters on institution *codes*, not on any of the profile ids —
 * a fourth addressing scheme on top of the three in API.md.
 */
async function collectCommonFiles(
  client: AulaClient,
  family: Family,
  limit?: number,
): Promise<NormalCommonFile[]> {
  const collected: CommonFile[] = [];
  const pageSize = 50;
  for (let index = 0; index < 500; index += pageSize) {
    const page = await client.getCommonFiles({
      institutionCodes: family.institutionCodes,
      index,
      limit: pageSize,
    });
    collected.push(...page.commonFiles);
    if (collected.length >= page.totalAmount || page.commonFiles.length === 0) break;
  }
  const normalised = collected.map(normaliseCommonFile);
  // Newest first: the shelf is dominated by years-old policy documents, and the
  // thing being looked for is almost always what was added most recently.
  normalised.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  return limit ? normalised.slice(0, limit) : normalised;
}

function renderCommonFiles(files: NormalCommonFile[]): string {
  if (files.length === 0) return '(no shared files)';
  return files
    .map((f) => {
      const flags = f.status && f.status !== 'available' ? `  <${f.status}>` : '';
      return (
        `[${f.id}] ${formatDate(f.created)} — ${f.title}${flags}\n` +
        `    ${[f.filename, f.institution, f.uploadedBy].filter(Boolean).join(' · ')}` +
        (f.groups.length ? `\n    groups: ${f.groups.join(', ')}` : '')
      );
    })
    .join('\n');
}

/** `APP` is the MitID app; `CODE_TOKEN` is the physical kodeviser. */
function parseAuthMethod(raw: string | undefined): 'APP' | 'CODE_TOKEN' {
  const value = (raw ?? 'APP').toUpperCase();
  if (value === 'APP' || value === 'CODE_TOKEN') return value;
  throw new UsageError(`Unknown --method "${raw}". Use APP (default) or CODE_TOKEN.`);
}

// ----------------------------------------------------------------------- run

/**
 * One shape for every failure a user is meant to read: a marked, bold headline
 * on its own line, and everything the message says after that indented beneath
 * it. The indent is what makes a wall of stderr scannable — the reader can see
 * where the problem starts without reading it first.
 *
 * Nothing is re-wrapped here. Messages built from a `Remedy` are already set to
 * the terminal width, and re-flowing the rest would join lines their authors
 * broke on purpose.
 */
function reportProblem(message: string): void {
  const [headline = '', ...rest] = message.split('\n');
  console.error(`${fmt.red('✗')} ${fmt.bold(headline)}`);
  for (const line of rest) console.error(line === '' ? '' : `  ${line}`);
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    reportProblem(err.message);
    process.exitCode = 1;
  } else if (
    err instanceof AulaAuthError ||
    err instanceof AulaSessionError ||
    // The vendored login flow's own hierarchy — a failed refresh-stepup or
    // token refresh is a credentials problem, not a bug, so no stack trace.
    err instanceof AulaAuthFlowError
  ) {
    reportProblem(err.message);
    process.exitCode = 2;
  } else if (err instanceof AulaApiError) {
    // No "Aula API error:" prefix any more. It labelled the failure without
    // saying anything about it, and it pushed the part worth reading — which
    // is now a plain-language headline — into the middle of the line.
    reportProblem(err.message);
    process.exitCode = 3;
  } else {
    // An unexpected error is a bug in this client, so the stack is the useful
    // part and it is printed raw rather than dressed up as advice.
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
} finally {
  // Written once, here, rather than per response: flat-cache keeps the whole
  // file in memory and rewrites it whole, so saving on every `set` would cost
  // more than the requests it saves. Also runs after a failure, so a command
  // that died halfway still banks what it did manage to fetch.
  flushCache();
}
