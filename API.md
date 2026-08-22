# The Aula API

Reverse-engineered reference for anyone working on this client. Undocumented and
internal: everything here was derived from live responses, from Aula's own
frontend bundle, and from the two prior-art projects. Treat it as observed
behaviour, not contract.

> Project rules live in [AGENTS.md](AGENTS.md). This file is the wire.
> Everything below was re-checked against the live API on **2026-08-22**;
> `doctor` is how you re-check it.

Base URL is `https://www.aula.dk/api/v{N}/`, currently **v24**. Every response
is wrapped:

```json
{ "status": { "code": 0, "message": "OK" }, "data": … }
```

## Failures that look like success

Most of what goes wrong here returns a healthy-looking response. Keep these in
mind before trusting any quiet result:

- A module call before the session bootstrap: `403` + code `10`, which reads as
  a bad token and is not.
- A rejected token: **HTTP 500 with code `0`** and `"intern fejl"` as the
  payload.
- Incomplete ids on `posts.getAllPosts`: an empty list, code `0`.
- `gallery.getAlbums` with no `filterInstProfileIds[]`: a full-looking list of
  albums from institutions the family has left.
- Sensitive threads without step-up: masked or missing, code `0` either way.
- A vendor weekly plan that failed: `items: []` with a `warnings` entry — the
  same shape as a quiet week.
- A thread list: bodies truncated mid-word, with no marker saying so.

## The token is not enough on its own

The OAuth access token goes in as `?access_token=…`. An `Authorization: Bearer`
header is ignored, so a client that sends only that gets the same `403` + code
`448` as one sending no credentials at all. The token by itself unlocks only
`profiles.getProfilesByLogin` and `profiles.getProfileContext`. Every other
method answers **HTTP 403 with status code 10** until a session has been
bootstrapped:

1. `profiles.getProfilesByLogin` mints `PHPSESSID` and `Csrfp-Token`
2. `profiles.getProfileContext?portalrole=guardian` **activates a profile** in
   that session
3. the module endpoints now answer — gated on the session, not on the token

So the client has to keep a cookie jar across requests. A bare `fetch` that
discards `Set-Cookie` produces a token that looks valid (`whoami` works!) while
everything else 403s. `AulaClient` does this in `#ensureSession`.

## Status codes

The envelope code is the one that matters — it does **not** track the HTTP
status. Code `10` means two unrelated things, told apart only by the HTTP
status.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `0` | 200 | OK |
| `10` | 410 | Retired API version — *every* method answers this |
| `10` | 404 | Unknown method name on a live version |
| `10` | 403 | Session has not activated a profile, **or** the request named an id this guardian cannot access |
| `20` | 403 | Token superseded — see below |
| `40` | 400 | Bad or missing parameters |
| `403` | 403 | Permitted-but-refused — in practice a calendar window over 50 days |
| `448` | 403 | Not authenticated — credentials expired, or no token sent |

The envelope carries more than `code` and `message`: a failure also has `subCode`
and `errorInformation`, alongside a top-level `trace`. Code `20` arrives with
`subCode: 9`.

Code `10` is the awkward one: three unrelated causes, separated only by the HTTP
status, and the 403 case is itself ambiguous between a session problem and a
foreign id. A wrong id set does **not** produce code `403`.

Retired versions answer *every* call with `10`, so the client probes for a live
version rather than dying on a hardcoded constant. The probe warns when the
default is stale; `AULA_API_VERSION=<N>` pins the version and skips it (the
warning also surfaces once in the test run, from the stubbed Aula — that is the
probe working, not a failure).

### Three different ways a token can be refused

Telling them apart matters, because the fixes differ:

| | |
| --- | --- |
| No token | `403` + code `448` |
| A token Aula cannot parse | **`500` + code `0`** (below) |
| A token that has been **superseded** | `403` + code `20`, `subCode 9` |

Code `20` is the one that surprises. An OAuth `refresh_token` grant rotates the
previous access token out immediately, so a token that is nowhere near its `exp`
stops working the moment anything else refreshes the same login — two `aula`
processes overlapping, say, or a manual command during the scheduled brief's
retry window. Aula's own frontend treats it as fatal and redirects to
`/auth/logout.php`; here the client recovers instead, and the user never sees
it. It is never a reason to send anyone back to MitID.

`AulaClient` handles it by re-reading the token store, adopting a newer token if
one is there and buying a fresh one only if not, then replaying the request
once. Reading before refreshing is the load-bearing part: it lets the run that
lost the race adopt the winner's token, where two runs that both refreshed would
rotate each other's tokens indefinitely. The Aula session survives the swap —
it is keyed on `PHPSESSID`, not on the token — so nothing needs re-activating.

