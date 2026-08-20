# The Aula API

Reverse-engineered reference for anyone working on this client. Undocumented and
internal: everything here was derived from live responses, from Aula's own
frontend bundle, and from the two prior-art projects. Treat it as observed
behaviour, not contract.

> Read [AGENTS.md](AGENTS.md) alongside this. It collects the failure modes that
> return a *successful-looking* response — empty lists, silent truncation, one
> status code meaning two things.

Base URL is `https://www.aula.dk/api/v{N}/`, currently **v24**. Every response
is wrapped:

```json
{ "status": { "code": 0, "message": "OK" }, "data": … }
```

## The token is not enough on its own

The OAuth access token goes in as `?access_token=…` — Aula rejects
`Authorization: Bearer` outright — but the token by itself only unlocks
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
| `10` | 410 | Retired API version, or unknown method |
| `10` | 403 | Session has not activated a profile — see above |
| `40` | 200 | Bad or missing parameters |
| `403` | 403 | Not allowed to read this: a wrong id set, or a calendar window over 50 days |
| `448` | 403 | Not authenticated — credentials expired |

Retired versions answer *every* call with `10`, so the client probes for a live
version rather than dying on a hardcoded constant. The probe warns when the
default is stale; `AULA_API_VERSION=<N>` pins the version and skips it (the
warning also surfaces once in the test run, from the stubbed Aula — that is the
probe working, not a failure).

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
| `posts.getAllPosts` | guardian ids **and** children ids — omitting the children returns an empty list with status `0`, not an error |
| `gallery.getAlbums` | children ids, as `filterInstProfileIds[]` — omitting the filter returns albums from institutions the family has *left* |
| `calendar.getEvents…` | children ids **only** — including guardian ids returns `403` |
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

Calendar `start`/`end` are **not** ISO-8601. Aula wants
`YYYY-MM-DD HH:mm:ss.SSSS+ZZZZ` (e.g. `2026-08-12 00:00:00.0000+0200`); an ISO
string is rejected. See `formatAulaDate`.

`gallery.getAlbums` sorts on `mediaCreatedAt` — the only `sortOn` value that
works — and then does not return it, so the wire order contradicts the one date
in the payload (`creationDate`). Anything date-sensitive has to sort on
`creationDate` itself, and cannot stop paging at the first row outside a window.
Also: the first row is a synthetic tagged-media bucket with `id: null`, not an
album, and `thumbnailsUrls` is capped at one entry, so it is not a photo count.

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

Threads flagged `sensitive: true` are readable only when the session is stepped
up (`isSteppedUp` in `profiles.getProfileContext`). These tend to be the ones
about an individual child, so a non-stepped-up session silently returns a less
complete picture — `whoami` surfaces the flag for that reason.

## Attachments

Aula hands out CloudFront presigned URLs valid for about an hour, where the
signature *is* the authorisation. They must be fetched with no cookie and no
`Authorization` header, and they should not make a round trip through a model —
they are long opaque blobs, and one mangled character produces a
`MalformedSignature` 403 that reads like an auth failure. `attachment` downloads
server-side and returns a path for that reason.


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

