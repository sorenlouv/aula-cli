# The Aula API

Reverse-engineered; observed behaviour, not contract. Re-checked against the
live API on 2026-08-22. Project rules are in [AGENTS.md](AGENTS.md).

Base URL `https://www.aula.dk/api/v{N}/`, currently **v24**. Every response is
wrapped `{ "status": { "code", "message", "subCode", "errorInformation" },
"data", "trace" }`; only `code` is reliable, `message` is usually empty.

## Failures that look like success

- A module call before the session bootstrap: `403` + code `10`, which reads as
  a bad token.
- A rejected token: **HTTP 500 with code `0`** and `"intern fejl"` as `data`.
- Incomplete ids on `posts.getAllPosts`: an empty list, code `0`.
- `gallery.getAlbums` without `filterInstProfileIds[]`: a full-looking list of
  albums from institutions the family has *left*.
- Sensitive threads without step-up: masked or missing, code `0`.
- A vendor weekly plan that failed: `items: []` with a `warnings` entry — the
  shape of a quiet week.
- Thread lists: bodies truncated mid-word, no marker.

## Session bootstrap

The OAuth token travels as `?access_token=…`; an `Authorization: Bearer` header
is ignored (same `403`/`448` as no credentials). The token alone unlocks only
`profiles.getProfilesByLogin` and `profiles.getProfileContext`; everything else
answers `403` + code `10` until:

1. `profiles.getProfilesByLogin` mints `PHPSESSID` and `Csrfp-Token`
2. `profiles.getProfileContext?portalrole=guardian` activates a profile in that
   session

Module endpoints are gated on the session, not the token, so the cookie jar must
persist across requests (`AulaClient.#ensureSession`). The session survives an
access-token swap — it is keyed on `PHPSESSID`.

## Status codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `0` | 200 | OK — also on the 500 carrying `"intern fejl"` (below) |
| `10` | 410 | Retired API version; *every* method answers this |
| `10` | 404 | Unknown method name |
| `10` | 403 | Session has no activated profile, **or** the call named an institution-profile id this login cannot access (one bad id fails the whole call) |
| `20` | 403 | Access token superseded, `subCode 9` |
| `40` | 400 | Bad or missing parameters; never says which |
| `403` | 403 | Refused: an institution code the login does not hold, or a calendar window over 50 days. Not a wrong profile id — that is code `10` |
| `448` | 403 | Not authenticated: no token, or credentials expired |

Retired versions answer every call with `10`, so the client probes for a live
version; `AULA_API_VERSION=<N>` pins it (the probe's warning also shows once in
the stubbed test run).

**Code `20`.** A `refresh_token` grant retires the previous access token
immediately, whatever its `exp`, so two overlapping `aula` runs kill each
other's token. `AulaClient` re-reads the token store, adopts a newer token or
buys one, and replays once; AGENTS.md says why that order matters. Never a
reason to send the user to MitID.

**The 500.** A token Aula cannot parse returns
`HTTP 500 {"status":{"code":0,"message":"intern fejl"},"data":"intern fejl"}` —
identical to Aula being down. A credential-free request separates them: it
answers `403`/`448` while Aula is healthy and 5xxes while it is not.
`AulaClient.#serverError` makes that one request so the error can say "log in
again" or "wait". Never trust the envelope on a 5xx.

## Id spaces

- `profileId` — the person, stable across institutions.
- `id` — that person at one institution ("institution profile"); what nearly
  every endpoint wants.
- `userId` — opaque per-child token (`alma0101`); no Aula endpoint wants it,
  every third-party widget does.
- `institutionCode` — a fourth scheme, used only by `commonFiles`.

| Endpoint | Accepts |
| --- | --- |
| `posts.getAllPosts` | guardian **and** children ids as `institutionProfileIds[]` — drop either half and you get an empty list, code `0` |
| `gallery.getAlbums` | children ids as `filterInstProfileIds[]`; omitting it *replaces* the result with albums from institutions the family has left |
| `calendar.getEvents…` | children ids; guardian ids accepted and add nothing; an unreachable id fails the call with `403` + `10` |
| `presence.getDailyOverview` | children ids as `childIds[]` |
| `presence.getPresenceTemplates` | children ids as `filterInstitutionProfileIds[]` |
| `groups.getGroupsByContext` | children ids as `childInstitutionProfileIds[]` |
| `commonFiles.getCommonFiles` | `institutionCodes[]`; a profile id here is `403` |

`src/family.ts` resolves these once into `postInstitutionProfileIds`,
`childInstitutionProfileIds` and `institutionCodes`.

A fifth identity, the **MitID username**, exists nowhere in the API — it is
what the human types into MitID. Meebook, Systematic and SkolePortal key their
sessions on it; `login` records it on the stored token record.

## Endpoints used

| Method | HTTP | Notes |
| --- | --- | --- |
| `profiles.getProfilesByLogin` | GET | guardian + children, all id spaces |
| `profiles.getProfileContext` | GET | `portalrole=guardian`; institutions, groups, `isSteppedUp`, widgets |
| `profiles.getContactlist` | GET | `groupId`, `filter` (`child`/`guardian`/`employee`), `field=name`, `order=asc`, `page` — **1-based**, unlike the rest |
| `groups.getGroupsByContext` | GET | `childInstitutionProfileIds[]` |
| `messaging.getThreads` | GET | `sortOn=date&orderDirection=desc&page=N`, 20/page |
| `messaging.getMessagesForThread` | GET | `threadId`, `page` |
| `posts.getAllPosts` | GET | `parent=profile`, `index`, `limit`, `institutionProfileIds[]` |
| `gallery.getAlbums` | GET | `index`, `limit`, `sortOn`, `orderDirection`, `filterBy=all`, `filterInstProfileIds[]` |
| `calendar.getEventsByProfileIdsAndResourceIds` | POST | `{instProfileIds, resourceIds, start, end}` |
| `commonFiles.getCommonFiles` | GET | `institutionCodes[]`, `index`, `limit`, `orderField`, `orderDirection` |
| `presence.getDailyOverview` | GET | `childIds[]` — today |
| `presence.getPresenceTemplates` | GET | `filterInstitutionProfileIds[]`, `fromDate`, `toDate` — the recurring plan |
| `notifications.getNotificationsForActiveProfile` | GET | badges; `notificationEventType` is the useful field (`NewMedia` dominates) |
| `aulaToken.getAulaToken` | GET | `widgetId`; a fresh JWT each call, accepted by the vendor API |

