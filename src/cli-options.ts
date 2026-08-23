import { parseArgs } from 'node:util';
import { UsageError } from './errors.ts';

const OPTION_DEFINITIONS = {
  text: { type: 'boolean' },
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
  username: { type: 'string' },
  method: { type: 'string' },
  debug: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
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
  login: ['username', 'method', 'debug', 'no-browser'],
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
  attachments: [...TEXT, ...CACHED, 'page'],
  attachment: [...TEXT, ...CACHED, 'out'],
  commonfiles: [...TEXT, ...CACHED, 'limit'],
  commonfile: [...TEXT, ...CACHED, 'out'],
  widgets: [...TEXT, ...CACHED],
  'weekly-plan': [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  'weekly-letter': [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  'tasks': [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  'assignments': [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
  'reminders': [...TEXT, ...CACHED, 'week', 'next', 'child', 'widget', 'from', 'to'],
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

const POSITIONALS: Partial<Record<CliCommand, { min: number; max?: number; usage: string }>> = {
  cache: { min: 0, max: 1, usage: 'cache [status|clear]' },
  open: { min: 0, max: 0, usage: 'open [--web]' },
  publish: { min: 0, max: 0, usage: 'publish [--off]' },
  calendars: { min: 0, usage: 'calendars [set <name> ... | set none]' },
  remember: { min: 1, usage: 'remember "<ønske>"' },
  preferences: { min: 0, max: 1, usage: 'preferences [reset]' },
  forget: { min: 1, max: 1, usage: 'forget <n>' },
  thread: { min: 1, max: 1, usage: 'thread <threadId>' },
  attachments: { min: 1, max: 1, usage: 'attachments <threadId>' },
  attachment: { min: 1, max: 2, usage: 'attachment <threadId> [index]' },
  commonfile: { min: 1, max: 1, usage: 'commonfile <id|title>' },
  raw: { min: 1, usage: 'raw <method> [key=value ...]' },
};

/** Every option `command` acts on — the allow-list above, as the user types it. */
export function optionsFor(command: CliCommand): string[] {
  return COMMAND_OPTIONS[command].map((name) => `--${name}`);
}

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
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: OPTION_DEFINITIONS,
  });

  const allowed = new Set<OptionName>(COMMAND_OPTIONS[command]);
  const ignored = Object.entries(parsed.values)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name)
    .filter(isOptionName)
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
    const reason = positional.max === 0 && parsed.positionals.length > 0
      ? `"${command}" takes no arguments. `
      : '';
    throw new UsageError(`${reason}Usage: aula ${positional.usage}`);
  }

  return parsed;
}
