import { parseArgs } from 'node:util';
import { UsageError } from './errors.ts';
import { cmd } from './runtime.ts';

const OPTION_DEFINITIONS = {
  text: { type: 'boolean' },
  // Accepted and ignored. JSON is already the default here, but every sibling
  // CLI spells the request --json, and making it a hard error with empty
  // stdout turned a harmless cross-tool habit into a failed command.
  json: { type: 'boolean' },
  full: { type: 'boolean' },
  unread: { type: 'boolean' },
  important: { type: 'boolean' },
  next: { type: 'boolean' },
  limit: { type: 'string' },
  since: { type: 'string' },
  child: { type: 'string' },
  days: { type: 'string' },
  page: { type: 'string' },
  week: { type: 'string' },
  widget: { type: 'string' },
  group: { type: 'string' },
  role: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  out: { type: 'string' },
  'no-llm': { type: 'boolean' },
  'no-deploy': { type: 'boolean' },
  'no-open': { type: 'boolean' },
  'catch-up': { type: 'boolean' },
  web: { type: 'boolean' },
  off: { type: 'boolean' },
  remove: { type: 'boolean' },
  at: { type: 'string' },
  explain: { type: 'boolean' },
  pdf: { type: 'boolean' },
  png: { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  'cache-ttl': { type: 'string' },
  debug: { type: 'boolean' },
} as const;

type OptionName = keyof typeof OPTION_DEFINITIONS;
const CACHED = ['no-cache', 'cache-ttl'] as const;
const TEXT = ['text'] as const;

const COMMAND_OPTIONS = {
  cache: [...TEXT, 'cache-ttl'],
  open: ['web'],
  publish: ['off'],
  calendars: [],
  remember: [],
  preferences: [],
  forget: [],
  schedule: ['remove', 'at'],
  'scheduled-run': [],
  'install-skill': ['out'],
  version: [],
  login: ['debug', 'no-open'],
  logout: [],
  status: [...TEXT],
  'refresh-stepup': [],
  doctor: [...TEXT, 'days'],
  whoami: [...TEXT, ...CACHED],
  messages: [...TEXT, ...CACHED, 'limit', 'since', 'child', 'full', 'unread'],
  thread: [...TEXT, ...CACHED, 'page'],
  posts: [...TEXT, ...CACHED, 'limit', 'since', 'child', 'important'],
  galleries: [...TEXT, ...CACHED, 'limit', 'since', 'child'],
  calendar: [...TEXT, ...CACHED, 'days', 'child'],
  presence: [...TEXT, ...CACHED, 'child'],
  notifications: [...TEXT, ...CACHED],
  'pickup-times': [...TEXT, ...CACHED, 'days', 'child', 'from', 'to'],
  groups: [...TEXT, ...CACHED, 'child'],
  contacts: [...TEXT, ...CACHED, 'child', 'group', 'role'],
  birthdays: [...TEXT, ...CACHED, 'limit', 'child', 'group'],
  attachments: [...TEXT, ...CACHED],
  attachment: [...TEXT, ...CACHED, 'out'],
  'post-attachment': [...TEXT, ...CACHED, 'out'],
  commonfiles: [...TEXT, ...CACHED, 'limit'],
  commonfile: [...TEXT, ...CACHED, 'out'],
  widgets: [...TEXT, ...CACHED],
  'weekly-plan': [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  'weekly-letter': [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  tasks: [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  assignments: [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  reminders: [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  homework: [...TEXT, ...CACHED, 'week', 'next', 'child', 'from', 'to'],
  raw: [...TEXT, ...CACHED],
  digest: [...TEXT, ...CACHED, 'days', 'limit', 'week', 'next', 'child'],
  new: [
    ...TEXT,
    ...CACHED,
    'days',
    'week',
    'next',
    'no-llm',
    'no-deploy',
    'no-open',
    'catch-up',
    'explain',
    'pdf',
    'png',
    'out',
  ],
} as const satisfies Record<string, readonly OptionName[]>;

export type CliCommand = keyof typeof COMMAND_OPTIONS;

/**
 * What each option takes and means, for `aula <command> --help`.
 *
 * Keyed on the same names as {@link OPTION_DEFINITIONS} and typed `Record`, so
 * an option added without help text fails to compile. The help used to list
 * names alone — `--role` with no word on what it took — which told an agent
 * that the flag existed and nothing it could act on.
 */
export const OPTION_HELP: Readonly<Record<OptionName, { value?: string; help: string }>> = {
  text: { help: 'Human-readable text instead of JSON' },
  json: { help: 'Accepted and ignored: JSON is already the default' },
  full: { help: 'Every message body, not only the preview Aula cuts short' },
  unread: { help: 'Unread threads only' },
  important: { help: 'Posts Aula flags as important only' },
  next: { help: 'Next ISO week instead of this one' },
  limit: { value: '<n>', help: 'At most n rows; the payload says when this cut the list' },
  since: { value: '<7d|3w|2026-08-01>', help: 'Rows on or after this; lifts the default cap' },
  child: { value: '<name|shortName|id>', help: 'One child only' },
  days: { value: '<n>', help: 'How many days' },
  page: { value: '<n>', help: 'One page of the thread, 0-based, instead of all of it' },
  week: { value: '<2026-W33>', help: 'The ISO week to read' },
  widget: { value: '<id>', help: 'Read this vendor widget directly, bypassing detection' },
  group: { value: '<id>', help: 'A group id from `groups`, instead of each child’s class' },
  role: { value: '<child|guardian>', help: 'Which side of the contact list' },
  from: { value: '<YYYY-MM-DD>', help: 'Start of the window' },
  to: { value: '<YYYY-MM-DD>', help: 'End of the window' },
  out: { value: '<path>', help: 'Where to write' },
  'no-llm': { help: 'Danish rules only — skip the model calls' },
  'no-deploy': { help: 'Do not update the hosted copy this run' },
  'no-open': { help: 'Do not open a browser' },
  'catch-up': { help: 'Do nothing if this slot’s overview is already complete' },
  web: { help: 'The hosted copy instead of the local page' },
  off: { help: 'Stop updating the hosted copy and forget its URL' },
  remove: { help: 'Remove the schedule' },
  at: { value: '<HH:MM,HH:MM>', help: 'The slot times' },
  explain: { help: 'Print model priority, date placement and sources' },
  pdf: { help: 'Also write a PDF' },
  png: { help: 'Also write a PNG' },
  'no-cache': { help: 'Read from Aula even when a cached response is younger than the TTL' },
  'cache-ttl': { value: '<seconds>', help: 'How old a cached response may be' },
  debug: { help: 'Write a sanitised wire transcript' },
};

/** One line per command: what it is for. Typed `Record` so no command lacks one. */
export const COMMAND_SUMMARY: Readonly<Record<CliCommand, string>> = {
  cache: 'What is cached (`status`, the default) or drop it all (`clear`)',
  open: 'Open the newest overview without regenerating it',
  publish: 'Keep a hosted copy of the overview; `--off` stops',
  calendars: 'Which of the family’s own calendars the overview reads; `set` states the whole list',
  remember: 'Record a standing wish about what the overview should highlight',
  preferences: 'List those wishes; `reset` returns to the shipped list',
  forget: 'Drop wish number n',
  schedule: 'Generate the overview automatically at the slot times',
  'scheduled-run':
    'What the schedule starts: waits through sleep, then generates if this slot needs one',
  'install-skill': 'Write the agent skill into ~/.claude (or ~/.agents for codex)',
  version: 'Which build this is, and for which platform',
  login: 'Log in with MitID on a page in the user’s browser; costs them an approval on their phone',
  logout: 'Forget the stored login',
  status: 'What is stored and what Aula last said about it — from disk, no request',
  'refresh-stepup': 'Restore step-up without MitID, while the broker session lives',
  doctor: 'Call every endpoint for real and report status and timing',
  whoami: 'Guardian, children, institutions, widgets, and the id sets the API wants',
  messages: 'Message threads, newest first; `--full` reads every message body',
  thread: 'One thread with every message and its attachments',
  posts: 'Posts (opslag) from the schools and daycare',
  galleries: 'Photo albums — titles and dates, never the photos',
  calendar: 'Upcoming Aula events, from today',
  presence: 'Today’s check-in and check-out per child',
  notifications: 'The unread badges Aula is showing right now',
  'pickup-times': 'The recurring komme/gå plan: drop-off and pickup times',
  groups: 'Which groups and classes each child belongs to',
  contacts: 'The class contact list; `--role guardian` for the parents, with their address',
  birthdays: 'Classmates’ birthdays, soonest first',
  attachments: 'Every attachment in a thread, with the index `attachment` takes',
  attachment: 'Download attachment n of a thread to a file',
  'post-attachment': 'Download attachment n of a post to a file',
  commonfiles: 'Fælles Filer: timetables, holiday plans, policies',
  commonfile: 'Download one shared file, by id or by text from its title',
  widgets: 'Which vendor widgets the schools expose, and which have an integration',
  'weekly-plan': 'The weekly plan (ugeplan), from whichever vendor the school uses',
  'weekly-letter': 'The weekly letter (ugebrev), MinUddannelse',
  tasks: 'Homework: tasks (MinUddannelse)',
  assignments: 'Homework: assignments (SkolePortal)',
  reminders: 'Homework: reminders (Systematic)',
  homework: 'All three homework sources in one call',
  raw: 'Any un-wrapped Aula read method, with key=value parameters',
  digest: 'Threads with bodies, posts, calendar, presence and weekly plans in one payload',
  new: 'Generate today’s AI overview and open it',
};

/** Where a command’s default for an option is worth stating. */
export const OPTION_DEFAULTS: Partial<Record<CliCommand, Partial<Record<OptionName, string>>>> = {
  messages: { limit: '20, or none when --since is given' },
  posts: { limit: '20, or none when --since is given' },
  galleries: { limit: '20, or none when --since is given' },
  digest: { days: '14' },
  calendar: { days: '14, at most 50' },
  'pickup-times': { days: '14' },
  doctor: { days: '14' },
  new: { days: '60' },
  contacts: { role: 'child' },
};

const POSITIONALS: Partial<Record<CliCommand, { min: number; max?: number; usage: string }>> = {
  cache: { min: 0, max: 1, usage: 'cache [status|clear]' },
  open: { min: 0, max: 0, usage: 'open [--web]' },
  publish: { min: 0, max: 0, usage: 'publish [--off]' },
  calendars: { min: 0, usage: 'calendars [set <name> ... | set none]' },
  'install-skill': { min: 0, max: 1, usage: 'install-skill [claude|codex] [--out <dir>]' },
  version: { min: 0, max: 0, usage: 'version' },
  'scheduled-run': { min: 0, max: 0, usage: 'scheduled-run' },
  remember: { min: 1, usage: 'remember "<ønske>"' },
  preferences: { min: 0, max: 1, usage: 'preferences [reset]' },
  forget: { min: 1, max: 1, usage: 'forget <n>' },
  thread: { min: 1, max: 1, usage: 'thread <threadId>' },
  attachments: { min: 1, max: 1, usage: 'attachments <threadId>' },
  attachment: { min: 1, max: 2, usage: 'attachment <threadId> [index]' },
  'post-attachment': { min: 1, max: 2, usage: 'post-attachment <postId> [index]' },
  commonfile: { min: 1, max: 1, usage: 'commonfile <id|title>' },
  raw: { min: 1, usage: 'raw <method> [key=value ...]' },
};

/** Every option `command` acts on — the allow-list above, as the user types it. */
export function optionsFor(command: CliCommand): string[] {
  return COMMAND_OPTIONS[command].map((name) => `--${name}`);
}

/** The option names `command` acts on, for help that needs more than the spelling. */
export function optionNamesFor(command: CliCommand): readonly OptionName[] {
  return COMMAND_OPTIONS[command];
}

export type { OptionName };

/** The positional signature for `command`, for help and usage errors alike. */
export function usageFor(command: CliCommand): string {
  return POSITIONALS[command]?.usage ?? command;
}

export function isCliCommand(value: string): value is CliCommand {
  return Object.hasOwn(COMMAND_OPTIONS, value);
}

function isOptionName(value: string): value is OptionName {
  return Object.hasOwn(OPTION_DEFINITIONS, value);
}

export function parseCommandLine(command: CliCommand, args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: OPTION_DEFINITIONS,
    });
  } catch (err) {
    // strict:true throws a plain Node TypeError for an unknown or malformed
    // flag. It used to escape the UsageError branch entirely and land in the
    // "this is a bug in the client" one, which prints a raw stack — so a
    // mistyped flag was byte-identical to a crash, at the same exit code.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const allowed = new Set<OptionName>(COMMAND_OPTIONS[command]);
  const ignored = Object.entries(parsed.values)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name)
    .filter(isOptionName)
    // --json is accepted everywhere and means nothing here: JSON is already
    // the default. It exists so an agent driving the whole fleet does not have
    // to remember which tool wants the flag and which rejects it.
    .filter((name) => name !== 'json')
    .filter((name) => !allowed.has(name));
  if (ignored.length > 0) {
    const acceptedBy = ignored.map((name) => {
      const commands = Object.entries(COMMAND_OPTIONS)
        .filter(([, options]) => options.some((option) => option === name))
        .map(([candidate]) => candidate);
      return `--${name}: ${commands.join(', ')}`;
    });
    throw new UsageError(
      `"${command}" does not accept ${ignored.map((name) => `--${name}`).join(', ')}; ` +
        `the option would otherwise be ignored. Accepted by ${acceptedBy.join('; ')}.`,
    );
  }

  const positional = POSITIONALS[command] ?? { min: 0, max: 0, usage: command };
  if (
    parsed.positionals.length < positional.min ||
    (positional.max !== undefined && parsed.positionals.length > positional.max)
  ) {
    const reason =
      positional.max === 0 && parsed.positionals.length > 0
        ? `"${command}" takes no arguments. `
        : '';
    throw new UsageError(`${reason}Usage: ${cmd(positional.usage)}`);
  }

  return parsed;
}
