# aula-cli

Read-only client for [Aula](https://www.aula.dk), the Danish school and daycare
platform. Built to be driven by Claude, so it can summarise what is happening
and surface what needs attention.

> **Unofficial.** Not affiliated with Aula, Netcompany or KOMBIT. It is built on
> Aula's undocumented internal API, so it can break without notice. It is
> read-only by construction, and meant for use against your own account only.

No build step — [Bun](https://bun.com) ≥ 1.3 runs the TypeScript directly.

```bash
bun src/cli.ts digest --days 14 --text
```

## Getting started

**With Claude.** Tell [Claude Code](https://claude.com/claude-code):

> Clone https://github.com/sorenlouv/aula-cli and follow its SETUP.md.

It installs Bun, walks you through the MitID login, and installs the `aula`
skill so Aula questions work in any Claude session. From then on you just ask —
*"what did I miss in Aula this week?"*, *"does anything need a reply?"*

**By hand.** The Setup section below, or [SETUP.md](SETUP.md) for the full
walkthrough.

## Setup

```bash
bun install
bun run login
```

`login` prints a code you approve in the MitID app, and ends with OAuth tokens
AES-256-GCM encrypted into `~/.aula/tokens.json`. They refresh themselves, so
day-to-day use never prompts; `bun run status` shows where you stand.

Use `--method CODE_TOKEN` for a kodeviser instead of the app, and `--debug` to
write a sanitised wire transcript to `~/.aula/login-trace.jsonl` when something
fails.

The AES key defaults to `~/.aula/.token-key`, next to the ciphertext it opens —
so the real protection is that `~/.aula` is `0700`. To move the key out of the
filesystem, set `$AULA_TOKEN_KEY` (64 hex characters, or any passphrase, which
is SHA-256'd into a key):

```bash
export AULA_TOKEN_KEY=$(openssl rand -hex 32)
```

Change or lose it and the stored login is unrecoverable; `status` says so rather
than reporting you as logged out.

Login also records your MitID *username*, which Meebook and Huskelisten need as
their session id — see [Widgets and weekly plans](#widgets-and-weekly-plans).

### Step-up

Aula drops your *step-up assurance* well before the login itself expires, and
without it the sensitive threads — the ones about one specific child — read as
empty rather than erroring. `whoami` reports `isSteppedUp`. To get it back
without a full MitID round-trip:

```bash
bun src/cli.ts refresh-stepup
```

## Commands

### Authentication

| Command | Purpose |
| --- | --- |
| `login [--username x] [--method APP\|CODE_TOKEN] [--debug]` | Log in with MitID |
| `logout` | Forget the stored login |
| `status` | Whether you are logged in, and for how much longer |
| `refresh-stepup` | Restore step-up assurance so sensitive threads read |
| `session set <cookie>` | Fallback: store a browser session cookie by hand |

### Aula itself

| Command | Purpose |
| --- | --- |
| `brief [--open] [--explain] [--no-llm] [--pdf] [--png]` | The "Aula AI oversigt" — a generated HTML page in `~/.aula/brief`. See [BRIEF.md](BRIEF.md) |
| `digest [--days 14]` | Threads, posts, calendar, presence, weekly plans and an `attention` block in one payload |
| `whoami` | Guardian, children, institutions, widgets, and the resolved id sets |
| `messages [--full] [--unread]` | Message threads, newest first |
| `thread <id>` | One thread with every message |
| `posts [--important]` | Posts / "opslag" |
| `galleries [--since 30d]` | Photo albums — titles, dates and photographer, not the photos |
| `calendar [--days 30]` | Upcoming events |
| `presence` | Today's check-in/check-out |
| `schedule [--from --to]` | The recurring komme/gå plan (drop-off and pickup times) |
| `groups` | Which groups and classes each child belongs to |
| `contacts [--group id]` | Class contact list ("kontaktliste") |
| `birthdays` | Classmates' birthdays, soonest first |
| `notifications` | Unread badges |
| `attachments <threadId>` | List a thread's attachments |
| `attachment <threadId> <n>` | Download one to disk |
| `commonfiles` | "Fælles Filer" — the shared shelf: timetables, holiday plans, policies |
| `commonfile <id\|title>` | Download one shared file |

### Weekly plans

| Command | Purpose |
| --- | --- |
| `widgets` | Which vendor widgets these schools expose |
| `ugeplan [--week 2026-W33] [--next]` | Weekly plan, from whichever vendor the school uses |
| `ugebrev` | Weekly letter (MinUddannelse) |
| `opgaver` | Homework list (MinUddannelse) |
| `lektier` | Homework (EasyIQ Lektier) |
| `huskelisten [--from --to]` | Homework reminders (Systematic) |
| `homework` | `opgaver` + `lektier` + `huskelisten` in one call |

### Diagnostics

| Command | Purpose |
| --- | --- |
| `doctor` | Call every endpoint and report status, counts and timing |
| `cache status` | What is cached, and how much of it |
| `cache clear` | Drop every cached response |

### Escape hatch

`raw <method> [key=value ...]` calls any Aula read method that has no wrapper
here. Repeat a key to build an array parameter:

```bash
bun src/cli.ts raw presence.getDailyOverview childIds=4242 childIds=4343
```

Shared options: `--text` (human output; default is JSON), `--limit <n>`,
`--since <7d|3w|2026-08-01>`, `--child <name|shortName|id>`, `--days <n>`,
`--week <2026-W33>`, `--next`, `--widget <id>`, `--group <id>`, `--role`,
`--from`, `--to`, `--out <path>`, `--no-cache`, `--cache-ttl <seconds>`.

`--child` is refused by the commands that cannot honour it, rather than being
accepted and silently ignored.

## `doctor`

The test suite stubs `fetch`, so a green run proves the client is internally
consistent and says nothing about whether Aula still behaves. `doctor` is the
other half: it walks every endpoint in sequence and reports what came back.

```bash
bun src/cli.ts doctor --text
```

```
  [PASS] messaging.getThreads                            20 thread(s), 2 unread, 1 sensitive (312 ms)
  [WARN] posts.getAllPosts                               0 post(s) (198 ms)
           an empty feed and a wrong id set look identical here
  [WARN] session step-up                                 not stepped up (0 ms)
           sensitive threads read as empty rather than erroring — run `refresh-stepup`
  [PASS] aulaToken.getAulaToken (0004 Meebook Ugeplan)   token issued (782 chars) (241 ms)
```

The `WARN` status is the point. Nearly every trap in [AGENTS.md](AGENTS.md)
returns a *successful-looking* response, so a PASS/FAIL report would confidently
pass on exactly the failures worth catching. A warning does not fail the run;
only a thrown error does, and then the exit code is `1`. Checks are independent,
so one dead endpoint does not stop the walk.

It also reads each vendor widget for real, which is where breakage usually is.
It never reads the cache — a cached `PASS` would be a report on a request it did
not send.

## Caching

The skill runs `digest --days 14` for nearly every question it is asked, and one
digest is ~60 requests. So responses are cached on disk with a short TTL, and a
repeat run inside the window makes **no requests at all**.

```bash
bun src/cli.ts cache status --text
bun src/cli.ts digest --no-cache      # ignore it for this run
bun src/cli.ts cache clear
```

Default TTL is 600s; `--cache-ttl <seconds>` or `$AULA_CACHE_TTL` change it, and
`0` disables it. [`flat-cache`](https://github.com/jaredwray/cacheable) stores it
as one JSON file at `~/.aula/cache/responses`, `0600`, with expiry stamped per
entry.

Two things are never cached:

- **`aulaToken.getAulaToken`.** Widget tokens live about a minute, and serving a
  dead one from cache would turn a routine expiry into a hard failure —
  `WidgetTokens` recovers by minting a fresh token and retrying once. Weekly
  plans are cached one level up instead, so a hit skips the token and the vendor
  round-trip together.
- **Anything that failed.** Only a status-0 envelope is stored, so a transient
  403 is not pinned for the length of the TTL.

The TTL is the only invalidation — nothing here can tell that a new message
arrived. `login`, `logout` and `refresh-stepup` each drop the cache, because
those change *what the account can see*. The step-up one matters most, since
sensitive threads cached by a non-stepped-up session are empty and look like
success.

## Read-only by construction

Every request funnels through a transport that checks the target against an
allowlist and throws before opening a socket, rather than relying on call sites
to behave. There are two, because there are two kinds of outbound call.

**Aula's own API** — [`src/client.ts`](src/client.ts):

```ts
export function assertReadOnly(method: string, httpMethod: 'GET' | 'POST', opts?): void
```

`calendar.getEventsByProfileIdsAndResourceIds` is the only method allowed to use
POST — Aula models that particular *read* as a POST because the filter payload
does not fit in a query string. Tests assert that every allowlisted method
matches `READ_METHOD_PATTERN`, so the list cannot quietly grow a write.

The `raw` command widens the check from the named allowlist to that same pattern
— `module.get*`, `module.is*`, `module.has*`, anchored at both ends — and still
refuses POST. So an unwrapped endpoint is reachable, and a write still is not.

**The vendor APIs** — [`src/widgets.ts`](src/widgets.ts):

```ts
export function assertWidgetEndpoint(url: string, httpMethod: 'GET' | 'POST'): void
```

Exact origin + path, one permitted HTTP method each. Two vendor endpoints are
POST and both are reads: EasyIQ's `weekplaninfo` takes its filter as a body, and
SkolePortal's `AuthenticateAulaUser` exchanges the Aula widget token for a
vendor-side login id.

### What is deliberately missing

`presence.updatePresenceTemplate` — registering a child's drop-off/pickup times.
It is the one API in the prior art this project does not implement, because it
is the one that *writes*. `schedule` reads the same templates, so you can see
the plan; changing it stays in the browser.

## Widgets and weekly plans

Aula itself carries messages, posts, calendar and presence. Everything a school
actually teaches with — weekly plans, homework, reminders — lives in a product
the municipality bought separately and embedded as a "widget". So the
interesting half of "what is happening at school" is not in the Aula API at all.

The bridge is `aulaToken.getAulaToken?widgetId=NNNN`: Aula mints a short-lived
JWT scoped to one widget, and the vendor's own API accepts it as a bearer token.
`profiles.getProfileContext` lists which widgets a school exposes, so the right
provider is detected rather than configured. Run `widgets` to see yours.

| Widget | Product | Capability | Endpoint |
| --- | --- | --- | --- |
| `0001` | EasyIQ Ugeplan | ugeplan | `POST api.easyiqcloud.dk/api/aula/weekplaninfo` |
| `0004` | Meebook | ugeplan | `app.meebook.com/aulaapi/relatedweekplan/all` |
| `0023`, `0030` | MinUddannelse Opgaveliste | opgaver | `api.minuddannelse.net/aula/opgaveliste` |
| `0029` | MinUddannelse Ugebrev | ugebrev | `api.minuddannelse.net/aula/ugebrev` |
| `0062` | Huskelisten (Systematic) | huskelisten | `systematic-momo.dk/api/aula/reminders/v1` |
| `0128` | EasyIQ SkolePortal | ugeplan | `skoleportal.easyiqcloud.dk/Calendar/CalendarGetWeekplanEvents` |
| `0142` | EasyIQ Lektier | lektier | `skoleportal.easyiqcloud.dk/AulaHuskeliste/GetWeekplanEvents` |

Each vendor normalises into one `WeekPlan` shape, so `ugeplan` works the same
whether the school is on Meebook or EasyIQ. A family split across two schools on
two providers gets both read — picking one would silently drop a child.

Each vendor also has its own way of failing quietly — see [vendor widget
gotchas](API.md#vendor-widget-gotchas).

## Not covered

- **Writing anything.** See [What is deliberately
  missing](#what-is-deliberately-missing).
- **Photos themselves.** `galleries` reads album *metadata* — title, date,
  photographer, which group. The images stay in Aula.
- **Comments on posts.** Neither prior-art project reads them; `raw` will reach
  the endpoints if you work out their names.

## Development

```bash
bun install
bun run typecheck
bun test src/
```

Two documents matter before you change anything: [API.md](API.md) for how the
undocumented Aula API actually behaves, and [AGENTS.md](AGENTS.md) for the
failure modes that return a *successful-looking* response.

Tests stub `fetch`, so they never touch the network or need a session — and for
that reason they cannot tell you the API still behaves. `doctor` is what does
that. Vendor payloads in `integrations.test.ts` are trimmed copies of shapes the
prior-art projects observed live.

`typecheck` runs TypeScript 7, the Go rewrite of the compiler, so a full check
takes well under a tenth of a second. Bun transpiles rather than type-strips, so
unlike Node it imposes no restrictions on TypeScript syntax; relative imports
keep their real `.ts` extension.

| File | Holds |
| --- | --- |
| `client.ts` | Aula transport, the read-only guard, endpoint wrappers |
| `family.ts` | Id resolution — the thing every command needs first |
| `widgets.ts` | Widget registry, token cache, vendor transport + guard |
| `integrations/` | One file per vendor, plus the dispatcher |
| `attachments.ts` | Presigned-URL downloads |
| `cli.ts` | Commands, normalisation, rendering |
| `cli-helpers.ts` | Pure helpers, importable without running `main()` |
| `auth.ts` | Credential resolution: tokens, cookies, precedence |
| `cache.ts` | The on-disk response cache and its lifecycle |
| `doctor.ts` | The endpoint walk |
| `login.ts` | `login` / `logout` / `status` / `refresh-stepup` |
| `io.ts` | Terminal prompts (stderr only — stdout is a data channel) |
| `testing/fake-aula.ts` | A stubbed Aula, preloaded over `fetch` for the end-to-end tests |
| `vendor/aula-auth/` | The MitID flow, copied from aula-mcp |

`cli.test.ts` and `auth.test.ts` run the CLI as a *process*, against
`testing/fake-aula.ts` injected with `bun --preload`. Unit tests of the helpers
are blind to a whole class of bug where every part is correct and the wiring
between them is not — which is what `digest` silently dropping `--child` was.
Running the real binary also makes it possible to count requests, which is the
only honest way to test a cache.

### The vendored MitID flow

`src/vendor/aula-auth/` is a copy of `aula-mcp`'s `packages/aula-auth` — SRP,
PKCE, OAuth and the SAML broker chain, about 4,000 lines that would be foolish
to reimplement. It is a copy rather than a dependency because the upstream
package is `private: true` and source-only. It is MIT-licensed; provenance, the
exact upstream commit and any local changes are recorded in
[`src/vendor/aula-auth/VENDOR.md`](src/vendor/aula-auth/VENDOR.md). Its own 12
test files came across with it and run as part of `bun test src/`, which is the
only local coverage the crypto has.

To see what has changed upstream since:

```bash
scripts/vendor-diff.sh [path-to-aula-mcp-checkout]
```

It diffs only — it never copies over local files.

## Prior art

- [scaarup/aula](https://github.com/scaarup/aula) — Home Assistant integration
- [Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp) — MCP server

Between them they cover every provider either project has seen in the wild; this
project reads everything they read, minus the one write.

## Privacy

The data is personal and concerns children. Both credentials grant full read
access to the account, and the MitID **refresh token is long-lived**.

**What leaves your machine.** Aula data is stored and processed locally. The one
exception is `aula brief`, which sends a trimmed excerpt of recent Aula content
to Anthropic — through your own installed `claude` CLI, so on your account, as
your model calls. Nothing else is transmitted, and there is no telemetry.

Everything lives in `~/.aula`, which is `0700`, with every file `0600`: the
encrypted tokens, the key that opens them (unless `$AULA_TOKEN_KEY` is set), the
cookie jar, downloaded attachments, and the response cache. The cache is
plaintext message bodies, so the directory mode is what protects it.

In the repo itself, anything containing real family data — captured payloads,
fixtures cut from live responses, personal notes — belongs in the gitignored
`data/` folder, never in tracked files. See [`data/README.md`](data/README.md).

`bun run logout` clears the tokens, the cookie jar and the cache. Keep command
output out of anywhere shared.

## License

MIT — see [LICENSE](LICENSE). The vendored
[`src/vendor/aula-auth`](src/vendor/aula-auth) is likewise MIT, Copyright (c)
2026 Casper Juel; see
[`VENDOR.md`](src/vendor/aula-auth/VENDOR.md) for provenance.
