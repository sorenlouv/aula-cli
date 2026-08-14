# aula-cli

Read-only client for [Aula](https://www.aula.dk), the Danish school and daycare
platform, built to be driven by Claude so it can summarise what is happening at
school and daycare and surface the things that actually need attention.

> **Unofficial.** This project is not affiliated with Aula, Netcompany or
> KOMBIT. It is built on Aula's undocumented internal API, so it can break
> without notice. It is read-only by construction, and it is meant to be used
> only against your own account.

No build step — [Bun](https://bun.com) ≥ 1.3 runs the TypeScript directly.

```bash
bun src/cli.ts digest --days 14 --text
```

## Getting started

Two ways in — pick the one that matches you.

**Let Claude set it up.** With [Claude Code](https://claude.com/claude-code)
and git installed, tell Claude:

> Clone https://github.com/sorenlouv/aula-cli and follow its SETUP.md.

Claude installs Bun, walks you through the MitID login (you approve in the app
on your phone), installs the `aula` skill so Aula questions work in any Claude
session, and offers to schedule the daily brief. From then on you just ask —
*"what did I miss in Aula this week?"*, *"does anything need a reply?"*,
*"what does Alma have on Thursday?"*

**Set it up yourself.** [SETUP.md](SETUP.md) is the full walkthrough; the
short version is the Setup section below. The Claude skill ships in the repo
at [`.claude/skills/aula`](.claude/skills/aula/SKILL.md), so opening the
repository folder in Claude works immediately even without installing
anything user-level.

## Setup

```bash
bun install
bun run login
```

`login` performs a real MitID login — SRP, PKCE, OAuth and the SAML broker
chain — and ends with OAuth tokens AES-256-GCM encrypted into
`~/.aula/tokens.json`. It defaults to the MitID app: it prints a code, you
approve it on your phone. Pass `--method CODE_TOKEN` to use a kodeviser instead,
and `--debug` to write a sanitised wire transcript to
`~/.aula/login-trace.jsonl` when something fails.

The access token is short-lived but refreshes itself from the refresh token, so
day-to-day use never prompts. `bun run status` shows where you stand.

### Where the key lives

By default the AES key is generated into `~/.aula/.token-key`, next to the
ciphertext it opens — so on its own the encryption only stops the refresh token
turning up in a `grep`, and the real protection is that `~/.aula` is `0700`.
Set `$AULA_TOKEN_KEY` (64 hex characters, or any passphrase — anything that is
not 64 hex is SHA-256'd into a key) to move the key out of the filesystem, and
the file becomes useless without it:

```bash
export AULA_TOKEN_KEY=$(openssl rand -hex 32)
```

Change or lose it and the stored login is unrecoverable; `status` says so
rather than reporting you as logged out.

Login also records your MitID *username*, which Meebook and Huskelisten need as
their session id — see [Widgets and weekly plans](#widgets-and-weekly-plans).
That used to be a separate manual step.

### Step-up

Aula drops your *step-up assurance* well before the login itself expires, and
without it the sensitive threads — the ones about one specific child — read as
empty rather than erroring. `whoami` reports `isSteppedUp`. To get it back
without a full MitID round-trip:

```bash
bun src/cli.ts refresh-stepup
```

### Cookie fallback

A browser session cookie still works, and is the thing to reach for when the
login flow itself is what is broken:

1. Log in to <https://www.aula.dk> with MitID.
2. DevTools → Network → any `/api/` request → Request Headers → copy the whole
   `Cookie` value. It must contain `PHPSESSID` and `Csrfp-Token`.
3. `bun src/cli.ts session set '<paste cookie here>'`

It is written to `~/.aula/session.json` with mode `0600`. Cookies expire after a
few hours of inactivity and cannot be renewed without a human, which is the
whole reason `login` exists.

### Which credential wins

`$AULA_COOKIE` → `~/.aula/tokens.json` → `~/.aula/session.json`. The environment
variable is first on purpose: it is how you pin the client to one specific
session while debugging, and a stored login silently overriding that would be
maddening. Commands that fail on credentials exit `2` and print the fix for the
credential that actually died.

## Commands

### Authentication

| Command | Purpose |
| --- | --- |
| `login [--username x] [--method APP\|CODE_TOKEN] [--debug]` | Log in with MitID |
| `logout` | Forget the stored login (leaves the cookie fallback alone) |
| `status` | Whether you are logged in, and for how much longer |
| `refresh-stepup` | Restore step-up assurance so sensitive threads read |
| `session set <cookie>` | Fallback: store a browser cookie by hand |

### Aula itself

| Command | Purpose |
| --- | --- |
| `brief [--open] [--explain] [--no-llm] [--pdf] [--png]` | The "Aula AI oversigt" — a generated HTML page in `~/.aula/brief`. PDF and PNG are opt-in and off by default, including on the schedule. See [BRIEF.md](BRIEF.md) |
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

`--child` is refused by the commands that cannot honour it — `thread`,
`commonfiles`, `notifications` and the rest — rather than being accepted and
ignored, which is how `digest --child` used to answer the whole family's
question while looking like it had filtered.

## `doctor`

The test suite stubs `fetch`, so a green run proves the client is internally
consistent and says exactly nothing about whether Aula still behaves. `doctor`
is the other half: it walks every endpoint in sequence — sequentially, so the
timings mean something — and reports what came back.

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
returns a *successful-looking* response, so a report that only said PASS/FAIL
would confidently pass on exactly the failures worth catching. A warning is a
call that succeeded and returned something the field notes list as a symptom;
it does not fail the run. Only a thrown error does, and then the exit code is
`1`. Checks are independent, so one dead endpoint does not stop the walk.

It also reads each vendor widget for real, which is where breakage usually is —
those are third-party products that go down independently of Aula.

`doctor` never reads the cache. A cached `PASS` would be a report on a request
it did not send.

## Caching

The skill runs `digest --days 14` for nearly every question it is asked, and one
digest is ~60 requests: every thread body, several pages of posts, the calendar,
presence, and a weekly plan per vendor widget. So responses are cached on disk
with a short TTL, and a repeat run inside the window makes **no requests at
all**.

```bash
bun src/cli.ts cache status --text
bun src/cli.ts digest --no-cache      # ignore it for this run
bun src/cli.ts cache clear
```

Default TTL is 600s; `--cache-ttl <seconds>` or `$AULA_CACHE_TTL` change it, and
`0` disables it. [`flat-cache`](https://github.com/jaredwray/cacheable) does the
storage — one JSON file at `~/.aula/cache/responses`, `0600`, expiry stamped per
entry and enforced on read, which is what makes it survive between processes.

Two things are deliberately never cached:

- **`aulaToken.getAulaToken`.** Widget tokens live about a minute, and the
  vendors announce a dead one inconsistently — some `401`, some HTTP 200 with
  `{"message":"JWT-Token expired…"}`, SkolePortal a `302`. `WidgetTokens`
  recovers by minting a fresh token and retrying once; serving that from cache
  would hand back the same dead string and turn a routine expiry into a hard
  failure. Weekly plans are instead cached one level up, at the plan, so a hit
  skips the token and the vendor round-trip together.
- **Anything that failed.** Only a status-0 envelope is stored, so a transient
  403 is not pinned for the length of the TTL.

The TTL is the only invalidation — nothing here can tell that a new message
arrived. `login`, `logout` and `refresh-stepup` each drop the cache, because
those change *what the account can see* rather than just what it has seen; the
step-up one matters most, since sensitive threads cached by a non-stepped-up
session are empty and look like success.

## Read-only by construction

The project may only read. Rather than relying on call sites to behave, every
request funnels through a transport that checks the target against an allowlist
and throws before opening a socket. There are two, because there are two kinds
of outbound call.

**Aula's own API** — [`src/client.ts`](src/client.ts):

```ts
export function assertReadOnly(method: string, httpMethod: 'GET' | 'POST', opts?): void
```

`calendar.getEventsByProfileIdsAndResourceIds` is the only method allowed to use
POST — Aula models that particular *read* as a POST because the filter payload
does not fit in a query string. Tests assert that every allowlisted method
matches `READ_METHOD_PATTERN`, so the list cannot quietly grow a write.

The `raw` command widens the check from the named allowlist to that same
pattern — `module.get*`, `module.is*`, `module.has*`, anchored at both ends —
and still refuses POST. So an endpoint nobody has wrapped yet is reachable, and
a write still is not.

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
is the one that *writes*. `aula-mcp` supports it behind an `AULA_MCP_WRITE=1`
flag; adding it here would invert the invariant above rather than extend it.
`schedule` reads the same templates, so you can see the plan; changing it stays
in the browser unless you decide otherwise.

## The API

Undocumented and internal. Everything below was derived from live responses,
from Aula's own frontend bundle, and from the two prior-art projects; treat it
as observed behaviour, not contract.

> Working on this code? Read [AGENTS.md](AGENTS.md) first. It collects the
> failure modes that return a *successful-looking* response — empty lists,
> silent truncation, one status code meaning two things — which are the ones
> that waste an afternoon.

Base URL is `https://www.aula.dk/api/v{N}/`, currently **v24**. Every response
is wrapped:

```json
{ "status": { "code": 0, "message": "OK" }, "data": … }
```

### The token is not enough on its own

This one is worth knowing before you debug it the hard way. The OAuth access
token goes in as `?access_token=…` — Aula rejects `Authorization: Bearer`
outright — but the token by itself only unlocks `profiles.getProfilesByLogin`
and `profiles.getProfileContext`. Every other method answers **HTTP 403 with
status code 10** until a session has been bootstrapped:

1. `profiles.getProfilesByLogin` mints `PHPSESSID` and `Csrfp-Token`
2. `profiles.getProfileContext?portalrole=guardian` **activates a profile** in
   that session
3. the module endpoints now answer — gated on the session, not on the token

So the client has to keep a cookie jar across requests. Using a bare `fetch`
that discards `Set-Cookie` produces a token that looks valid (`whoami` works!)
while everything else 403s. `AulaClient` does this in `#ensureSession`.

### Status codes

The envelope code is the one that matters — it does **not** track the HTTP
status, and Aula overloads both layers. Note that code `10` means two unrelated
things, told apart only by the HTTP status: `410` is a retired API version,
`403` is a session that has not activated a profile.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `0` | 200 | OK |
| `10` | 410 | Retired API version, or unknown method |
| `10` | 403 | Session has not activated a profile — see above |
| `40` | 200 | Bad or missing parameters |
| `403` | 403 | Not allowed to read this: a wrong id set, or a calendar window over 50 days |
| `448` | 403 | Not authenticated — credentials expired |

Retired versions answer *every* call with `10`, so the client probes for a live
version rather than dying on a hardcoded constant.

### The three id spaces

This is the one thing that makes the API confusing, and the cause of most 403s:

- `profileId` — the **person**, stable across institutions.
- `id` — that person **at one institution** ("institution profile").
- `userId` — an opaque per-child token (`alma0101`). No Aula endpoint wants it;
  every third-party widget does.

Nearly every Aula endpoint wants the institution-profile `id`, and which ids are
valid differs per endpoint:

| Endpoint | Accepts |
| --- | --- |
| `posts.getAllPosts` | guardian ids **and** children ids — omitting the children returns an empty list with status `0`, not an error |
| `gallery.getAlbums` | children ids, as `filterInstProfileIds[]` — guardian ids are accepted but add nothing, and omitting the filter returns albums from institutions the family has *left* |
| `calendar.getEvents…` | children ids **only** — including guardian ids returns `403` |
| `presence.getDailyOverview` | children ids only, as `childIds[]` |
| `presence.getPresenceTemplates` | children ids only, as `filterInstitutionProfileIds[]` |
| `groups.getGroupsByContext` | children ids, as `childInstitutionProfileIds[]` |

[`src/family.ts`](src/family.ts) resolves these once into
`postInstitutionProfileIds`, `childInstitutionProfileIds` and `institutionCodes`
so no call site has to re-derive them.

### Endpoints used

| Method | HTTP | Notes |
| --- | --- | --- |
| `profiles.getProfilesByLogin` | GET | Guardian + children, with all three id spaces |
| `profiles.getProfileContext` | GET | `portalrole=guardian`; institutions, groups, `isSteppedUp`, widget configuration |
| `profiles.getContactlist` | GET | `groupId`, `filter`, `page`; **1-based** paging, unlike the rest |
| `groups.getGroupsByContext` | GET | `childInstitutionProfileIds[]`; class and team membership |
| `messaging.getThreads` | GET | `sortOn=date&orderDirection=desc&page=N`, 20/page |
| `messaging.getMessagesForThread` | GET | `threadId`, `page`; full bodies |
| `posts.getAllPosts` | GET | `parent=profile`, `index`, `limit`, `institutionProfileIds[]` |
| `gallery.getAlbums` | GET | `index`, `limit`, `sortOn=mediaCreatedAt`, `orderDirection`, `filterBy=all`, `filterInstProfileIds[]`; the filter is **not** optional |
| `calendar.getEventsByProfileIdsAndResourceIds` | POST | `{instProfileIds, resourceIds, start, end}`; window capped at 50 days |
| `commonFiles.getCommonFiles` | GET | `institutionCodes[]`, `index`, `limit`, and a mandatory `orderField=title` |
| `presence.getDailyOverview` | GET | `childIds[]` — what happened today |
| `presence.getPresenceTemplates` | GET | `filterInstitutionProfileIds[]`, `fromDate`, `toDate` — the recurring plan |
| `notifications.getNotificationsForActiveProfile` | GET | Unread badges |
| `aulaToken.getAulaToken` | GET | `widgetId`; the bearer token a vendor API accepts |

Array parameters use PHP-style repeated keys: `childIds[]=1&childIds[]=2`.

Calendar `start`/`end` are **not** ISO-8601. Aula wants
`YYYY-MM-DD HH:mm:ss.SSSS+ZZZZ` (e.g. `2026-08-12 00:00:00.0000+0200`); an ISO
string is rejected. See `formatAulaDate`.

`gallery.getAlbums` sorts on `mediaCreatedAt` — the only `sortOn` value that
works — and then does not return it. The one date in the payload is
`creationDate`, which the wire order therefore contradicts: in live data an
album from 29 July arrives above one from 4 August. Anything that cares about
dates has to sort on `creationDate` itself, and cannot stop paging at the first
row outside a window. Two other shapes to know: the first row is always a
synthetic tagged-media bucket with `id: null` and is not an album, and
`thumbnailsUrls` is a cover preview capped at one entry, so its length is not a
photo count.

### Presence status

`presence.getDailyOverview` returns a numeric `status`. The values are not
contiguous and not in an obvious order:

| Value | Danish | |
| --- | --- | --- |
| `0` | Ikke kommet | not arrived |
| `1` | Syg | sick |
| `2` | Ferie/fri | holiday or day off |
| `3` | Kommet/til stede | present |
| `4` | På tur | on a field trip |
| `5` | Sover | sleeping |
| `8` | Gået | checked out |

### Sensitive threads

Threads flagged `sensitive: true` are readable only when the session is stepped
up (`isSteppedUp` in `profiles.getProfileContext`). These tend to be the ones
about an individual child, so a non-stepped-up session silently returns a less
complete picture — `whoami` surfaces the flag for that reason.

### Attachments

Aula does not serve attachments itself: it hands out CloudFront presigned URLs
valid for about an hour, where the signature *is* the authorisation. They must
be fetched with no cookie and no `Authorization` header, and they should not
make a round trip through a model — they are long opaque blobs, and one mangled
character produces a `MalformedSignature` 403 that reads like an auth failure.
`attachment` downloads server-side and returns a path for that reason.

## Widgets and weekly plans

Aula itself carries messages, posts, calendar and presence. Everything a school
actually teaches with — weekly plans, homework, reminders — lives in a product
the municipality bought separately and embedded as a "widget". So the
interesting half of "what is happening at school" is not in the Aula API at all.

The bridge is `aulaToken.getAulaToken?widgetId=NNNN`: Aula mints a short-lived
JWT scoped to one widget, and the vendor's own API accepts it as a bearer token.
`profiles.getProfileContext` lists which widgets a school exposes under
`pageConfiguration.widgetConfigurations`, so the right provider is detected
rather than configured. Run `widgets` to see what yours has.

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

### Gotchas the integrations bake in

- **Tokens expire quietly.** Some vendors answer `401`; others answer HTTP 200
  with `{"message":"JWT-Token expired, please renew."}`; SkolePortal answers a
  `302` to its own login page. All three are treated as expiry, and the call is
  retried once with a fresh token.
- **`sessionId` means two different things.** MinUddannelse and EasyIQ want the
  Aula guardian `userId`. Meebook (`sessionuuid` header) and Systematic
  (`sessionId` query) want the **MitID username**, which exists nowhere in the
  API because it is what you type into MitID. Set it with
  `session username <name>` or `$AULA_MITID_USERNAME`; without it those two fall
  back to the guardian id and say so in `warnings`.
- **Meebook keys on UniLogin.** `childFilter[]` takes `Child.userId`, not the
  numeric id — the number returns *"Fandt et unilogin i child filter med et
  ugyldigt format"*. Meebook also requires a one-time interactive SSO: open the
  Meebook widget inside aula.dk once before the API will answer. That
  instruction comes back per-child with HTTP 200 and is surfaced verbatim.
- **SkolePortal is picky about headers.** `origin`/`referer` must point at
  SkolePortal rather than aula.dk, the user-agent must look like a desktop
  browser, and the referer must match the widget (`/UgeplanWidget` vs
  `/LektierWidget`). Get one wrong and it answers `302`, which looks like an
  auth failure.
- **SkolePortal dates need a time.** `date=YYYY-MM-DD` is accepted and silently
  returns nothing; it wants `YYYY-MM-DDT00:00:00.000Z`.

## Not covered

- **Writing anything.** See [What is deliberately
  missing](#what-is-deliberately-missing).
- **Photos themselves.** `galleries` reads album *metadata* — title, date,
  photographer, which group — because that is the part that says what a day
  contained. The images stay in Aula.
- **Comments on posts.** Neither prior-art project reads them; `raw` will reach
  the endpoints if you work out their names.

## Development

```bash
bun install
bun run typecheck
bun test src/
```

Tests stub `fetch`, so they never touch the network or need a session — and for
that reason they cannot tell you the API still behaves. `doctor` is what does
that. Vendor payloads in `integrations.test.ts` are trimmed copies of shapes the
prior-art projects observed live.

`typecheck` runs TypeScript 7, which is the Go rewrite of the compiler — it
ships a real native binary per platform, so a full check of this project takes
well under a tenth of a second. Bun transpiles rather than type-strips, so
unlike Node it imposes no restrictions on which TypeScript syntax is allowed;
relative imports still keep their real `.ts` extension.

Layout:

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
to reimplement. It is MIT-licensed; provenance, the exact upstream commit, and
any local changes are recorded in
[`src/vendor/aula-auth/VENDOR.md`](src/vendor/aula-auth/VENDOR.md).

It is a copy rather than a dependency because the upstream package is
`private: true` and source-only, so it cannot be installed from npm. Its own 13
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

Between them they cover every provider either project has seen in the wild;
this project reads everything they read, minus the one write.

## Privacy

The data is personal and concerns children. Both credentials grant full read
access to the account, and the MitID **refresh token is long-lived**.

**What leaves your machine.** Aula data is stored and processed locally. The
one exception is `aula brief`, which sends a trimmed excerpt of recent Aula
content to Anthropic — through your own installed `claude` CLI, so on your
account, as your model calls. Nothing else is transmitted, and there is no
telemetry.

Everything lives in `~/.aula`, which is `0700`, with every file `0600`: the
encrypted tokens, the key that opens them (unless `$AULA_TOKEN_KEY` is set — see
[Where the key lives](#where-the-key-lives)), the cookie jar, the cookie
fallback, downloaded attachments, and the response cache. The cache is
plaintext message bodies, the same as the attachments beside it; the directory
mode is what protects all of it. `.gitignore` excludes `session.json`, `.env`
and `data/`.

In the repo itself, anything that contains real family data — captured
payloads, fixtures cut from live responses, personal notes — belongs in the
gitignored `data/` folder, never in tracked files. See
[`data/README.md`](data/README.md).

`bun run logout` clears the tokens, the cookie jar and the cache. Keep command
output out of anywhere shared.

## License

MIT — see [LICENSE](LICENSE). The vendored
[`src/vendor/aula-auth`](src/vendor/aula-auth) is likewise MIT, Copyright (c)
2026 Casper Juel; its provenance, upstream commit and local changes are
recorded in [`src/vendor/aula-auth/VENDOR.md`](src/vendor/aula-auth/VENDOR.md).