A token Aula cannot parse at all — malformed, or from a login it has forgotten —
is not in the table, because it comes back as **HTTP 500 with code `0`**:

```
{"status":{"code":0,"message":"intern fejl"},"data":"intern fejl"}
```

The envelope says success, so the failure surfaces wherever that string first
fails to be an object. Sending *no* token gets a clean `403` + `448`; this 500
is specifically how Aula reports a token it dislikes. Aula returns the same 500
when it is genuinely down, and the body does not distinguish them — but a
credential-free request does: it answers cleanly while Aula is healthy and 5xxes
while it is not. `AulaClient.#serverError` makes that one extra request so the
error can say which happened, because the fixes are opposite (log in again, or
wait). Never trust the envelope on a 5xx.

## The three id spaces

This is the one thing that makes the API confusing, and the cause of most 403s:

- `profileId` — the **person**, stable across institutions.
- `id` — that person **at one institution** ("institution profile").
- `userId` — an opaque per-child token (`alma0101`). No Aula endpoint wants it;
  every third-party widget does.

Nearly every Aula endpoint wants the institution-profile `id`, and which ids are
valid differs per endpoint:

| Endpoint | Accepts |
| --- | --- |
| `posts.getAllPosts` | guardian ids **and** children ids — drop either half and you get an empty list with status `0`, not an error |
| `gallery.getAlbums` | children ids, as `filterInstProfileIds[]` — omitting the filter returns albums from institutions the family has *left* |
| `calendar.getEvents…` | children ids; guardian ids are accepted and add nothing. An id the guardian cannot access fails the whole call with `403` + code `10` |
| `presence.getDailyOverview` | children ids only, as `childIds[]` |
| `presence.getPresenceTemplates` | children ids only, as `filterInstitutionProfileIds[]` |
| `groups.getGroupsByContext` | children ids, as `childInstitutionProfileIds[]` |

[`src/family.ts`](src/family.ts) resolves these once into
`postInstitutionProfileIds`, `childInstitutionProfileIds` and `institutionCodes`
so no call site has to re-derive them.

## Endpoints used

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

Calendar `start`/`end` are sent as `YYYY-MM-DD HH:mm:ss.SSSS+ZZZZ`
(`2026-08-12 00:00:00.0000+0200`) — see `formatAulaDate`. That is Aula's own
format, but it is not the only one accepted: ISO-8601 and a bare `YYYY-MM-DD`
both work and return identical results over the same window. What *does* matter
is the offset — an ISO string in `Z` and a local-midnight timestamp describe
different windows, so a boundary event can appear in one and not the other.

The call is a POST that reads — the only POST on the allowlist — and needs
`Csrfp-Token` from the cookie jar; a GET answers `400` + code `40`. The window
is capped at exactly **50 days**: 50 passes, 51 returns `403` + code `403`. The
client refuses over-long windows locally so the error says what is wrong.

`gallery.getAlbums` sorts on `mediaCreatedAt` and then does not return it, so
the wire order contradicts the one date in the payload (`creationDate`).
Anything date-sensitive has to sort on `creationDate` itself, and cannot stop
paging at the first row outside a window. `title` and `id` are also accepted as
`sortOn`; `creationDate`, `created` and `name` are not, and fail with `400` +
code `10`. The first row is a synthetic tagged-media bucket with `id: null`
("Medier af dig og dine børn"), not an album — it carries several
`thumbnailsUrls`, while real albums carry one or none, so that field is never a
photo count.

Omitting `filterInstProfileIds[]` does not widen the result, it *replaces* it:
the unfiltered call returns a disjoint set of older albums belonging to
institutions the family has since left.

## Messages

Thread *lists* (`getThreads`) truncate the body mid-sentence;
`latestMessage.text.html` is a preview. Fetch `getMessagesForThread` before
quoting or summarising. Message HTML is pretty-printed: `</div>\n<div>` is
insignificant whitespace, while a deliberate blank line is `<div> </div>` or
`<br><br>`. Treating the newlines as real double-spaces the output.

## Fælles Filer (`commonFiles.getCommonFiles`)

The shared-file shelf (timetables, holiday plans, policies) is its own module,
not attachments and not documents. `orderField` is optional, but `title` is the
only value it accepts: `created`, `name`, `createdAt`, `fileName` and `date` all
fail with status `40` and an empty `errorInformation`, while omitting the
parameter succeeds and returns a different default order. So there is no way to
sort by date server-side — do it client-side. It filters on `institutionCodes[]`,
a fourth addressing scheme; a profile id here fails with `403`. `limit` is
capped at exactly 50 (51 already returns `40`). Response is
`{commonFiles, totalAmount}`, paged with `index`. Each entry nests as
`file.file`: the outer object is the attachment record (name, uploader,
virus-scan `status`), the inner one the stored blob with the presigned URL.
Entries whose `status` is not `available` have no URL yet.

