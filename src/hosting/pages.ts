/**
 * The pages the Worker renders itself: the login, and the one sentence shown
 * before any brief has been uploaded. Everything on them is Danish — they are
 * read by the family, not by us.
 *
 * The design takes the brief's own palette — warm paper, near-black ink, the
 * burnt orange it marks urgent things with — and gives it a sky: the brief
 * arrives at six in the morning and six in the evening, so the page opens on
 * a sunrise. No script, no web font and no image request: a login page that
 * waits for a font to load is a login page that flashes.
 */

import { CODE_MINUTES } from './auth.ts';

export type LoginState =
  | { step: 'email'; email?: string; error?: string }
  | { step: 'code'; email: string; error?: string };

const BRAND = 'Aula AI oversigt';

/** Stricter than the brief's: these pages run no script at all. */
export const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A sun half over the horizon, in the accent's two oranges. */
const SUN = `<svg class="sun" viewBox="0 0 64 40" aria-hidden="true">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f59e5b"/><stop offset="1" stop-color="#c2410c"/></linearGradient></defs>
  <path d="M8 30a24 24 0 0 1 48 0z" fill="url(#g)"/>
  <path d="M2 34h60M14 38.5h36" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2b1d3a"/><path d="M12 44a20 20 0 0 1 40 0z" fill="#f59e5b"/><path d="M8 48h48" stroke="#fbf7f1" stroke-width="4" stroke-linecap="round"/></svg>',
)}`;

const CSS = `
:root{
  --sky-top:#2b1d3a;--sky-mid:#8a3b52;--sky-low:#ee7a52;--glow:#ffe0a8;--glow-2:rgba(255,168,108,.55);
  --card:#fbf7f1;--ink:#231a14;--muted:#6f6358;--line:#e6ddd1;--field:#fff;
  --accent:#c2410c;--button:#b93d0c;--button-2:#d4541d;--error:#b42318;--error-bg:#fdecea;
  --shadow:0 30px 60px -20px rgba(43,29,58,.55),0 8px 20px -8px rgba(43,29,58,.35);
}
@media (prefers-color-scheme:dark){:root{
  --sky-top:#120d1c;--sky-mid:#4a2140;--sky-low:#a84a34;--glow:#f0a266;--glow-2:rgba(214,110,70,.45);
  --card:#1d1822;--ink:#f3ece4;--muted:#b3a79c;--line:#3a3140;--field:#27212d;
  --accent:#f08a4b;--error:#ff9b8f;--error-bg:#3a1d1f;
  --shadow:0 30px 60px -20px rgba(0,0,0,.7),0 8px 20px -8px rgba(0,0,0,.5);
}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{
  font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:var(--ink);background:var(--sky-top);-webkit-font-smoothing:antialiased;
}
.stage{
  position:relative;min-height:100vh;min-height:100dvh;display:grid;place-items:center;
  padding:max(24px,env(safe-area-inset-top)) 16px max(32px,env(safe-area-inset-bottom));
  overflow:hidden;isolation:isolate;
  background:linear-gradient(180deg,var(--sky-top) 0%,var(--sky-mid) 55%,var(--sky-low) 100%);
}
.stage::before{
  content:"";position:absolute;z-index:-1;left:50%;bottom:-46vmax;width:100vmax;height:100vmax;
  transform:translateX(-50%);border-radius:50%;
  background:radial-gradient(circle,var(--glow) 0%,var(--glow-2) 30%,transparent 60%);
}
.card{
  width:100%;max-width:420px;background:var(--card);border-radius:28px;
  padding:36px 28px 28px;box-shadow:var(--shadow);
}
@media (min-width:480px){.card{padding:44px 40px 36px}}
.sun{width:64px;height:40px;color:var(--ink);display:block;margin-bottom:22px}
.eyebrow{
  margin:0 0 6px;font-size:13px;font-weight:650;letter-spacing:.14em;text-transform:uppercase;
  color:var(--accent);
}
h1{
  margin:0 0 10px;font:600 42px/1.05 "Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  letter-spacing:-.01em;
}
.lede{margin:0 0 26px;color:var(--muted)}
.lede b{color:var(--ink);font-weight:600;word-break:break-all}
label{display:block;font-size:14px;font-weight:600;margin:0 0 8px}
input{
  width:100%;font:inherit;font-size:18px;color:var(--ink);background:var(--field);
  border:1.5px solid var(--line);border-radius:14px;padding:14px 16px;outline:none;
  transition:border-color .15s,box-shadow .15s;
}
input:focus{border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent)}
input.code{font-size:28px;letter-spacing:.35em;text-align:center;font-variant-numeric:tabular-nums;padding:12px}
button{
  width:100%;margin-top:18px;font:inherit;font-weight:650;font-size:17px;color:#fff;
  background:linear-gradient(135deg,var(--button),var(--button-2));border:0;border-radius:14px;
  padding:15px 18px;cursor:pointer;box-shadow:0 10px 22px -10px var(--button);
  transition:transform .12s,box-shadow .12s,filter .12s;
}
button:hover{filter:brightness(1.05)}
button:active{transform:translateY(1px);box-shadow:0 6px 14px -8px var(--button)}
button:focus-visible{outline:3px solid var(--glow);outline-offset:3px}
.error{
  margin:0 0 18px;padding:12px 14px;border-radius:12px;font-size:15px;
  color:var(--error);background:var(--error-bg);
}
.links{display:flex;justify-content:space-between;gap:12px;margin-top:18px;font-size:14px}
.links a,.links button{
  width:auto;margin:0;padding:0;background:none;box-shadow:none;border:0;border-radius:0;
  color:var(--muted);font:inherit;font-size:14px;font-weight:500;text-decoration:underline;
  text-underline-offset:3px;cursor:pointer;
}
.links a:hover,.links button:hover{color:var(--ink);filter:none}
.links form{margin:0}
.foot{margin:22px 0 0;text-align:center;font-size:13px;color:var(--muted)}
`;

