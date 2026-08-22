# Aula API — what will bite you

Field notes for working on this project. Everything here was established against
the live API and cost time to find; none of it is documented by Aula, and most
of it fails in ways that look like a different problem than it is.

Ordinary usage is in [SETUP.md](SETUP.md) and `aula --help`. This file is only
the traps.

## You may not write. Ever.

Read-only is a hard requirement from the repo owner, not a default. `client.ts`
enforces it in the transport (`assertReadOnly`) and `widgets.ts` does the same
for vendor APIs, both before a socket is opened. Do not add a method to the
allowlist to "just try" something, and do not route a call around `#request`.
`presence.updatePresenceTemplate` is deliberately absent — it is the one API in
the prior art that writes.

## Code is English. Danish is what the reader sees.

The product is Danish; the codebase is not. Danish belongs in exactly one place —
strings a parent reads — and nowhere else.

**Danish is allowed in:** rendered page text and CLI output, prompt prose, and
the `problems`/`notes` diagnostics that reach the page.

**Danish is banned from:** identifiers, type names, object keys, JSON keys
exchanged with the model, `data-*` attributes, CSS class names, enum/sentinel
values, and the explanatory prose of comments, doc-comments and test names.

### Whose word is it?

Three rules, and they decide every case:

1. **The external contract is Danish → we are Danish.** MinUddannelse really
   does send `kuvertnavn` and `ugebreve`. Mirror those verbatim in the response
   type and map to English at the boundary — `min-uddannelse.ts` is the pattern.
   The giveaway that a payload is genuinely theirs is a language mix nobody
   would design: `MuTask` has `kuvertnavn` next to `title`, and `hold` whose
   nested field is `name`.
2. **The external contract is English → we stay English.** Never translate a
   wire term into the Danish word for it.
3. **The vocabulary is ours → always English.** Identifiers, type names, object
   keys, JSON keys exchanged with the model, `data-*` attributes, CSS classes,
   enum and sentinel values, and the prose of comments, doc-comments and test
   names.

**Rule 2 is the one that gets broken, because Aula's API is entirely English
while Aula's UI is entirely Danish.** The wire says `activityType`, `pickup`,
`selfDecider`, `commonFiles`, `institutionProfileId`; the screen the parent
looks at says "Henteform", "Komme/gå", "Fælles Filer". Naming code after the
screen is how a field ends up called `henteform` when the thing it is built
from is `activityType`. Aula being a Danish product is not evidence that any
particular term of theirs is Danish — go and look at the response.

So: name the concept by the English wire term, and cross-reference the Danish
UI label where it helps someone find the feature — `"Fælles Filer" in Aula's own
UI`, not `Flattens a Fælles Filer entry`.

**Guessing the language of a field is how you lose data silently.** `MuTask.hold`
was typed as `{ name }` when MinUddannelse sends `{ navn }`, so `subject` never
populated — and the test passed, because the fixture had been written to match
our code instead of the wire. A self-authored fixture proves only that the code
agrees with itself. Two things would have caught it: the fixture contradicted
itself (`hold: [{ name }]` beside `forloeb: { navn }`), and MinUddannelse
publishes its schema:

```
https://api.minuddannelse.net/csv/metadata?op=OpgavelisteRequest
```

That endpoint is public and needs no token — it lists `HoldDto` as `Id`, `Navn`,
`FagId`, `FagNavn`. Check it before typing a MinUddannelse payload. (Only some
`op=` values are public; `UgebrevRequest` answers 403.)

Note also that a widget the family does not have is not testable from a normal
account: Aula will happily mint a token for any `widgetId`, but the vendor then
answers `403 Token is invalid (Person not found: …)`. `scaarup/aula` and
`Casperjuel/aula-mcp` are the fallback sources when you cannot make the call.

One further exception, on top of the three rules: **Danish specimens quoted in
comments.** `rules.ts` matches literal Danish, so a comment showing `"på mandag"`
or `"ansøgningsfristen"` is a specimen of the input, not a name. Translating
those would make the comment describe code that does not exist.

The mistake that catches most of the rest: never name one of our own concepts by
the Danish label it renders as. The tiers are `act`, `week`, `context`, `hidden`
— a comment saying "at most five items in *Kræver handling*" names the heading
where it means the `act` tier. Pair the two only where the point is the
rendering itself, as `BRIEF.md`'s page-section list does.

