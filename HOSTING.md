# The hosted copy

The brief as a web page the family opens on their phones: behind a login of
its own, always today's, with ticks both parents share. It is a Cloudflare
Worker in `src/hosting/`, deployed once by hand from a checkout, and the CLI
uploads to it on every run. Everything below is free on Cloudflare's free
plan.

This is for whoever sets it up — it needs a terminal, a Cloudflare account
and a domain on it. The family never sees any of it.

## What it is

```
aula new ──PUT /api/brief (bearer token)──▶ Worker ──▶ Durable Object (SQLite)
                                              │          page · sessions · ticks
phone ──GET / ── session? ── no ──▶ login page ── code by mail ──▶ session (1 year)
                         └─ yes ─▶ the brief ── ticks ⇄ /api/done
```

- **`worker.ts`** — the routes and the store. One SQLite-backed Durable
  Object, declared by class name, so there is no database id to configure.
- **`auth.ts`** — codes, sessions, tokens. Pure functions; the tests run them.
- **`pages.ts`** — the login page and the code mail, in Danish.
- **`protocol.ts`** — the paths and limits the CLI, the page and the Worker
  share.

It used to sit behind Cloudflare Access. Access could not be made to look like
anything but Access, and it ends every session after a month; this signs a
family member in about once a year, on a page that is theirs.

## Setting it up

From a checkout, with `wrangler` installed and logged in (`wrangler login`),
and a domain on the Cloudflare account. `<domain>` is that domain, `<host>`
the address the page will live at — a subdomain of it.

**1. Mail.** Codes are sent through Cloudflare Email, which the free plan
allows only to addresses verified on the account. That is exactly the list of
people who may sign in, so it costs nothing:

```bash
wrangler email routing enable <domain>
wrangler email routing addresses create <address>   # once per person
```

Each person gets a verification mail from Cloudflare and clicks it once. The
first command adds MX records: on a domain that already receives mail
elsewhere, use a subdomain for the sender instead.

**2. Deploy**, with the address as a flag, so the hostname stays out of the
tracked config. Always pass `--domain` on a redeploy too:

```bash
wrangler deploy --config src/hosting/wrangler.jsonc --domain <host>
```

Until step 3 the Worker lets nobody in and takes no upload: a missing secret
refuses rather than guesses.

**3. Secrets.** Three, and none of them belong in this repository. `printf`,
not `echo`: a trailing newline would become part of the sender's address.

```bash
openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_' > ~/.aula/upload-token
wrangler secret put UPLOAD_TOKEN --config src/hosting/wrangler.jsonc < ~/.aula/upload-token
printf %s 'one@example.com,other@example.com' | wrangler secret put ALLOWED_EMAILS --config src/hosting/wrangler.jsonc
printf %s 'login@<domain>' | wrangler secret put MAIL_FROM --config src/hosting/wrangler.jsonc
```

`ALLOWED_EMAILS` is who may sign in, separated by commas. Taking an address
off it signs that person out everywhere at their next request.

**4. Point the CLI at it.** This uploads the newest brief and saves the address
and token in `~/.aula/config.json` (`0600`):

```bash
AULA_HOSTING_TOKEN="$(cat ~/.aula/upload-token)" aula publish https://<host>
rm ~/.aula/upload-token
```

From then on every `aula new`, and every scheduled run, uploads too.
`aula publish` alone uploads again; `aula publish --off` stops.

## Trying it locally

`wrangler dev` runs the real Worker in workerd. Put fixture secrets in
`src/hosting/.dev.vars` (gitignored):

```
ALLOWED_EMAILS=valdemar@eksempel.dk
MAIL_FROM=login@eksempel.dk
UPLOAD_TOKEN=dev-upload-token
```

```bash
cd src/hosting && wrangler dev
bun scripts/fixture-brief.ts | curl -X PUT --data-binary @- \
  -H 'authorization: Bearer dev-upload-token' http://127.0.0.1:8787/api/brief
```

A sent code is not mailed; `wrangler dev` prints the message, subject first,
and the code leads the subject. Do this before deploying anything that touches
a route or a header: the two bugs the unit tests could not see — a referrer
policy that turned every form's `Origin` into `null`, and an unread body that
reset the Durable Object — both showed up on the first click in a browser.

## When it misbehaves

- **"Koden kunne ikke sendes"** — the Email Service refused. Usually the
  address is not verified yet (`wrangler email routing addresses list`), or
  `MAIL_FROM` is not on a domain with Email Routing. `wrangler tail` shows the
  error code; it never logs the address or the code.
- **A run's notes say the upload token was refused** — `UPLOAD_TOKEN` and
  `~/.aula/config.json` disagree. Set a new one on both sides (steps 3 and 4).
  The run still counts as complete: no retry fixes a token.
- **Signed out unexpectedly** — a session lasts a year from its last renewal
  and is renewed at most daily on any visit, so this is almost always a
  browser that dropped the cookie: a private tab, or a page added to an
  iPhone's home screen, which keeps cookies of its own.
