# Going around aula-cli

For an agent that has the `aula` binary and no checkout. Print it with `aula
--upstream`; it costs nothing until you ask. It answers one question: **the
family needs something this CLI does not wrap — now what?**

`API.md` in the repository is the developer-facing wire reference and goes
deeper. This file is the part you can act on without it.

## 1. When to bypass, and when not to

Reach for the bypass only after checking that no command already does it.
`aula --help` lists them all; `aula --contract` states what each one emits, key
by key. The wrapped reads are: `digest`, `messages`, `thread`, `posts`,
`galleries`, `calendar`, `presence`, `pickup-times`, `groups`, `contacts`,
`birthdays`, `notifications`, `attachments`, `attachment`, `post-attachment`,
`commonfiles`, `commonfile`, `widgets`, `weekly-plan`, `whoami`, `status`,
`doctor`.

A wrapped command is better than a hand-rolled call every time: it resolves the
id sets Aula wants (getting those wrong returns an empty list and HTTP 200, not
an error), pages to the end, reports a truncated list as truncated, grades a
vendor read that failed instead of printing it as a quiet week, and keeps
presigned attachment URLs out of the payload.

Bypass when:

- the read exists in Aula but has no command here — a module this CLI never
  wrapped, or a parameter a command does not expose;
- you need the untouched payload, because a mapper here drops a field;
- you are checking whether an upstream field was renamed.

## 2. The upstreams

**Aula itself** — `https://www.aula.dk/api`, and the API version is in the
path, not a header:

    https://www.aula.dk/api/v24/?method=<module>.<name>&<params>&access_token=<token>

Everything is one path with a `?method=` query parameter; there are no REST
routes. `24` is the version this build starts from, and it is not permanent —
see the version probe in §6.

These are the methods this CLI calls, which is also the list of names known to
be live:

    profiles.getProfilesByLogin
    profiles.getProfileContext
    profiles.getContactlist
    messaging.getThreads
    messaging.getMessagesForThread
    posts.getAllPosts
    gallery.getAlbums
    calendar.getEventsByProfileIdsAndResourceIds
    presence.getDailyOverview
    presence.getPresenceTemplates
    groups.getGroupsByContext
    notifications.getNotificationsForActiveProfile
    commonFiles.getCommonFiles
    aulaToken.getAulaToken

Aula's own bundle has about 304 of them — §7 says how to read the rest out.

**The vendor widgets**, which are separate companies' APIs that Aula hands a
short-lived JWT for. Weekly plans, tasks and reminders live here, not in Aula:

    https://api.minuddannelse.net/aula/opgaveliste
    https://api.minuddannelse.net/aula/ugebrev
    https://app.meebook.com/aulaapi/relatedweekplan/all
    https://api.easyiqcloud.dk/api/aula/weekplaninfo
    https://skoleportal.easyiqcloud.dk/Aula/AuthenticateAulaUser
    https://skoleportal.easyiqcloud.dk/Aula/GetChildren
    https://skoleportal.easyiqcloud.dk/Calendar/CalendarGetWeekplanEvents
    https://skoleportal.easyiqcloud.dk/AulaHuskeliste/GetWeekplanEvents
    https://systematic-momo.dk/api/aula/reminders/v1

## 3. Auth, and why you are not given the session

Aula gates on a PHP session, not on the token, and getting one is three steps:

1. The OAuth access token rides as `?access_token=…` in the query string. An
   `Authorization: Bearer` header is **ignored** — you get the same `403`/`448`
   as sending no credentials at all.
2. `profiles.getProfilesByLogin` mints `PHPSESSID` and `Csrfp-Token` cookies.
3. `profiles.getProfileContext?portalrole=guardian` *activates* a profile in
   that session. Until it has run, every module method answers `403` with
   status code `10`, which reads like a bad token and is not.

So the cookie jar has to persist across requests. `Csrfp-Token` is sent as a
header on POST only; a POST without it is `400`/`40`.