Where a Danish label and an English code value both have to exist, keep them
side by side rather than picking one: `cli-helpers.ts` maps Aula's presence
constants through `{ da: 'På tur', en: 'on a field trip' }`, keyed by the wire
number.

## The failure modes that lie to you

### An access token alone is not enough (the expensive one)

`?access_token=…` authenticates **only** `profiles.getProfilesByLogin` and
`profiles.getProfileContext`. Everything else returns **HTTP 403 + status code
10** until a session is bootstrapped:

1. `getProfilesByLogin` → Aula sets `PHPSESSID` + `Csrfp-Token`
2. `getProfileContext?portalrole=guardian` → **activates a profile** in that session
3. module endpoints now work

The module endpoints are gated on the *session*, not the token. A client using
bare `fetch` discards `Set-Cookie`, so `whoami` succeeds (it only touches the
two profile endpoints) while messages, posts, presence and groups all 403 — a
signature that reads as "bad token" and is not. `AulaClient.#ensureSession`
handles this; keep the cookie jar alive across requests.

Aula rejects `Authorization: Bearer` outright. The token goes in the query
string.

### A rejected access token is an HTTP 500 with a *success* envelope

Send a token Aula will not accept — expired, malformed, from another login —
and you get:

```
HTTP 500
{"status":{"code":0,"message":"intern fejl"},"data":"intern fejl"}
```

Code `0` is *success*. So the envelope check passes, `"intern fejl"` is handed
on as the payload, and the failure finally surfaces wherever that string first
fails to be an object — a shape complaint several layers from a dead login.
Sending **no** token returns a clean HTTP 403 + code `448` instead, so this is
specifically how Aula reports a token it dislikes.

The same 500 is what Aula returns when it is genuinely broken, and the body
does not distinguish them — but an experiment does: while Aula is healthy a
*credential-free* request is answered cleanly, and while it is not, that
request 5xxes too. `AulaClient.#serverError` makes exactly that one extra
request so the error can say which of the two happened, because the reactions
are opposite: one is a MitID login with the phone, the other is waiting.

Never trust the envelope on a 5xx.

### Status code 10 means two unrelated things

Told apart only by the HTTP status:

| | |
| --- | --- |
| HTTP **410** + code 10 | Retired API version. *Every* method returns this. |
| HTTP **403** + code 10 | Session has no activated profile (see above). |

Because a retired version fails uniformly, hardcoding a version turns into a
total outage. The client probes. Current live version: **v24**.

### HTTP 403 is three different problems

Only the envelope code separates them: code `448` = credentials expired; code
`403` = permitted-but-refused (wrong ids, or an over-long calendar window); code
`10` = unactivated session. Trusting the HTTP status alone makes every id
mistake look like a login problem.

### Wrong ids on posts return success, not an error

`posts.getAllPosts` with an incomplete `institutionProfileIds[]` returns
`{posts: [], status: {code: 0}}`. An empty feed and a healthy feed are
indistinguishable without knowing this. It cost an hour of believing the family
simply had no posts.

### Sensitive threads return empty, not an error

Threads with `sensitive: true` need the session *stepped up*. Without it they
come back empty and everything reports success — silent under-reporting of
exactly the threads that matter most (meetings about one child). Check
`isSteppedUp` from `getProfileContext` before trusting a quiet result;
`refresh-stepup` restores it without a full MitID login.

Step-up lapses well before the login itself expires.

## Id spaces

Three of them, and picking the wrong one is the usual cause of a 403:

- **`profileId`** — the person, stable across institutions.
- **`id`** — that person at one institution ("institution profile"). What almost
  every Aula endpoint wants.
- **`userId`** — opaque per-child token (`alma0101`). No Aula endpoint wants it;
  every third-party widget does.

Which ids each endpoint accepts is **not** consistent:

| Endpoint | Accepts |
| --- | --- |
| `posts.getAllPosts` | guardian ids **and** children ids (omit children → silent empty list) |
| `calendar.getEvents…` | children ids **only** — adding guardian ids gives 403 |
| `presence.getDailyOverview` | children ids only, as `childIds[]` |
| `presence.getPresenceTemplates` | children ids only, as `filterInstitutionProfileIds[]` |
| `groups.getGroupsByContext` | children ids, as `childInstitutionProfileIds[]` |