Array parameters are PHP-style repeated keys: `childIds[]=1&childIds[]=2`; a
comma-joined value is code `40`.

**Calendar.** The only POST, and it reads; needs `Csrfp-Token` from the jar (a
GET is `400`/`40`). Window capped at exactly 50 days (51 → `403`/`403`); the
client refuses longer windows locally. Dates are sent as
`YYYY-MM-DD HH:mm:ss.SSSS+ZZZZ` (`formatAulaDate`); ISO-8601 and bare
`YYYY-MM-DD` are also accepted and return the same events — only the offset
matters.

**Gallery.** `sortOn=mediaCreatedAt` (also `title`, `id`;
`creationDate`/`created`/`name` are `400`/`10`) sorts on a field the payload
does not return, so date logic must sort on `creationDate` itself and cannot
stop paging at the first out-of-window row. The first row is a synthetic bucket
with `id: null` ("Medier af dig og dine børn"), not an album; `thumbnailsUrls`
is never a photo count.

**Messages.** `getThreads` truncates `latestMessage.text.html` mid-word; fetch
`getMessagesForThread` before quoting. HTML is pretty-printed: `</div>\n<div>`
is insignificant whitespace, a deliberate blank line is `<div> </div>` or
`<br><br>`.

**Fælles Filer.** Its own module, not attachments or documents. `orderField` is
optional but `title` is the only accepted value (`created`, `name`,
`createdAt`, `fileName`, `date` → `40`); omit it for a different default order;
sort by date client-side. `limit` capped at 50. Response
`{commonFiles, totalAmount}`, paged with `index`; each entry nests `file.file` —
outer is the attachment record (name, uploader, virus-scan `status`), inner the
blob with the presigned URL, absent unless `status` is `available`.

**Presence `status`** (`getDailyOverview`): `0` Ikke kommet, `1` Syg, `2`
Ferie/fri, `3` Kommet/til stede, `4` På tur, `5` Sover, `8` Gået.

## Sensitive threads

Threads with `sensitive: true` — usually the ones about one child — need the
session stepped up (`isSteppedUp` in `getProfileContext`). What a
non-stepped-up session sees is **unconfirmed**: Aula has only
`session.keepAlive` and `session.stepUpCurrentSession`, no step-down, and
step-up survives both a token refresh and the broker session expiring, so it can
only lapse on Aula's timer. Aula's frontend reads a per-thread `requiresStepUp`
flag (absent from a stepped-up session's payload) and then masks the title and
withholds the preview — so expect masking rather than omission, and treat
`requiresStepUp` appearing as the signal. `refresh-stepup` restores step-up
without MitID only while the broker SSO session is alive (about a day); after
that only `login` does.

## Attachments

CloudFront presigned URLs, valid about an hour; the signature is the
authorisation, so fetch with no cookie and no `Authorization` header. One
mangled character is a `403 MalformedSignature` that reads like an auth failure
— do not round-trip them through a model; `attachment` downloads server-side
and returns a path.

## MitID login

- MitID picks the channel-binding mode per account: OTP to compare, or TQR (a
  QR pair that refresh together). Both callbacks must be wired or the other mode
  polls forever.
- No session-teardown endpoint. An abandoned login stays live on MitID's side
  and the next attempt trips the parallel-session detector (CAP008); wait it out
  — reject the pending prompt in the app, close aula.dk tabs, 60 s+.
- The login jar holds cookies for `login.aula.dk`, `broker.unilogin.dk`,
  `nemlog-in.mitid.dk` — nothing for `www.aula.dk`; the API session comes from
  the bootstrap above.
- MitID sends `null`, not absence, for optional fields
  (`"nextAuthenticator": null` on an error `/next`). `isOptional` in
  `src/validation.ts` accepts both; assume nullable at every wire boundary.

## Vendor widgets

- **Token expiry is inconsistent:** `401`, or HTTP 200 with
  `{"message":"JWT-Token expired, please renew."}`, or (SkolePortal) a `302` to
  its login page. All three count as expiry and the call is retried once with a
  fresh token.
- **`sessionId` means two things.** MinUddannelse and EasyIQ want the Aula
  guardian `userId`; Meebook (`sessionuuid` header), Systematic (`sessionId`
  query) and SkolePortal's Ugeplan widget (`x-login` header) want the MitID
  username. If it is missing from the token record those vendors fall back to
  the guardian id and say so in `warnings`.
- **Meebook** keys `childFilter[]` on `Child.userId` and needs a one-time
  interactive SSO — open the Meebook widget in aula.dk once; until then it
  answers HTTP 200 with that instruction per child, surfaced verbatim.
- **SkolePortal** wants `origin`/`referer` pointing at SkolePortal (and matching
  the widget, `/UgeplanWidget` vs `/LektierWidget`) and a desktop-browser
  user-agent, else `302`. `date=YYYY-MM-DD` silently returns nothing; it wants
  `YYYY-MM-DDT00:00:00.000Z`.