**The session is deliberately not handed out, and that is not an oversight.**
The tokens live in `~/.aula`, encrypted with AES-256-GCM, and there is no
command that prints one. Two reasons, and the second is the one that bites:

- it is the user's own identity at their children's school, and a credential
  that leaves this process ends up in a transcript;
- a `refresh_token` grant **retires the previous access token immediately**,
  whatever its `exp` says. A token you copied out stops working the moment
  anything else refreshes, and your copy retires the token of any `aula` run
  beside you. A curl recipe here would be a trap, not a shortcut.

**`aula raw` is the supported route.** It reuses this process's own transport —
the version probe, the bootstrap, the cookie jar, the CSRF header, the
superseded-token replay — and prints the untouched payload:

```bash
aula raw <module>.<method> key=value key=value
aula raw <module>.<method> --body '<json>'
```

It is read-only and structurally so: a method name is refused locally, before a
socket opens, unless it is `module.get*`, `module.is*` or `module.has*`.
`messaging.sendMessage` is refused over GET and POST alike. Anything unreadable,
blocked or unreachable exits 1; a name Aula does not have, or one the guard
refuses, exits 2 — your command line, not the source.

## 4. Runnable examples

Aula, a plain read with parameters:

```bash
aula raw presence.getDailyOverview childIds=11 childIds=22 --no-cache
```

Aula, a read it models as a POST. The calendar is the one that matters: the
wrapper offers a forward window only, and Aula caps any window at 50 days.

```bash
aula raw calendar.getEventsByProfileIdsAndResourceIds --body '{"instProfileIds":[11,22],"start":"2026-01-05 00:00:00.0000+0100","end":"2026-02-20 00:00:00.0000+0100"}'
```

The ids come from `whoami`, which prints the three id sets Aula's endpoints
want, already resolved — getting them by hand is the most common way to end up
with a wrong answer that looks like a right one:

```bash
aula whoami --no-cache
```

A vendor widget is two steps, and curl genuinely works for the second. Step
one mints the JWT through the Aula session:

```bash
aula raw aulaToken.getAulaToken widgetId=0004 --no-cache
```

Step two spends it. The JWT lives about a minute, so mint it immediately
before:

```bash
curl -s 'https://app.meebook.com/aulaapi/relatedweekplan/all?childFilter[]=<userId>&institutionFilter[]=<institutionCode>' \
  -H 'authorization: Bearer <the JWT from step one>' \
  -H 'sessionuuid: <the MitID username>' \
  -H 'x-version: 1.0' \
  -H 'origin: https://www.aula.dk' \
  -H 'referer: https://www.aula.dk/'
```

`aula widgets` lists the widget ids the family actually has. The well-known
ones are stable across every school in Denmark: `0001` EasyIQ Ugeplan, `0004`
Meebook, `0023`/`0030` MinUddannelse Opgaveliste, `0029` MinUddannelse Ugebrev,
`0062` Huskelisten, `0128` EasyIQ SkolePortal Ugeplan, `0142` EasyIQ Lektier.

## 5. The response shape

Every Aula response is the same envelope:

```json
{ "status": { "code": 0, "message": "", "subCode": null, "errorInformation": [] },
  "data": {},
  "trace": null }
```

Only `status.code` is reliable; `message` is usually empty. `aula raw` prints
the envelope's `data`, not the envelope.

| `status.code` | HTTP | What it means |
| --- | --- | --- |
| `0` | 200 | OK — **and also** the 500 described below |
| `10` | 410 | Retired API version; every method answers this |
| `10` | 404 | No such method name |
| `10` | 403 | No activated profile, or an id this login cannot access |
| `20` | 403 | Access token superseded by a newer one |
| `40` | 400 | Bad or missing parameters; never says which |
| `403` | 403 | Refused: an institution code you do not hold, or a calendar window over 50 days |
| `448` | 403 | Not authenticated: no token, or expired |

## 6. Pitfalls, and what each one cost