## Presence status

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

## Sensitive threads

Threads flagged `sensitive: true` need the session stepped up (`isSteppedUp` in
`profiles.getProfileContext`). They tend to be the ones about an individual
child, so this is the least affordable thing to under-report — `whoami` surfaces
the flag for that reason.

What a non-stepped-up session actually sees is **not confirmed against the live
API**, because there is no way to arrange one on demand: Aula has exactly two
session methods, `session.keepAlive` and `session.stepUpCurrentSession`, and no
step-down. Step-up survives a plain `refresh_token` grant, and survives the
broker SSO session expiring, so it can only lapse on Aula's own timer.

The evidence from Aula's frontend points at masking rather than omission. It
reads a per-thread **`requiresStepUp`** flag — a field the API does *not* return
to a stepped-up session — and when it is set, renders the thread with its title
replaced by a "sensitive content" placeholder and its preview withheld
(`canSeeLastMessage(){ return draft || !requiresStepUp }`). So expect such
threads to arrive present-but-masked, and treat a `requiresStepUp` appearing on
a thread as the signal that step-up has lapsed.

`refresh-stepup` restores step-up without MitID, but **only while the broker SSO
session is alive** — roughly a day. After that it fails cleanly and a full
`login` is the only way back.

## Attachments

Aula hands out CloudFront presigned URLs valid for about an hour, where the
signature *is* the authorisation. They must be fetched with no cookie and no
`Authorization` header, and they should not make a round trip through a model —
they are long opaque blobs, and one mangled character produces a
`MalformedSignature` 403 that reads like an auth failure. `attachment` downloads
server-side and returns a path for that reason.


## MitID login

- MitID picks the channel-binding mode **per account**: OTP to compare, or TQR
  (scan a QR, split across two codes that refresh together). Handle only one and
  the other polls forever, looking like a hang. Both callbacks must be wired.
- There is **no session-teardown endpoint**. An abandoned login stays live on
  MitID's side and the next attempt trips the parallel-session detector
  (CAP008). Killing the CLI mid-login tells MitID nothing; it can only be waited
  out — reject the pending prompt in the app, close aula.dk tabs, wait 60 s+.
- The login jar holds cookies for `login.aula.dk`, `broker.unilogin.dk` and
  `nemlog-in.mitid.dk` — nothing for `www.aula.dk`. The API session comes from
  the bootstrap at the top of this file.
- MitID sends `null`, not absence, for optional fields (`"nextAuthenticator":
  null` on a `/next` that reports an error). A guard that treats optional as
  only `undefined` rejects the whole response, and the payload underneath is
  usually the CAP008 message. `isOptional` in `src/validation.ts` accepts both.
  JSON has no `undefined`; assume nullable at every wire boundary.

## Vendor widget gotchas

- **Tokens expire quietly.** Some vendors answer `401`; others answer HTTP 200
  with `{"message":"JWT-Token expired, please renew."}`; SkolePortal answers a
  `302` to its own login page. All three are treated as expiry, and the call is
  retried once with a fresh token.
- **`sessionId` means two different things.** MinUddannelse and EasyIQ want the
  Aula guardian `userId`. Meebook (`sessionuuid` header), Systematic
  (`sessionId` query) and SkolePortal's ugeplan (`x-login` header) want the
  **MitID username**, which exists nowhere in the API because it is what you
  type into MitID. `login` records it on the stored token record; if it is
  missing, log in again — until then those vendors fall back to the guardian id
  and say so in `warnings`.
- **Meebook keys on UniLogin.** `childFilter[]` takes `Child.userId`, not the
  numeric id. Meebook also requires a one-time interactive SSO: open the Meebook
  widget inside aula.dk once before the API will answer. That instruction comes
  back per-child with HTTP 200 and is surfaced verbatim.
- **SkolePortal is picky about headers.** `origin`/`referer` must point at
  SkolePortal rather than aula.dk, the user-agent must look like a desktop
  browser, and the referer must match the widget (`/UgeplanWidget` vs
  `/LektierWidget`). Get one wrong and it answers `302`, which looks like an
  auth failure.
- **SkolePortal dates need a time.** `date=YYYY-MM-DD` is accepted and silently
  returns nothing; it wants `YYYY-MM-DDT00:00:00.000Z`.

