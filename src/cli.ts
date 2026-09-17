#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { downloadAttachment, listAttachments, type ResolvedAttachment } from './attachments.ts';
import {
  type CliCommand,
  isCliCommand,
  optionsFor,
  parseCommandLine,
  usageFor,
} from './cli-options.ts';
import {
  type BirthdayContact,
  commonFileUrl,
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
import {
  calendarWindow,
  CalendarNotConnectedError,
  listCalendars,
  loadPersonalEvents,
} from './calendar/index.ts';
import {
  calendarChoices,
  type CalendarChoice,
  CalendarSelectionError,
  resolveCalendarSelection,
  resolveConfiguredSelection,
} from './calendar/selection.ts';
import { AulaAuthError, AulaClient, AulaMethodError, CALENDAR_MAX_SPAN_DAYS } from './client.ts';
import { briefSlots, readConfig, updateConfig } from './config.ts';
import { contractSlice } from './contract.ts';
import {
  buildDigest,
  collectAlbums,
  collectPosts,
  collectThreads,
  type ChildGroups,
  findPost,
  type FullThreadDetail,
  loadCalendar,
  loadGroups,
  normaliseAlbum,
  normaliseEvent,
  normaliseMessages,
  type NormalMessage,
  normalisePost,
  normalisePresence,
  normaliseThread,
  readManyPlans,
  readPlans,
  readFullThread,
  withFullMessages,
} from './digest.ts';
import { BRIEF_TITLE, runBrief } from './brief/index.ts';
import {
  clearExtractionCache,
  extractionCacheStats,
  type ExtractionCacheStats,
} from './brief/llm.ts';
import { overviewWindow } from './brief/dates.ts';
import { deployArtifact, readTarget, setTarget } from './brief/deploy.ts';
import { explain } from './brief/rank.ts';
import { cmd } from './runtime.ts';
import { ClaudeMissingError } from './llm/claude.ts';
import { BRIEF_DIR, loadState, recordDeploy, saveState, slotIsComplete } from './brief/state.ts';
import { runDoctor } from './doctor.ts';
import {
  CliError,
  ensureErrorLine,
  errorLineFor,
  EXIT,
  failWith,
  firstLineOf,
  UsageError,
} from './errors.ts';
import { fmt, openInBrowser, toJson } from './io.ts';
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
import { parseSkillTarget, runInstallSkill } from './install-skill.ts';
import { buildVersion } from './runtime.ts';
import { runSchedule } from './schedule.ts';
import { recordSessionSeen } from './session-seen.ts';
import { coordinateScheduledBrief } from './scheduled-brief.ts';
import { currentSlotStart } from './slots.ts';
import { NoProviderError, SUPPORTED_WIDGET_IDS, type WeekPlan } from './integrations/index.ts';
import { addLocalDays, isoDate, localIsoDate } from './integrations/types.ts';
import type { CommonFile, Contact, ThreadDetail } from './types.ts';
import { errorMessage, parseInteger, parseIsoDateParts } from './validation.ts';
import { type Capability, WidgetError } from './widgets.ts';

/** Upper bound on `--days` where no endpoint imposes its own — a year of history. */
const MAX_HISTORY_DAYS = 365;

/**
 * How many rows `messages`, `posts` and `galleries` return when the caller
 * bounded the read with neither `--limit` nor `--since`.
 */
const DEFAULT_LIST_LIMIT = 20;

const USAGE = `
aula — your kids' school and daycare, read from Aula (aula.dk)

Usage: aula <command> [options]

Everyday:
  new                          Generate today's AI overview — the local page and,
                               where configured, the hosted copy — then open it
  open                         Open the newest overview without regenerating
  open --web                   Open the hosted copy instead (readable anywhere)
  publish                      Keep a hosted copy, readable on a phone: publishes
                               the newest page as a private artifact and redeploys
                               to it on every run from then on
  publish --off                Stop updating the hosted copy and forget its URL
  calendars                    Your own calendars, with the ones the overview
                               reads marked — appointments from them show up
                               beside the school's own events
  calendars set <name> [...]   Read exactly these, by displayed name
  calendars set none           Read none of them
  schedule [--at HH:MM,...]    Generate the overview automatically every day at
                               06:00 and 18:00, catching up within minutes of a
                               wake if the machine was off or asleep
  schedule --remove            Stop generating it automatically
  remember "<ønske>"           Teach the overview what matters to you — a sender
                               to always highlight, something you never need
  preferences                  Everything it has been told to remember
  preferences reset            Back to the preferences aula-cli ships with
  forget <n>                   Drop preference number n
  login                        Log in with MitID (tokens refresh themselves)
  logout                       Forget the stored login
  status                       Whether you are logged in, and for how much longer
  install-skill [claude|codex] Teach your agent to use this tool, then open a
                               new session (--out <dir> to write elsewhere)
  version                      Which build this is, and for which platform
  --contract                   This tool's slice of the fleet's shared contract:
                               its exit codes and which of them carry a body

Options for new:
  --days <n>                   How much history to read (default 60)
  --no-open                    Do not open the page (a pipe or scheduler never opens)
  --no-llm                     Danish rules only — skip the model calls
  --no-deploy                  Do not update the hosted copy this run
  --catch-up                   Do nothing if this slot's overview is already complete
                               (every scheduled trigger passes this)
  --explain                    Print model priority, date placement and sources
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
  attachments <threadId>       List a thread's attachments, each with its index
  attachment <threadId> [n]    Download attachment n of a thread (default 0)
  post-attachment <postId> [n] Download attachment n of a post (default 0)
  commonfiles / commonfile <x> "Fælles Filer" — the shared shelf / download one
  widgets                      Which vendor widgets these schools expose
  weekly-plan / weekly-letter  Weekly plan / weekly letter, whichever vendor
  tasks / assignments / reminders / homework
                               Homework, per vendor and combined
  refresh-stepup               Restore step-up so sensitive threads read again
  scheduled-run                What the schedule starts: waits through sleep,
                               then generates the overview if this slot needs one
  doctor                       Call every endpoint and report status + timing
  cache status|clear           Inspect or drop the response cache
  raw <method> [k=v ...]       Any un-wrapped Aula read method

  Their options: --text --limit <n> --since <7d|2026-08-01> --child <name|id>
  --days <n> --full --unread --important --week <2026-W33> --next --page <n>
  --widget <id> --group <id> --role <child|guardian> --out <path>
  --from <date> --to <date> --no-cache --cache-ttl <seconds>

  Each command takes only the options it acts on, and refuses the rest rather
  than ignoring them; \`aula <command> --help\` is that list. \`doctor\` always
  bypasses the cache, so it accepts neither --no-cache nor --cache-ttl.

Login options:
  --debug                      Write a sanitised wire transcript during login
  --no-open                    Print the login page's address without opening a
                               browser (the page is still where you log in)

Examples:
  aula new
  aula remember "beskeder fra John (Hjaltes far) er altid vigtige"
  aula open --web
  aula digest --days 14 --text
  aula messages --limit 30 --full --since 30d
  aula weekly-plan --next --text
`.trim();

// ---------------------------------------------------------------- entrypoint

/** Build and platform, so a bug report says which binary produced it. */
function versionLine(): string {
  return `aula ${buildVersion()} (${process.platform}-${process.arch})`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  // `--version` before command parsing: it is what someone types to find out
  // which build they have, and that has to answer even when nothing else does.
  if (command === '--version' || command === '-v') {
    console.log(versionLine());
    return 0;
  }

  // Beside `--version` for the same reason: it is a question about the tool,
  // so it has to answer with no login, no network and no command. Every
  // sibling answers it; here it was `Unknown command "--contract"`, exit 2.
  if (command === '--contract') {
    console.log(toJson(contractSlice()));
    return 0;
  }

  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  if (!command || command === 'help' || (wantsHelp && !isCliCommand(command))) {
    console.log(USAGE);
    return 0;
  }
  if (!isCliCommand(command))
    throw new UsageError(`Unknown command "${command}". Run \`${cmd('--help')}\`.`);
  if (wantsHelp) {
    console.log(commandHelp(command));
    return 0;
  }

  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(command, argv.slice(1));
  } catch (err) {
    throw new UsageError(
      `${errorMessage(err)}\nRun \`${cmd('--help')}\` for the commands and options.`,
    );
  }
  const { values, positionals } = parsed;

  const asText = values.text === true;
  const limit = optionalInteger(values.limit, '--limit', { min: 1 });
  // The 50-day ceiling belongs to Aula's calendar endpoint, not to history
  // reads in general. `doctor` forwards the requested range to that endpoint,
  // while digest/new cap only their calendar slice and may still read a longer
  // history for messages and posts.
  const readsOnlyCalendarRange = command === 'calendar' || command === 'doctor';
  const maxDays = readsOnlyCalendarRange ? CALENDAR_MAX_SPAN_DAYS : MAX_HISTORY_DAYS;
  const daysOption = optionalInteger(values.days, '--days', { min: 1, max: maxDays });
  const days = daysOption ?? 14;
  const page = optionalInteger(values.page, '--page', { min: 0 });
  const groupId = optionalInteger(values.group, '--group', { min: 1 });
  const fromDate = optionalIsoDate(values.from, '--from');
  const toDate = optionalIsoDate(values.to, '--to');
  const contactRole = parseContactRole(values.role);
  const threadId =
    command === 'thread' || command === 'attachments' || command === 'attachment'
      ? requireId(positionals[0], `${command} <threadId>`)
      : undefined;
  // The index is optional and defaults to the first attachment, which is the
  // only one most threads have.
  const attachmentIndex =
    command === 'attachment'
      ? requireInteger(positionals[1] ?? '0', 'attachment index', { min: 0 })
      : undefined;
  if (fromDate && toDate && fromDate > toDate) {
    throw new UsageError(`--from (${fromDate}) must not be after --to (${toDate}).`);
  }
  const since = values.since ? parseSince(values.since) : undefined;
  // A `--since` window is a bound of its own. The default cap used to apply on
  // top of it, so the skill's own `messages --full --since 30d` answered with
  // the newest 20 threads of a month and no sign that the rest existed — a
  // busy class loses the very message being asked about.
  const listLimit = limit ?? (since ? undefined : DEFAULT_LIST_LIMIT);
  const week = resolveWeek(values.week, values.next === true);
  const ttlMs = parseCacheTtl(values['cache-ttl']);

  if (command === 'cache') return runCache(positionals, asText, ttlMs);
  if (command === 'open') return runOpen(values.web === true);
  if (command === 'publish') return runPublish(values.off === true);
  // No Aula login needed: this reads the user's own calendars, not the school's.
  if (command === 'calendars') return await runCalendars(positionals);
  if (command === 'remember') return runRemember(positionals);
  if (command === 'preferences') return runPreferences(positionals);
  if (command === 'forget') return runForget(positionals[0]);
  // The scheduler's retries and its wake-up heartbeat: a slot that already
  // went right costs nothing, not even a login check — this is answered from
  // the state file alone. Deliberately `slotIsComplete` and not
  // `slotIsSettled`: a spent retry window is the coordinator's business, and
  // when it decides an attempt is warranted this must not refuse it.
  if (command === 'new' && values['catch-up'] === true) {
    const state = loadState();
    if (slotIsComplete(state, currentSlotStart(new Date(), briefSlots()))) {
      return emit({ skipped: true, lastRun: state.lastRun ?? null }, asText, (r) => {
        const at = r.lastRun ? new Date(r.lastRun.at) : null;
        const when = at
          ? at.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })
          : '';
        return `Oversigten er allerede opdateret${when ? ` (kl. ${when})` : ''} — intet at gøre.`;
      });
    }
  }
  if (command === 'version') {
    console.log(versionLine());
    return 0;
  }
  if (command === 'install-skill') {
    return runInstallSkill(parseSkillTarget(positionals[0]), values.out);
  }
  // The scheduler's own entry point: waits through sleep, then runs the brief.
  if (command === 'scheduled-run') {
    const outcome = await coordinateScheduledBrief();
    if (outcome.status === 'complete') return EXIT.OK;
    // Nobody reads this at a terminal — launchd runs it — but the log it lands
    // in is what somebody opens when the overview did not turn up.
    return failWith({
      code: 'UPSTREAM',
      message:
        `The scheduled overview did not complete after ${outcome.attempts} attempt(s) ` +
        `(${outcome.status}).`,
      hint: `Run \`${cmd('new')}\` to see what is failing.`,
    });
  }
  if (command === 'schedule') {
    return runSchedule({ remove: values.remove === true, ...(values.at ? { at: values.at } : {}) });
  }
  if (command === 'login') {
    return runLogin({ debug: values.debug === true, noOpen: values['no-open'] === true });
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
      const read = await collectThreads(client, {
        unreadOnly: values.unread === true,
        family,
        ...(listLimit !== undefined ? { limit: listLimit } : {}),
        ...(since ? { since } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      const threads: NormalThread[] = values.full
        ? await withFullMessages(client, read.rows)
        : read.rows.map(normaliseThread);
      return emitList(
        'threads',
        threads,
        { truncated: read.truncated, limit: listLimit, fetchedAt: client.dataFetchedAt() },
        asText,
        renderThreads,
      );
    }

    case 'thread': {
      if (threadId === undefined) throw new Error('thread id was not validated');
      const detail =
        page === undefined
          ? await readFullThread(client, threadId)
          : await client.getThread(threadId, page);
      const result = {
        id: detail.id,
        subject: detail.subject ?? '(no subject)',
        sensitive: detail.sensitive,
        startedAt: detail.threadStartedDateTime,
        totalMessageCount: detail.totalMessageCount,
        moreMessagesExist: detail.moreMessagesExist,
        messagesIncomplete: page === undefined ? Boolean(detail.moreMessagesExist) : null,
        messageReadWarning:
          page === undefined && 'warning' in detail && typeof detail.warning === 'string'
            ? detail.warning
            : null,
        participants: (detail.recipients ?? []).map((r) => r.fullName).filter(Boolean),
        // Attachment positions count from the thread's first message, so they
        // are only known when every message is here: not for one `--page`, and
        // not for a read that lost a page.
        messages: normaliseMessages(detail.messages, {
          wholeThread: page === undefined && !detail.moreMessagesExist,
        }),
      };
      return emit(result, asText, (r) => renderThreadDetail(r));
    }

    case 'posts': {
      const family = await resolveFamily(client);
      const read = await collectPosts(client, family, {
        important: values.important === true,
        ...(listLimit !== undefined ? { limit: listLimit } : {}),
        ...(since ? { since } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      return emitList(
        'posts',
        read.rows,
        { truncated: read.truncated, limit: listLimit, fetchedAt: client.dataFetchedAt() },
        asText,
        renderPosts,
      );
    }

    case 'galleries': {
      const family = await resolveFamily(client);
      const read = await collectAlbums(client, family, {
        ...(listLimit !== undefined ? { limit: listLimit } : {}),
        ...(since ? { since } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      return emitList(
        'albums',
        read.rows,
        { truncated: read.truncated, limit: listLimit, fetchedAt: client.dataFetchedAt() },
        asText,
        renderAlbums,
      );
    }

    case 'calendar': {
      const family = await resolveFamily(client);
      const events = await loadCalendar(client, family, {
        days,
        ...(values.child ? { child: values.child } : {}),
      });
      return emitRows(events, asText, renderCalendar);
    }

    case 'presence': {
      const family = await resolveFamily(client);
      const children = selectChildren(family, values.child);
      const entries = await client.getDailyPresence(children.map((c) => c.id));
      return emitRows(entries.map(normalisePresence), asText, renderPresence);
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
      return emitRows(grouped, asText, (rows) =>
        rows.map((r) => `${r.area}/${r.type}${r.child ? ` — ${r.child}` : ''}`).join('\n'),
      );
    }

    case 'pickup-times': {
      const family = await resolveFamily(client);
      const children = selectChildren(family, values.child);
      const from = fromDate ?? isoDate(startOfDay(new Date()));
      const to = toDate ?? isoDate(addLocalDays(new Date(), days));
      const templates = await client.getPresenceTemplates({
        childInstitutionProfileIds: children.map((c) => c.id),
        fromDate: from,
        toDate: to,
      });
      const result = normaliseSchedule(templates, { from, to });
      return emit(result, asText, renderSchedule, result.days.length === 0);
    }

    case 'groups': {
      const family = await resolveFamily(client);
      const children = selectChildren(family, values.child);
      const result = await loadGroups(client, children);
      return emit(
        result,
        asText,
        (rows) =>
          rows
            .map(
              (r) =>
                `${r.child}${r.className ? ` — class ${r.className} (group ${r.classGroupId})` : ''}\n` +
                indent(r.groups.map((g) => `${g.name} (${g.id})`).join('\n') || '(no groups)', 4),
            )
            .join('\n\n'),
        // A row per child is always there; what can be absent is the groups.
        result.every((row) => row.groups.length === 0),
      );
    }

    case 'contacts': {
      const family = await resolveFamily(client);
      const contacts = await loadContacts(client, family, {
        role: contactRole,
        ...(values.child ? { child: values.child } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
      });
      return emitRows(contacts, asText, renderContacts);
    }

    case 'birthdays': {
      const family = await resolveFamily(client);
      const contacts = await loadContacts(client, family, {
        role: 'child',
        ...(values.child ? { child: values.child } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
      });
      const all = upcomingBirthdays(contacts);
      const shown = limit === undefined ? all : all.slice(0, limit);
      const cut = {
        truncated: shown.length < all.length,
        limit,
        fetchedAt: client.dataFetchedAt(),
      };
      return emitList('birthdays', shown, cut, asText, (rows) =>
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
      // Always the whole thread. This took `--page`, and numbered what it found
      // on that page from zero — positions `attachment` would then resolve
      // against the full thread, downloading a different file without a word.
      const detail = await readFullThread(client, threadId);
      const found = describeThreadAttachments(detail);
      const result = {
        attachments: found,
        messagesIncomplete: detail.incomplete,
        messageReadWarning: detail.warning,
      };
      return emit(
        result,
        asText,
        (value) => {
          const rows = value.attachments;
          const body =
            rows.length === 0
              ? '(no attachments in this thread)'
              : rows
                  .map(
                    (a) =>
                      `[${a.index ?? '?'}] ${a.name} (${a.kind}) — from ${a.from ?? 'unknown'}`,
                  )
                  .join('\n');
          return value.messagesIncomplete
            ? `WARNING: not every message page was available (${value.messageReadWarning ?? 'unknown reason'}).\n${body}`
            : body;
        },
        // "No attachments" is only a fact about the thread once every message
        // has been read. A read that lost pages proves nothing about the rest.
        found.length === 0 && !detail.incomplete,
      );
    }

    case 'attachment': {
      if (threadId === undefined || attachmentIndex === undefined) {
        throw new Error('attachment positionals were not validated');
      }
      const detail = await readFullThread(client, threadId);
      if (detail.incomplete) {
        throw new CliError(
          'UPSTREAM',
          `Could not read every message in thread ${threadId}: ${detail.warning ?? 'unknown reason'}. ` +
            'Re-read the thread before choosing an attachment index.',
        );
      }
      const found = resolveThreadAttachments(detail);
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

    case 'post-attachment': {
      const postId = requireId(positionals[0], 'post-attachment <postId> [index]');
      const index = requireInteger(positionals[1] ?? '0', 'attachment index', { min: 0 });
      const family = await resolveFamily(client);
      const post = await findPost(client, family, postId);
      if (!post) {
        throw new UsageError(
          `No post ${postId} is visible to this login. \`${cmd('posts')}\` lists the ids.`,
        );
      }
      const found = listAttachments(post.attachments);
      const wanted = found[index];
      if (!wanted) {
        throw new UsageError(
          `Post ${postId} has ${found.length} attachment(s); there is no index ${index}.` +
            (found.length ? `\n${found.map((a) => `  [${a.index}] ${a.name}`).join('\n')}` : ''),
        );
      }
      if (wanted.kind === 'link') {
        throw new UsageError(`Attachment ${index} is a link, not a file: ${wanted.url}`);
      }
      const saved = await downloadAttachment({
        attachment: wanted,
        prefix: `post-${postId}-${index}`,
        ...(values.out ? { out: values.out } : {}),
      });
      return emit(saved, asText, (r) => `Saved ${r.filename} (${r.bytes} bytes) to ${r.path}`);
    }

    case 'commonfiles': {
      const family = await resolveFamily(client);
      const all = (await collectCommonFiles(client, family)).map(normaliseCommonFile);
      const files = limit === undefined ? all : all.slice(0, limit);
      const cut = {
        truncated: files.length < all.length,
        limit,
        fetchedAt: client.dataFetchedAt(),
      };
      return emitList('files', files, cut, asText, renderCommonFiles);
    }

    case 'commonfile': {
      const family = await resolveFamily(client);
      const ref = positionals[0];
      if (!ref) throw new UsageError('Usage: commonfile <id|text from the title>');
      const shelf = await collectCommonFiles(client, family);
      const wanted = selectCommonFile(shelf.map(normaliseCommonFile), ref);
      // The printed shape carries no URL, so it is read off the row Aula sent.
      const source = shelf.find((file) => file.id === wanted.id);
      const url = source ? commonFileUrl(source) : null;
      if (!url) {
        throw new UsageError(
          `"${wanted.title}" has no downloadable file` +
            (wanted.status && wanted.status !== 'available'
              ? ` — Aula reports its status as "${wanted.status}".`
              : '.'),
        );
      }
      const saved = await downloadAttachment({
        attachment: {
          index: 0,
          id: null,
          name: wanted.filename ?? wanted.title,
          url,
          kind: 'file',
        },
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
      return emitRows(result, asText, (rows) =>
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

    case 'weekly-plan':
    case 'weekly-letter':
    case 'tasks':
    case 'assignments':
    case 'reminders': {
      const family = await resolveFamily(client);
      const capability: Capability = command;
      const plans = await readPlans(client, family, {
        capability,
        isoWeek: week,
        ...(values.child ? { child: values.child } : {}),
        ...(values.widget ? { widget: values.widget } : {}),
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      }).catch((err: unknown) => {
        // A school with no widget for this capability is an answer about the
        // school, read off the widget list Aula itself returned — most families
        // have one vendor out of five. It used to fall through to the "bug in
        // this client" branch: a stack trace at exit 1 for `weekly-letter` on
        // a school that simply does not use MinUddannelse.
        if (!(err instanceof NoProviderError)) throw err;
        console.error(err.message);
        return [];
      });
      return emitPlans(plans, asText);
    }

    case 'homework': {
      const family = await resolveFamily(client);
      const plans = await readManyPlans(client, family, ['tasks', 'assignments', 'reminders'], {
        isoWeek: week,
        ...(values.child ? { child: values.child } : {}),
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      });
      return emitPlans(plans, asText);
    }

    case 'raw': {
      const method = positionals[0];
      if (method === undefined) throw new Error('raw method was not validated');
      const result = await client
        .getRaw(method, parseKeyValues(positionals.slice(1)))
        .catch((err: unknown) => {
          // Here the caller typed the method name, so a name the read-only guard
          // refuses, or one Aula has never heard of, is a command line to fix.
          // Both used to leave as exit 1 — "a source is down, retry later" —
          // which is how an agent that had just asked this tool to send a
          // message was told to try again in a minute.
          if (err instanceof AulaMethodError) throw new UsageError(err.message);
          throw err;
        });
      // Never 4: what an unwrapped method returns has no shape this command
      // knows, so it cannot tell an empty answer from a small one.
      return emit(result, asText, (r) => JSON.stringify(r, null, 2));
    }

    case 'digest': {
      const digest = await buildDigest(client, {
        days,
        isoWeek: week,
        ...(limit !== undefined ? { limit } : {}),
        ...(values.child ? { child: values.child } : {}),
      });
      // `generatedAt` is when this payload was assembled; `fetchedAt` is when
      // the oldest response inside it was read from Aula. They were one field,
      // stamped now, on a digest that may have made no request at all.
      const { generatedAt, ...rest } = digest;
      const stamped = { generatedAt, fetchedAt: client.dataFetchedAt(), ...rest };
      return emit(stamped, asText, renderDigest);
    }

    case 'new': {
      const run = await runBrief(client, {
        // The brief reads further back than a digest: an old post can be the
        // only place a date stands. `HISTORY_DAYS` in collect.ts says how far,
        // and what an old post must carry to be admitted.
        ...(daysOption !== undefined ? { days: daysOption } : {}),
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
          layoutCached: run.layoutCached,
          deployed: run.deployment.status === 'ok' ? run.deployment.url : null,
          complete: run.complete,
          retryable: run.retryable,
          topline: run.topline,
          cards: run.brief.cards.length,
          hidden: run.brief.hidden.length,
          notes: run.notes,
        },
        asText,
        renderBrief,
      );
    }

    default:
      // `command` is `never` here: the switch above is exhaustive over the
      // declared commands, and this branch exists for the argv that got past
      // parsing anyway. String() is what makes that sayable.
      throw new UsageError(`Unknown command "${String(command)}".`, `Run \`${cmd('--help')}\`.`);
  }
}

// ------------------------------------------------------------------ commands

/**
 * What one command accepts, straight from the same table that enforces it —
 * so the help can never drift from what the parser will actually allow.
 */
function commandHelp(command: CliCommand): string {
  const options = optionsFor(command);
  return [
    `Usage: ${cmd(usageFor(command))}`,
    options.length > 0 ? `Options: ${options.join(' ')}` : 'Takes no options.',
    '',
    `Run \`${cmd('--help')}\` for every command.`,
  ].join('\n');
}

function runCache(positionals: string[], asText: boolean, ttlMs: number): number {
  const sub = positionals[0] ?? 'status';
  // Both caches, always. They are one thing to the reader — "what this would
  // answer from disk instead of fetching" — and clearing only the responses
  // left the model's stored layout to come straight back, which is exactly what
  // someone running this is trying to get rid of.
  if (sub === 'clear') {
    const responses = clearCache();
    const layouts = clearExtractionCache();
    return emit(
      {
        cleared: responses || layouts,
        responses: { cleared: responses, path: CACHE_PATH },
        layouts: { cleared: layouts, path: extractionCacheStats().path },
      },
      asText,
      (r) =>
        r.cleared
          ? [
              r.responses.cleared ? `Cleared ${r.responses.path}.` : null,
              r.layouts.cleared ? `Cleared layouts in ${r.layouts.path}.` : null,
            ]
              .filter((line): line is string => line !== null)
              .join('\n')
          : 'Nothing was cached.',
    );
  }
  if (sub === 'status') {
    return emit(
      { responses: cacheStats({ ttlMs }), layouts: extractionCacheStats() },
      asText,
      renderCacheStats,
    );
  }
  // A usage error like any other mistyped argument. It printed its own line and
  // returned 1, which the fleet reads as "a source is down, retry later".
  throw new UsageError(`Unknown cache subcommand "${sub}". Usage: ${cmd(usageFor('cache'))}`);
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
      // 5, not 1. Exit 1 says "a source is down, retry later", and no retry
      // configures a hosted copy; "setup required — do not retry unchanged" is
      // what this is.
      throw new CliError(
        'SETUP',
        'No hosted copy is configured.',
        `\`${cmd('publish')}\` sets one up; \`${cmd('open')}\` shows the local page.`,
      );
    }
    // Same courtesy as the local page below: say when the link is stale rather
    // than let a day-old brief read as today's.
    const deploy = loadState().lastDeploy;
    if (deploy && deploy.url === url && deploy.day !== localIsoDate(new Date())) {
      console.error(
        `The hosted copy was last updated ${deploy.day} — \`${cmd('new')}\` refreshes it.`,
      );
    }
    openInBrowser(url);
    console.log(url);
    return 0;
  }

  const path = join(BRIEF_DIR, 'latest.html');
  if (!existsSync(path)) {
    throw new CliError(
      'SETUP',
      `No overview found at ${path}.`,
      `Run \`${cmd('new')}\` to generate one.`,
    );
  }
  const day = localIsoDate(new Date(statSync(path).mtimeMs));
  const today = localIsoDate(new Date());
  if (day !== today) {
    console.error(`The newest overview is from ${day} — \`${cmd('new')}\` generates today's.`);
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
async function runPublish(off: boolean): Promise<number> {
  const target = readTarget();
  if (off) {
    setTarget(null);
    console.log(
      target
        ? `The hosted copy is off — ${target} will not be updated again.`
        : 'No hosted copy was configured.',
    );
    return 0;
  }
  const artifactPath = join(BRIEF_DIR, 'artifact.html');
  if (!existsSync(artifactPath)) {
    throw new CliError(
      'SETUP',
      'No overview to publish yet.',
      `Run \`${cmd('new')}\` first, then \`${cmd('publish')}\`.`,
    );
  }

  console.error(
    target
      ? `Redeploying the newest overview to ${target}…`
      : 'Publishing the newest overview as a new artifact (private to your claude.ai account)…',
  );
  const result = await deployArtifact(artifactPath, { title: BRIEF_TITLE, create: !target });
  if (result.status !== 'ok') {
    throw new CliError('UPSTREAM', `Publishing failed: ${result.reason}`);
  }
  // Saved only after a deploy that worked — the URL is only known from the reply.
  if (!target) setTarget(result.url);
  const state = loadState();
  recordDeploy(state, result.url);
  saveState(state);
  console.error(
    `Every \`${cmd('new')}\` (and the schedule) keeps it current; \`${cmd('publish --off')}\` stops it.`,
  );
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
/**
 * `calendars` — which of the family's own calendars the overview reads.
 *
 * The point of this command is that for most people there is nothing to set
 * up. Where Google Calendar is connected in Claude, the calendars are already
 * there to be listed and the only question left is which ones matter; where it
 * is not, the answer is to connect it rather than to go hunting for a secret
 * URL in a settings page. Both are one command.
 *
 * Nothing is read until a calendar is named here. A clone of this repository
 * reads nobody's calendar, and the list lives in `~/.aula/config.json` with the
 * rest of the per-installation preferences.
 */
async function runCalendars(positionals: string[]): Promise<number> {
  const sub = positionals[0];
  const refs = positionals.slice(1);
  if (sub !== undefined && sub !== 'set') {
    throw new UsageError(`Unknown subcommand "${sub}". Usage: ${cmd(usageFor('calendars'))}`);
  }

  try {
    return sub === undefined ? await showCalendars() : await setCalendars(refs);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    // The observed reason comes first, then the cure. This block used to assert
    // "not connected" flatly, whatever `attemptTool` had actually seen — and
    // when the real cause was a race against the connector's own startup, it
    // sent somebody to Settings to connect a connector already sitting there
    // marked Connected. A wrong diagnosis stated confidently is worse than a
    // vague one: it spends the reader's time proving the tool wrong.
    if (err instanceof CalendarNotConnectedError) {
      console.error(
        [
          err.observed,
          '',
          'If it is not connected, connecting it is all there is to set up — it also',
          'reads calendars other people have shared with you, which a link cannot:',
          '',
          '  Claude  →  Settings  →  Connectors  →  Google Calendar  →  Connect',
          '',
          'If Claude already lists it as connected, `claude mcp list` says what the',
          'CLI itself can see; ANTHROPIC_API_KEY in the environment takes precedence',
          'over the claude.ai login and hides every connector.',
          '',
          `Then run \`${cmd('calendars')}\` again.`,
        ].join('\n'),
      );
      // 5, the fleet's "setup required — do not retry unchanged". This was 1,
      // which every sibling reads as "a source is down, retry later" — and an
      // agent looping the morning brief on a missing connector retries a state
      // that no amount of waiting changes. Nothing here is fixed except by a
      // person clicking Connect.
      return failWith({
        code: 'SETUP',
        message: firstLineOf(err.observed),
        hint:
          'If Google Calendar is not connected, the user connects it in Claude: ' +
          `Settings → Connectors → Google Calendar → Connect. Then run \`${cmd('calendars')}\` again.`,
      });
    }
    if (err instanceof CalendarSelectionError) {
      // 2: the name came off the command line and is wrong or ambiguous, which
      // is the definition of a usage error. It shared exit 1 with an outage.
      console.error(err.message);
      return failWith({
        code: 'USAGE',
        message: firstLineOf(err.message),
        hint: `\`${cmd('calendars')}\` lists the exact names.`,
      });
    }
    // Already a full remedy naming the dependency and how to install it —
    // prefixing it would bury the headline `doctor` and the skill read first.
    if (err instanceof ClaudeMissingError) {
      // 5 as well, and for the same reason: a missing program is still missing
      // on the next attempt. `claudeMissingRemedy` says as much in prose; the
      // exit code should not contradict it.
      console.error(err.message);
      return failWith({
        code: 'SETUP',
        message: firstLineOf(err.message),
        hint: 'Install Claude Code, then run the command again.',
      });
    }
    const message = `Could not ask Claude for your calendars: ${errorMessage(err)}`;
    console.error(message);
    return failWith({ code: 'UPSTREAM', message: firstLineOf(message), hint: 'Try again later.' });
  }
}

/** One live list, selected first; names and ids are stable across invocations. */
async function calendarList(): Promise<CalendarChoice[]> {
  const configured = readConfig().calendars ?? [];
  return calendarChoices(configured, await listCalendars());
}

/** Everything available, with the ones being read marked. */
async function showCalendars(): Promise<number> {
  const list = await calendarList();
  if (list.length === 0) {
    console.log('Google Calendar is connected, but it lists no calendars.');
    return 0;
  }

  const chosen = list.filter((c) => c.selected).length;
  console.log(
    [
      chosen > 0
        ? 'Your calendars — the overview reads the marked ones:'
        : 'Your calendars — the overview reads none of them yet:',
      '',
      ...list.map((calendar) => formatCalendarChoice(calendar, list)),
      '',
      '  aula calendars set "Familie" "Privat"   read exactly these names',
      ...(chosen > 0 ? ['  aula calendars set none            read none of them'] : []),
    ].join('\n'),
  );
  return 0;
}

function formatCalendarChoice(calendar: CalendarChoice, all: CalendarChoice[]): string {
  const duplicateName = all.some(
    (other) => other.id !== calendar.id && other.name === calendar.name,
  );
  const identity = duplicateName
    ? `${JSON.stringify(calendar.name)}  id: ${calendar.id}`
    : JSON.stringify(calendar.name);
  return `  ${calendar.selected ? '*' : ' '} ${identity}${relation(calendar.accessRole)}`;
}

/**
 * Whose calendar this is, when the connector says.
 *
 * It currently does not: `list_calendars` returns id, summary, description and
 * timeZone, and `accessRole` only comes back from `list_events`. Kept because
 * the distinction is worth showing the moment it is available — reading a
 * calendar somebody *else* shared is a large part of why this is the only
 * supported route: Google issues a feed URL for calendars you own and no
 * others, so the household's shared calendar is exactly what it cannot reach.
 */
function relation(accessRole: string | undefined): string {
  if (accessRole === 'owner') return '  (your own)';
  if (accessRole === 'writer') return '  (shared with you, you can edit)';
  if (accessRole === 'reader' || accessRole === 'freeBusyReader') return '  (shared with you)';
  return '';
}

/**
 * `set` states the whole answer: these calendars, and no others.
 *
 * It replaced `add` and `remove`, and the reason is that the caller is usually
 * an agent. Add-and-remove makes it compute a diff — read the list, compare it
 * against what is already selected, work out which way each one has to move,
 * then issue two commands whose numbering shifts between them. That diff is
 * work, it depends on state that may already be stale, and it is where the
 * mistakes were going to come from.
 *
 * `set` rather than `select` or `update`: assignment is the prior a reader
 * already has for the word, which is exactly the semantics — the argument list
 * becomes the whole configuration. `update` was rejected for reading as
 * "refresh these calendars", a real and different operation.
 *
 * Stating the end state has none of that. It is idempotent, any target state is
 * one command, and there is nothing to compare against — read the list, say
 * which ones matter.
 *
 * The cost is that it is destructive by omission: naming only "Privat" stops
 * reading "Familie". So the answer is never just "done" — it names what it
 * started and stopped reading, because a calendar disappearing quietly is
 * precisely the failure this command's shape invites.
 */
async function setCalendars(refs: string[]): Promise<number> {
  const configured = readConfig().calendars ?? [];
  if (refs.length === 0) {
    throw new UsageError(
      `Usage: ${cmd('calendars set <name> [<name> ...]')} — exact names from \`${cmd('calendars')}\`.\n` +
        'To stop reading all of them: aula calendars set none',
    );
  }

  // `none` rather than an empty argument list, because an agent that computes an
  // empty list by accident should not thereby wipe the configuration. Clearing
  // has to be said out loud.
  if (refs.length === 1 && refs[0] === 'none') {
    if (configured.length === 0) {
      console.log('The overview already reads none of your calendars.');
      return 0;
    }
    updateConfig({ calendars: undefined });
    console.log(
      `Stopped reading ${configured.map((c) => `"${c.name}"`).join(' and ')}. ` +
        `\`${cmd('calendars')}\` lists them again.`,
    );
    return 0;
  }

  // Dropping calendars by saved id remains possible while the connector is
  // unavailable. Names require one live listing because an unselected calendar
  // may have the same name; selection is resolved against that same snapshot
  // rather than a second listing whose order may have changed.
  const chosen =
    resolveConfiguredSelection(configured, refs) ??
    resolveCalendarSelection(await calendarList(), refs);

  const wanted = chosen.map((c) => ({ id: c.id, name: c.name }));
  const before = new Set(configured.map((c) => c.id));
  const after = new Set(wanted.map((c) => c.id));
  const started = wanted.filter((c) => !before.has(c.id));
  const stopped = configured.filter((c) => !after.has(c.id));

  const unchanged =
    configured.length === wanted.length &&
    configured.every(
      (calendar, index) =>
        calendar.id === wanted[index]?.id && calendar.name === wanted[index]?.name,
    );
  if (unchanged) {
    console.log(
      `Already reading ${wanted.map((c) => `"${c.name}"`).join(' and ')} — nothing changed.`,
    );
    return 0;
  }
  updateConfig({ calendars: wanted });

  const said = [`Now reading ${wanted.map((c) => `"${c.name}"`).join(' and ')}.`];
  if (stopped.length > 0) {
    said.push(`Stopped reading ${stopped.map((c) => `"${c.name}"`).join(' and ')}.`);
  }
  console.log(said.join('\n'));

  // Only the newly started ones are read back. The receipt is there to prove the
  // chain works for a calendar nobody has seen answer yet; re-reading one that
  // was already being read every morning proves nothing and costs a round trip.
  if (started.length === 0) return 0;
  const receiptNow = new Date();
  const { days: receiptDays } = overviewWindow(localIsoDate(receiptNow));
  const load = await loadPersonalEvents(started, calendarWindow(receiptNow, receiptDays));
  for (const warning of load.warnings) console.error(warning);
  if (load.warnings.length > 0) {
    return failWith({
      code: 'UPSTREAM',
      message: 'The calendars were saved, but reading them back failed.',
      hint: `The reasons are above; \`${cmd('doctor --text')}\` reads them again.`,
    });
  }

  // Per calendar, not just a total: one silently empty calendar is exactly
  // what a single combined number would hide.
  console.log(
    [
      ...started.map((c) => {
        const count = load.events.filter((event) => event.calendarId === c.id).length;
        return `  ${c.name}: ${count} appointment(s) in the next ${receiptDays} days`;
      }),
      ...load.events
        .slice(0, 3)
        .map(
          (event) =>
            `  · ${event.date}${event.startTime ? ` ${event.startTime}` : ''}  ${event.title}`,
        ),
      '',
      `The calendar events will be included next time you run \`${cmd('new')}\`.`,
    ].join('\n'),
  );
  return 0;
}

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
      `It takes effect on the next \`${cmd('new')}\`. ${result.preferences.length} preference(s) in total — ` +
      `\`${cmd('preferences')}\` lists them.`,
  );
  return 0;
}

function runPreferences(positionals: string[]): number {
  const sub = positionals[0];
  if (sub === 'reset') return runPreferencesReset();
  if (sub !== undefined) {
    throw new UsageError(
      `Unknown subcommand "${sub}". Use \`${cmd('preferences')}\` or \`${cmd('preferences reset')}\`.`,
    );
  }
  // Seeds on first use: the tool's own opinions are the first thing this
  // prints, which is the only way a user finds out they can be argued with.
  const preferences = loadPreferences();
  if (preferences.length === 0) {
    console.log(
      `The list is empty (${PREFERENCES_PATH}) — the overview is ranked on its own judgement alone.\n` +
        `\`${cmd('remember "beskeder fra John (Hjaltes far) er altid vigtige"')}\` puts something back.`,
    );
    return 0;
  }
  console.log(
    [
      `What the overview is written to: ${PREFERENCES_PATH}`,
      '',
      ...preferences.map((line, i) => `  ${i + 1}. ${line}`),
      '',
      `\`${cmd('remember "…"')}\` adds one, \`${cmd('forget <n>')}\` drops one — including the ones this tool`,
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
      `Dropped ${dropped.length} of your own — \`${cmd('remember')}\` puts any of them back:`,
      ...dropped.map((line) => `  · ${line}`),
    );
  }
  console.log(lines.join('\n'));
  return 0;
}

function runForget(raw: string | undefined): number {
  const index = Number(raw);
  if (raw === undefined || !Number.isInteger(index)) {
    throw new UsageError(
      `Usage: ${cmd('forget <n>')} — the number shown by \`${cmd('preferences')}\`.`,
    );
  }
  const { removed, preferences } = removePreference(index);
  console.log(`Forgotten: "${removed}"\n${preferences.length} preference(s) left.`);
  return 0;
}

function renderCacheStats(all: { responses: CacheStats; layouts: ExtractionCacheStats }): string {
  const { responses, layouts } = all;
  const byNamespace = Object.entries(responses.byNamespace).sort((a, b) => b[1] - a[1]);
  return [
    'Responses (Aula, vendor plans, calendar)',
    `  File:    ${responses.path}`,
    `  TTL:     ${Math.round(responses.ttlMs / 1000)}s`,
    `  Live:    ${responses.entries} (${(responses.bytes / 1024).toFixed(0)} KiB on disk)`,
    ...byNamespace.map(([name, count]) => `    ${String(count).padStart(4)}  ${name}`),
    '',
    'Layouts (the model’s ranking, keyed on content — no TTL)',
    `  Dir:     ${layouts.path}`,
    `  Entries: ${layouts.entries} (${(layouts.bytes / 1024).toFixed(0)} KiB on disk)`,
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
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const batch = await client.getContactList({ groupId, filter: role, page });
    if (batch.length === 0) break;
    let newRows = 0;
    for (const contact of batch) {
      const key = JSON.stringify([
        contact.profileId ?? null,
        contact.institutionProfileId ?? null,
        contact.fullName ?? null,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(contact);
      newRows++;
    }
    if (newRows === 0) throw new CliError('UPSTREAM', `Aula repeated contact page ${page}.`);
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

/**
 * Every attachment in a thread, flattened in message order, URLs included —
 * for `attachment`, which downloads from it and prints none of it.
 */
function resolveThreadAttachments(detail: ThreadDetail): ResolvedAttachment[] {
  const out: ResolvedAttachment[] = [];
  for (const message of detail.messages ?? []) {
    for (const attachment of listAttachments(message.attachments)) {
      out.push({ ...attachment, index: out.length });
    }
  }
  return out;
}

/**
 * The same list as `attachments` prints it: who sent each one and when, and no
 * URL. Built on `normaliseMessages` so a position here is the position `thread`
 * and `digest` show for the same attachment — and the one `attachment` takes.
 */
function describeThreadAttachments(detail: FullThreadDetail) {
  return normaliseMessages(detail.messages, { wholeThread: !detail.incomplete }).flatMap(
    (message) =>
      message.attachments.map((attachment) => ({
        ...attachment,
        from: message.from,
        at: message.at ?? null,
      })),
  );
}

// ------------------------------------------------------------------- parsing

function requireId(raw: string | undefined, usage: string): number {
  const id = parseInteger(raw, { min: 1 });
  if (id === undefined)
    throw new UsageError(`Usage: ${usage} — the id must be a positive integer.`);
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
    throw new UsageError(
      `${name} must be an integer of at least ${range.min}${upper} (got "${raw ?? ''}").`,
    );
  }
  return value;
}

function optionalIsoDate(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (!parseIsoDateParts(raw))
    throw new UsageError(`${name} must be a real date in YYYY-MM-DD form (got "${raw}").`);
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
  messages?: NormalMessage[];
  messagesUnavailable?: boolean;
  messagesIncomplete?: boolean;
  messageReadWarning?: string | null;
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
      const warning = t.messagesUnavailable
        ? '    WARNING: message bodies could not be read.\n'
        : t.messagesIncomplete
          ? `    WARNING: not every message page was available (${t.messageReadWarning ?? 'unknown reason'}).\n`
          : '';
      const body = t.messages
        .map((m) => `    ${formatWhen(m.at)} ${m.from ?? 'unknown'}:\n${indent(m.text, 6)}`)
        .join('\n');
      return `${head}\n${warning}${body}`;
    })
    .join('\n\n');
}

function renderThreadDetail(thread: {
  id: number;
  subject: string;
  sensitive: boolean;
  messages: NormalMessage[];
  messagesIncomplete?: boolean | null;
  messageReadWarning?: string | null;
}): string {
  const head = `[${thread.id}] ${thread.subject}${thread.sensitive ? '  <SENSITIVE>' : ''}`;
  const warning = thread.messagesIncomplete
    ? `\nWARNING: not every message page was available (${thread.messageReadWarning ?? 'unknown reason'}).`
    : '';
  const body = thread.messages
    .map((m) => {
      const attachments = m.attachments.length
        ? `\n${indent(m.attachments.map((a) => `attachment [${a.index ?? '?'}]: ${a.name}`).join('\n'), 4)}`
        : '';
      return `  ${formatWhen(m.at)} ${m.from ?? 'unknown'}:\n${indent(m.text, 4)}${attachments}`;
    })
    .join('\n\n');
  return `${head}${warning}\n\n${body}`;
}

function renderPosts(posts: ReturnType<typeof normalisePost>[]): string {
  return posts
    .map((p) => {
      const attachments = p.attachments.length
        ? `\n    attachments: ${p.attachments.map((a) => `[${a.index}] ${a.name}`).join(', ')}`
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
      const extra = [d.pickupType, d.exitWith && `with ${d.exitWith}`, d.comment]
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
      const relations = (c.relations ?? [])
        .map((r) => r.name)
        .filter(Boolean)
        .join(', ');
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
        switch (plan.status) {
          case 'failed':
            return (
              `${head}\n  COULD NOT BE READ — the vendor did not answer. ` +
              `This is NOT an empty week; the plan may contain items.\n${warnings}`
            );
          case 'skipped':
            return `${head}\n  (not asked — no selected child attends a school)\n${warnings}`;
          default:
            return `${head}\n  (nothing published — the vendor answered, the week is genuinely empty)`;
        }
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

function renderDigest(
  digest: Awaited<ReturnType<typeof buildDigest>> & { fetchedAt: string },
): string {
  const a = digest.attention;
  const sections = [
    // The time that matters to a reader is when Aula was read, not when this
    // text was assembled from what was already on disk.
    `Aula digest — last ${digest.window.days} days (read from Aula ${formatWhen(digest.fetchedAt)})`,
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
  layoutCached: boolean;
  deployed: string | null;
  complete: boolean;
  retryable: boolean;
  topline: string | null;
  cards: number;
  hidden: number;
  notes: string[];
}): string {
  // "genbrugt svar" rather than a timestamp: the extraction cache has no TTL,
  // so the entry behind a hit may be from this morning or from days ago —
  // whenever the sources, the prompt and the schema last differed.
  const layout =
    result.layout === 'model'
      ? `modellen skrev kortene${result.layoutCached ? ' (genbrugt svar)' : ''}`
      : 'kun reglerne';
  const lines = [
    result.topline ?? '(ingen topline)',
    '',
    `${result.cards} kort, ${result.hidden} kilde(r) skjult — ${layout}`,
    `HTML: ${result.html}`,
  ];
  if (result.pdf) lines.push(`PDF:  ${result.pdf}`);
  if (result.png) lines.push(`PNG:  ${result.png}`);
  if (result.deployed) lines.push(`Delt: ${result.deployed}`);
  if (result.notes.length) lines.push('', ...result.notes.map((n) => `! ${n}`));
  if (!result.complete)
    lines.push(
      result.retryable
        ? '! Ufuldstændig kørsel — planlæggerens næste forsøg gør det om.'
        : '! Ufuldstændig kørsel — den bliver ved, indtil ovenstående er løst.',
    );
  return lines.join('\n');
}

/**
 * Prints the answer and picks the exit code for it.
 *
 * `nothing` is the caller saying the read worked and came back empty — exit 4,
 * "resolved, but nothing to report", with the body still on stdout because the
 * contract's `body_on` is `[0, 4]`. The table has declared that code for as long
 * as this repo has used it and nothing ever returned it: `[]` left at exit 0,
 * so an agent branching on the code alone read an empty inbox as a result to
 * summarise. It is only ever passed on positive evidence — a complete read —
 * and never by `digest`, whose payload is a dozen reads at once.
 */
function emit<T>(value: T, asText: boolean, render: (value: T) => string, nothing = false): number {
  console.log(asText ? render(value) : toJson(value));
  return nothing ? EXIT.NOTHING : EXIT.OK;
}

/** {@link emit} for a command whose whole answer is one array. */
function emitRows<T>(rows: T[], asText: boolean, render: (rows: T[]) => string): number {
  return emit(rows, asText, render, rows.length === 0);
}

/**
 * Prints a set of vendor plans with the exit their statuses earn.
 *
 * A failed vendor read has the same `items: []` as a quiet week, and it left
 * at exit 0 with the difference in `warnings` — a body that read as "nothing
 * planned" to anyone who did not check. Now: anything readable is exit 0 with
 * the body, and `status` says which plans are partial; nothing readable and no
 * failure is exit 4; nothing readable and a failure is exit 1 with no body —
 * a read that did not happen is not an answer, however it is dressed.
 */
function emitPlans(plans: WeekPlan[], asText: boolean): number {
  const anyItems = plans.some((plan) => plan.items.length > 0);
  const failed = plans.filter((plan) => plan.status === 'failed');
  if (!anyItems && failed.length > 0) {
    for (const plan of failed) {
      for (const warning of plan.warnings ?? []) console.error(`${plan.capability}: ${warning}`);
    }
    const capabilities = [...new Set(failed.map((plan) => plan.capability))].join(', ');
    throw new CliError(
      'UPSTREAM',
      `The ${capabilities} could not be read: ${failed[0]?.warnings?.[0] ?? 'the vendor did not answer'}`,
      'A failed vendor read is never cached, so try again in a few minutes; --child narrows it to one child.',
    );
  }
  return emit(plans, asText, renderPlans, !anyItems);
}

/**
 * What every command that takes `--limit` prints: the rows under their own
 * name, whether the limit cut them, and the limit that was in force.
 *
 * These were bare arrays. Twenty rows then read the same whether twenty or two
 * hundred qualified, and an agent summarising "the last month of messages" had
 * no way to know it was holding a fraction of them — a failure that looks
 * exactly like an answer. The rows keep the key the digest already uses for
 * them, so `.threads[]` and `.posts[]` mean the same thing in both payloads.
 *
 * `limit` is null when nothing capped the read — `--since` on its own, or a
 * command with no default cap — and `truncated` is then false by construction.
 *
 * `fetchedAt` is when the rows were actually read from Aula: responses are
 * cached for ten minutes, and "did the teacher reply yet?" is a question where
 * those ten minutes are the answer. `--no-cache` makes it now.
 */
function emitList<T>(
  key: string,
  rows: T[],
  cut: { truncated: boolean; limit: number | undefined; fetchedAt: string },
  asText: boolean,
  render: (rows: T[]) => string,
): number {
  // `--limit` is at least 1, so an empty list is never a cut one: no rows means
  // no rows matched, which is exit 4's "resolved, but nothing to report".
  const code = rows.length === 0 ? EXIT.NOTHING : EXIT.OK;
  if (!asText) {
    console.log(
      toJson({
        [key]: rows,
        truncated: cut.truncated,
        limit: cut.limit ?? null,
        fetchedAt: cut.fetchedAt,
      }),
    );
    return code;
  }
  const note = cut.truncated
    ? `\n\nWARNING: more than ${cut.limit} matched — these are the first ${cut.limit}. ` +
      'Raise --limit to see the rest.'
    : '';
  console.log(`${render(rows)}${note}`);
  return code;
}

/**
 * Common files filter on institution *codes*, not on any of the profile ids —
 * a fourth addressing scheme on top of the three in API.md.
 */
async function collectCommonFiles(client: AulaClient, family: Family): Promise<CommonFile[]> {
  const collected: CommonFile[] = [];
  const seen = new Set<number>();
  const pageSize = 50;
  let expectedTotal: number | null = null;
  for (let index = 0; ; index += pageSize) {
    const page = await client.getCommonFiles({
      institutionCodes: family.institutionCodes,
      index,
      limit: pageSize,
    });
    expectedTotal ??= page.totalAmount;
    if (page.totalAmount !== expectedTotal) {
      throw new CliError(
        'UPSTREAM',
        `Aula changed the shared-file total while paging (${expectedTotal} to ${page.totalAmount}).`,
      );
    }
    let newRows = 0;
    for (const file of page.commonFiles) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      collected.push(file);
      newRows++;
    }
    if (collected.length >= expectedTotal) break;
    if (page.commonFiles.length === 0) {
      throw new CliError(
        'UPSTREAM',
        `Aula reported ${expectedTotal} shared files but returned ${collected.length}.`,
      );
    }
    if (newRows === 0) throw new CliError('UPSTREAM', `Aula repeated shared-file page ${index}.`);
  }
  // Newest first: the shelf is dominated by years-old policy documents, and the
  // thing being looked for is almost always what was added most recently.
  //
  // The rows as Aula sent them, not the printed shape: `commonfile` needs the
  // presigned URL, and that is deliberately absent from what `commonfiles`
  // prints. Each caller normalises for itself.
  return collected.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
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
  const code = await main();
  ensureErrorLine(code);
  process.exitCode = code;
} catch (err) {
  // The vendored login flow's own hierarchy — a failed refresh-stepup or token
  // refresh is a credentials problem, not a bug. That package is not ours to
  // edit, so it is the one failure whose code is decided here rather than on
  // the class.
  const isAuthFlow = err instanceof AulaAuthFlowError;
  // Aula refusing the login is the other thing `status` needs to know, and it
  // is only ever learnt here.
  if (err instanceof AulaAuthError) recordSessionSeen({ state: 'rejected', steppedUp: null });
  if (err instanceof WidgetError) {
    // A third-party school system, not Aula and not us: the vendor is down or
    // has changed its payload.
    console.error(`Widget error (${err.widgetId}): ${err.message}`);
  } else if (err instanceof CliError || isAuthFlow) {
    // Planned-for failures print as a plain message. No "Aula API error:"
    // prefix: it labelled the failure without saying anything about it, and it
    // pushed the headline into the middle of the line.
    reportProblem(err.message);
  } else {
    // An unexpected error is a bug in this client, so the stack is the useful
    // part and it is printed raw rather than dressed up as advice.
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  // The exit follows from the code, never the other way round: 2 for USAGE —
  // it was 1 once, the same as an outage; 5 for SETUP, which no retry fixes;
  // 1 for a source that is down (it was 3, which the fleet reads as "refine
  // the query"), for a vendor, and for a bug.
  process.exitCode = failWith(errorLineFor(err, { isAuthFlow }));
} finally {
  // Written once, here, rather than per response: flat-cache keeps the whole
  // file in memory and rewrites it whole, so saving on every `set` would cost
  // more than the requests it saves. Also runs after a failure, so a command
  // that died halfway still banks what it did manage to fetch.
  flushCache();
}
