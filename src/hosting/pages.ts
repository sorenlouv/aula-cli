/**
 * The pages the Worker renders itself: the login, and the one sentence shown
 * before any brief has been uploaded. Everything on them is Danish — they are
 * read by the family, not by us.
 *
 * The design is the family's own logo: its blue is the page, its white
 * wordmark sits on it above a white card, and the heading takes a rounded face
 * to match the letterforms. The logo and the icons are static assets in
 * `public/`, served by Cloudflare before the Worker runs. No script and no web
 * font: a login page that waits for a font to load is a login page that
 * flashes.
 */

import { CODE_MINUTES } from './auth.ts';

export type LoginState =
  | { step: 'email'; email?: string; error?: string }
  | { step: 'code'; email: string; error?: string };

const BRAND = 'Aula AI oversigt';

/** The logo's blue, sampled from it. */
export const THEME_COLOR = '#305791';
const THEME_COLOR_DARK = '#16243d';

/** Stricter than the brief's: these pages run no script at all. */
export const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self'",
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

const CSS = `
:root{
  --blue:${THEME_COLOR};--glow:rgba(120,165,230,.45);
  --page:${THEME_COLOR};--card:#fff;--ink:#16223a;--muted:#5d6b82;--line:#d9e1ee;--field:#fff;
  --button:${THEME_COLOR};--button-hover:#244574;--error:#b42318;--error-bg:#fdecea;
  --shadow:0 30px 60px -24px rgba(10,26,56,.55),0 10px 24px -12px rgba(10,26,56,.35);
}
@media (prefers-color-scheme:dark){:root{
  --page:${THEME_COLOR_DARK};--glow:rgba(48,87,145,.55);
  --card:#1a2436;--ink:#eef2f8;--muted:#a3b0c4;--line:#2d3a52;--field:#141d2c;
  --button:#3a66a8;--button-hover:#4674b8;--blue:#8fb0e3;--error:#ff9b8f;--error-bg:#3a1d1f;
  --shadow:0 30px 60px -24px rgba(0,0,0,.7),0 10px 24px -12px rgba(0,0,0,.5);
}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{
  font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:var(--ink);background:var(--page);-webkit-font-smoothing:antialiased;
}
.stage{
  position:relative;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:28px;overflow:hidden;isolation:isolate;
  padding:max(28px,env(safe-area-inset-top)) 16px max(36px,env(safe-area-inset-bottom));
  background:var(--page);
}
.stage::before,.stage::after{
  content:"";position:absolute;z-index:-1;border-radius:50%;pointer-events:none;
}
.stage::before{
  width:120vmax;height:120vmax;left:50%;top:-78vmax;transform:translateX(-50%);
  background:radial-gradient(circle,var(--glow) 0%,transparent 58%);
}
.stage::after{
  width:70vmax;height:70vmax;right:-32vmax;bottom:-36vmax;
  background:radial-gradient(circle,rgba(10,26,56,.35) 0%,transparent 62%);
}
.logo{display:block;width:min(64vw,248px);height:auto}
.card{
  width:100%;max-width:420px;background:var(--card);border-radius:28px;
  padding:34px 28px 30px;box-shadow:var(--shadow);
}
@media (min-width:480px){.card{padding:42px 40px 38px}}
.eyebrow{
  margin:0 0 8px;font-size:13px;font-weight:650;letter-spacing:.14em;text-transform:uppercase;
  color:var(--blue);
}
h1{
  margin:0 0 10px;font:700 40px/1.05 ui-rounded,"SF Pro Rounded","Nunito","Varela Round",system-ui,sans-serif;
  letter-spacing:-.02em;
}
.lede{margin:0 0 26px;color:var(--muted)}
.lede b{color:var(--ink);font-weight:600;word-break:break-all}
label{display:block;font-size:14px;font-weight:600;margin:0 0 8px}
input{
  width:100%;font:inherit;font-size:18px;color:var(--ink);background:var(--field);
  border:1.5px solid var(--line);border-radius:14px;padding:14px 16px;outline:none;
  transition:border-color .15s,box-shadow .15s;
}
input:focus{border-color:var(--button);box-shadow:0 0 0 4px color-mix(in srgb,var(--button) 22%,transparent)}
input.code{font-size:28px;letter-spacing:.35em;text-align:center;font-variant-numeric:tabular-nums;padding:12px}
button{
  width:100%;margin-top:18px;font:inherit;font-weight:650;font-size:17px;color:#fff;
  background:var(--button);border:0;border-radius:14px;padding:15px 18px;cursor:pointer;
  box-shadow:0 12px 24px -12px var(--button);transition:background .15s,transform .12s;
}
button:hover{background:var(--button-hover)}
button:active{transform:translateY(1px)}
button:focus-visible{outline:3px solid color-mix(in srgb,var(--button) 45%,transparent);outline-offset:3px}
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
.links a:hover,.links button:hover{color:var(--ink);background:none}
.links form{margin:0}
`;

function document(title: string, body: string): string {
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${THEME_COLOR}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${THEME_COLOR_DARK}" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${CSS}</style>
</head>
<body>
<main class="stage">
<img class="logo" src="/logo.png" width="900" height="234" alt="">
<section class="card">
<p class="eyebrow">${BRAND}</p>
${body}
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
  const html = `<!doctype html><html lang="da"><body style="margin:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#16223a">
<div style="max-width:440px;margin:0 auto;padding:36px 24px">
<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${THEME_COLOR}">${BRAND}</p>
<p style="margin:0 0 20px;font-size:17px">Din kode til at logge ind:</p>
<p style="margin:0 0 20px;font-size:36px;font-weight:700;letter-spacing:.3em;font-variant-numeric:tabular-nums;color:${THEME_COLOR}">${code}</p>
<p style="margin:0;font-size:14px;color:#5d6b82">Den virker i ${CODE_MINUTES} minutter. Har du ikke bedt om den, kan du se bort fra denne mail.</p>
</div></body></html>`;
  return { subject: `${code} er din kode til ${BRAND}`, text, html };
}