- **Array parameters need a repeated bare key, and the two obvious spellings
  are both wrong.** `aula raw` turns a repeated key into Aula's PHP-style
  `key[]=a&key[]=b`, which is what Aula wants. So write `childIds=11
  childIds=22`. Writing `childIds=11` once sends `childIds=11` with no
  brackets, and writing `'childIds[]=11' 'childIds[]=22'` sends
  `childIds[][]=11`. Neither is an error: a wrong id set comes back as an empty
  list with code `0`, which reads as "nothing to report". A comma-joined value
  is code `40`.
- **A rejected token is HTTP 500 with status code `0`** and `"intern fejl"` as
  the data — success-shaped, and identical to Aula being down. Nothing in the
  body admits to being about credentials. Telling the two apart takes a
  credential-free request: Aula answers `403`/`448` while healthy and 5xxes
  while it is not.
- **The API version is retired without warning, and then *every* method
  answers `10`.** This build starts at v24 and probes upward when that happens;
  the probe prints the live version to stderr and `AULA_API_VERSION=<n>` pins
  it. A blanket `10` on a method you know exists is this, not your parameters.
- **`posts.getAllPosts` wants the guardian's id AND the children's** in
  `institutionProfileIds[]`. Drop either half and you get an empty list at code
  `0` — a silent wrong answer, which is why `aula whoami` resolves the sets.
- **`gallery.getAlbums` without `filterInstProfileIds[]`** returns a
  full-looking list of albums from institutions the family has *left*.
- **`messaging.getThreads` truncates the message preview mid-word** with no
  marker. Fetch `messaging.getMessagesForThread` before quoting anything.
- **`gallery.getAlbums` sorts on a field it does not return.**
  `sortOn=mediaCreatedAt` is accepted; the payload carries `creationDate`. So
  you cannot stop paging at the first out-of-window row. The first row is a
  synthetic bucket with `id: null`, not an album.
- **`commonFiles.getCommonFiles` takes `institutionCodes[]`**, a different id
  space from everything else; a profile id there is a `403`. `orderField`
  accepts only `title`.
- **A vendor widget token expires in three different shapes**: `401`, or HTTP
  200 carrying `{"message":"JWT-Token expired, please renew."}`, or a `302` to
  a login page. All three mean the same thing.
- **Sensitive threads need a stepped-up session** — Aula masks the title and
  withholds the preview rather than omitting the thread, so a non-stepped-up
  read looks complete. `aula status` says whether the session is stepped up.

## 7. Finding what is not listed here

Aula's method names are in its own JavaScript bundle:

```bash
curl -s https://www.aula.dk/portal/ -o portal.html
grep -oE 'src="/static/js/[^"]*"' portal.html | sed 's/src="//;s/"//' | while read -r p; do curl -s "https://www.aula.dk$p" -O; done
grep -ohoE '\?method=[a-zA-Z]+\.[a-zA-Z]+' ./*.js | sed 's/?method=//' | sort -u
```

That is about 304 names, and it needs no credentials — the bundle is public.
It gives you names, not parameters: a wrong parameter set is code `40` with no
detail, so confirm a guess with `aula raw <method>` and add parameters until it
answers. In the browser's devtools the store action shows the request and the
component builds the params.

## 8. The boundary

- **Never write to Aula.** This client is read-only and enforces it locally,
  before a socket opens. Do not look for a way around the guard: no messages,
  no posts, no calendar answers, nothing marked as read. Whatever you are
  holding, a school system is not the place to test whether a write goes
  through.
- **Never perform or ask for a MitID approval.** That is the user's phone and
  their identity. `aula login` is the user's decision to make — ask, never
  start one to get unblocked. An abandoned login trips MitID's parallel-session
  detector for the attempt after it.
- **Never copy a credential out of the process.** See §3: it will not work for
  long and it breaks the runs beside you.
- **This is one family's private data**, not a public register — their
  children's school and daycare. Read what the task asked for and nothing else,
  and do not put a real name into a file in this repository, which is public.