`family.ts` resolves these once into `postInstitutionProfileIds`,
`childInstitutionProfileIds` and `institutionCodes`. Use those rather than
re-deriving at a call site — that is the whole reason it exists.

A fourth identity: the **MitID username** (`valdemarex`) is not the Aula guardian id
(`vald42a1`). Meebook, Systematic and EasyIQ SkolePortal's Ugeplan widget key their
session on the MitID one and reject the Aula one. It appears nowhere in the API —
it is what the human types into MitID — so `login` records it on the stored token
record, which is the one place it exists.

## Fælles Filer (`commonFiles.getCommonFiles`)

The shared-file shelf — timetables, holiday plans, policies — is a module of its
own, not attachments and not documents. Neither prior-art project implements it;
the method name came out of Aula's own frontend bundle.

Two things make it awkward:

- **`orderField` is mandatory, and `title` is the only value that works.**
  `created`, `name`, `createdAt` and `fileName` are all rejected. So is omitting
  it, or omitting `orderDirection`. Every one of those fails identically:
  status `40`, empty `errorInformation`, no indication of which parameter was
  wrong. Sorting by date has to be done client-side.
- **It filters on institution `institutionCodes[]`** — a *fourth* addressing
  scheme, alongside the three id spaces above. None of the profile ids work here.

`limit` is capped: 50 is fine, 100 returns status 40. Response is
`{commonFiles, totalAmount}`; paginate with `index`.

Each entry nests as `file.file`, which is Aula's own shape and not a typo: the
outer object is the attachment record (name, uploader, virus-scan `status`), the
inner one is the stored blob carrying the presigned URL. Read the URL off the
inner level. Entries whose `status` is not `available` have no URL yet.

## Calendar

Three separate traps in one endpoint:

- Dates are **not ISO-8601**. Aula wants `YYYY-MM-DD HH:mm:ss.SSSS+ZZZZ`
  (`2026-08-12 00:00:00.0000+0200`); an ISO string is rejected. See
  `formatAulaDate`.
- The window is **capped at 50 days**. 50 passes, 51 returns a bare 403 — the
  same status as a wrong id set, with nothing distinguishing them. The client
  refuses over-long windows locally so the message says what is actually wrong.
- It is a **POST that reads**, because the filter does not fit in a query
  string, and it needs `Csrfp-Token` from the cookie jar. It is the only POST on
  the allowlist.

## Smaller ones

- Array parameters are PHP-style repeated keys: `childIds[]=1&childIds[]=2`.
- `profiles.getContactlist` pages from **1**; everything else pages from 0.
- Thread *lists* truncate the message body mid-sentence. `latestMessage.text.html`
  is a preview, not content — fetch `getMessagesForThread` before quoting or
  summarising.
- Message HTML is pretty-printed, so `</div>\n<div>` is insignificant
  whitespace, while a deliberate blank line is written `<div> </div>` or
  `<br><br>`. Treating the newlines as real produces double-spaced output.

## MitID login

- MitID picks the channel-binding mode **per account**: OTP to compare, or
  **TQR** (scan a QR). Handling only one leaves the other silently polling,
  looking exactly like a hang. Both callbacks must be wired. The QR is split
  across two codes that refresh together.
- There is **no session-teardown endpoint**. An abandoned login leaves a live
  session on MitID's side, and the next attempt trips the parallel-session
  detector (CAP008). Killing the CLI mid-login only stops local polling — it
  tells MitID nothing. This can only be waited out: reject the pending prompt in
  the app, close aula.dk tabs, wait 60s+.
- The login jar holds cookies for `login.aula.dk`, `broker.unilogin.dk` and
  `nemlog-in.mitid.dk` — **nothing for `www.aula.dk`**. Do not expect it to
  contain an API session; that comes from the bootstrap above.