function document(title: string, body: string): string {
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#2b1d3a">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<main class="stage">
<section class="card">
${SUN}
<p class="eyebrow">${BRAND}</p>
${body}
<p class="foot">Kun for familien</p>
</section>
</main>
</body>
</html>
`;
}

function error(message: string | undefined): string {
  return message ? `<p class="error" role="alert">${escape(message)}</p>` : '';
}

export function loginPage(state: LoginState): string {
  if (state.step === 'email') {
    return document(
      'Log ind',
      `<h1>Log ind</h1>
<p class="lede">Skriv din e-mail, så sender vi dig en kode.</p>
${error(state.error)}
<form method="post" action="/login">
<label for="email">E-mail</label>
<input id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required autofocus value="${escape(state.email ?? '')}">
<button type="submit">Send kode</button>
</form>`,
    );
  }
  const email = escape(state.email);
  return document(
    'Log ind',
    `<h1>Log ind</h1>
<p class="lede">Hvis <b>${email}</b> har adgang, har vi sendt en kode dertil. Den virker i ${CODE_MINUTES} minutter.</p>
${error(state.error)}
<form method="post" action="/login/code">
<input type="hidden" name="email" value="${email}">
<label for="code">Kode</label>
<input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required autofocus>
<button type="submit">Log ind</button>
</form>
<div class="links">
<a href="/">Brug en anden e-mail</a>
<form method="post" action="/login"><input type="hidden" name="email" value="${email}"><button type="submit">Send en ny kode</button></form>
</div>`,
  );
}

/** Signed in, and nothing to show yet: the first upload has not happened. */
export function emptyPage(): string {
  return document(
    BRAND,
    `<h1>Snart</h1>
<p class="lede">Der er ikke lagt noget overblik op endnu. Det kommer med den næste kørsel.</p>`,
  );
}

/** The login code, as mail. The code leads the subject, so a lock screen shows it. */
export function codeMail(code: string): { subject: string; text: string; html: string } {
  const text =
    `Din kode er ${code}.\n\n` +
    `Den virker i ${CODE_MINUTES} minutter. Har du ikke bedt om den, kan du se bort fra denne mail.\n`;
  const html = `<!doctype html><html lang="da"><body style="margin:0;background:#fbf7f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#231a14">
<div style="max-width:440px;margin:0 auto;padding:36px 24px">
<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#c2410c">${BRAND}</p>
<p style="margin:0 0 20px;font-size:17px">Din kode til at logge ind:</p>
<p style="margin:0 0 20px;font-size:36px;font-weight:700;letter-spacing:.3em;font-variant-numeric:tabular-nums">${code}</p>
<p style="margin:0;font-size:14px;color:#6f6358">Den virker i ${CODE_MINUTES} minutter. Har du ikke bedt om den, kan du se bort fra denne mail.</p>
</div></body></html>`;
  return { subject: `${code} er din kode til ${BRAND}`, text, html };
}