- MitID sends **`null`**, not absence, for optional fields it has nothing to put
  in. A `/next` that reports an error carries `"nextAuthenticator": null` and
  `"nextSessionId": null`. A guard that treats "optional" as *only* `undefined`
  rejects the whole response — and since the payload underneath is usually the
  CAP008 message this CLI already explains well, the cost is a clear error
  turning into an unactionable one. `isOptional` in `src/validation.ts` accepts
  both, and the response interfaces say `| null` where the wire does. Assume
  nullable at any JSON boundary: **JSON has no `undefined`**, so a parsed
  payload can only produce it from a key that is not there at all.

## Finding an endpoint that is not wrapped yet

Aula's frontend calls **304 distinct methods**; this client wraps about a dozen,
and the prior-art projects cover fewer. When something is missing, do not guess
method names — read them out of Aula's own bundle:

```bash
curl -s https://www.aula.dk/portal/ -H "Cookie: <a logged-in aula.dk browser cookie>" -o portal.html
grep -oE 'src="/static/js/[^"]*"' portal.html | sed 's/src="//;s/"//' \
  | while read -r p; do curl -s "https://www.aula.dk$p" -O; done
grep -ohoE '\?method=[a-zA-Z]+\.[a-zA-Z]+' ./*.js | sed 's/?method=//' | sort -u
```

Then find the call site to learn the parameters — the store action shows the
request, but the *component* is what builds the params object:

```bash
grep -n "ACTION_GET_COMMON_FILES_LIST,append" ./*.js   # the mapActions alias
```

Modules worth knowing exist, by method count: `calendar` 40, `presence` 36,
`messaging` 30, `profiles` 16, `documents` 15, `posts` 13, `gallery` 13,
`groups` 10, `comments` 8, `search` 5, `notifications` 5, `commonFiles` 2,
`resources` 2. `comments` (on posts) is the obvious remaining unwrapped read;
`gallery.getAlbums` is now wrapped as `galleries`, but the other twelve
`gallery` methods are writes.

Probing blind is slow — `40` is returned for any wrong parameter set with no
detail — but `raw <method> k=v` will call any method matching the read pattern,
which is enough to confirm a guess once you have the parameter names.

## The response cache

Reads are cached to `~/.aula/cache/responses` for 600s, so a second `digest`
inside the window makes **no requests at all**. Two consequences worth knowing
before you debug something that "should have refetched":

- **`--no-cache` is the first thing to reach for.** A wrong-looking answer may
  simply be ten minutes old. `cache status` shows what is stored.
- **Two things are never cached**, and both are correctness rather than taste.
  `aulaToken.getAulaToken`, because the expiry retry in `WidgetTokens` depends
  on getting a genuinely new token — weekly plans are cached one level up
  instead, at the plan, so a hit skips the token *and* the vendor call. And
  anything that failed, so a transient 403 is not pinned for the TTL.

The session bootstrap is unaffected: `#ensureApiVersion` and `#ensureSession`
call `#send` directly rather than the cached path, so a fully-cached run skips
the handshake and the first genuine miss still performs it. Do not "simplify"
those onto `#request`.

`login`, `logout` and `refresh-stepup` each drop the cache. The step-up one is
the load-bearing case: threads cached by a non-stepped-up session are missing
the sensitive ones and look exactly like success.

## Verifying a change

`bun test src/` stubs `fetch` and needs no credentials. `cli.test.ts` and
`auth.test.ts` go further and run the CLI as a process against a stubbed Aula
injected with `bun --preload`, which is the only level at which a flag that is
parsed and then dropped — `digest --child`, once — is visible at all.

Those process-level tests need a login on disk, so they spawn
`src/testing/seed-tokens.ts` with `$AULA_DIR` pointed at a temp directory. Run
that script **without** `$AULA_DIR` and it would overwrite the real
`~/.aula/tokens.json` — including the refresh token, which no amount of
retrying gets back. It refuses to run outside a sandbox for that reason; if you
need a fixture login by hand:

```bash
AULA_DIR=$(mktemp -d) bun src/testing/seed-tokens.ts
```

But no stubbed suite can tell you whether the API still behaves, because nearly
every trap above returns a *successful-looking* response. That is what `doctor`
is for:

```bash
bun src/cli.ts doctor --text
```

It walks every endpoint, reports counts and timing, and marks a call that
succeeded but returned a known symptom as `WARN` rather than `PASS` — an empty
posts feed, a session that is not stepped up, a child with no `userId`. Read the
warnings; they are the failures this file exists to describe. It never uses the
cache.
