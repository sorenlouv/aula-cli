/**
 * The design system the composer works inside.
 *
 * The stylesheet is *not* generated. The model chooses which components to use,
 * in what order and at what emphasis, but it cannot redefine a colour or a
 * font — so a bad day costs an odd layout, never an unreadable page.
 *
 * Derived from the mockup that was reviewed and approved, including the print
 * rules, which matter more than they look: the PDF is the copy that gets
 * forwarded, and anything collapsed on screen has to be expanded there.
 */

/**
 * The dark palette, written once and applied through two different selectors.
 *
 * A reader has three states, not two: an explicit choice stamps
 * `data-theme` on the root, while the default "system" setting stamps nothing
 * and leaves only `prefers-color-scheme` to go on. So the same tokens are
 * needed behind the media query *and* behind `[data-theme="dark"]`. Defining
 * them in only one place is how a page ends up rendering one theme's text on
 * the other theme's background.
 */
const DARK_TOKENS = `
  --bg:#16151a; --panel:#1e1d23; --ink:#f0eeea; --ink-2:#b4afa8; --ink-3:#807b74;
  --line:#302e37; --line-2:#26252c;
  --c1:#a5a0fb; --c2:#5eead4; --c3:#fda4af;
  --now:#fb923c; --now-bg:#2e1c10; --soon:#fbbf24; --soon-bg:#2a2210;
  --ok:#86efac; --ok-bg:#14251a; --warn:#fbbf24; --warn-bg:#2a2210;
  --quote:#26252c;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px -6px rgba(0,0,0,.5);
`;

export const BRIEF_CSS = `
:root{
  --bg:#faf8f5; --panel:#fff; --ink:#1c1a17; --ink-2:#57534e; --ink-3:#8a837c;
  --line:#e7e2db; --line-2:#f0ece6;
  --c1:#4f46e5; --c2:#0d9488; --c3:#be123c;
  --now:#c2410c; --now-bg:#fff1e7; --soon:#a16207; --soon-bg:#fdf6e3;
  --ok:#15803d; --ok-bg:#effaf1; --warn:#b45309; --warn-bg:#fdf4e7;
  --quote:#f7f4ef;
  --shadow:0 1px 2px rgba(28,26,23,.04),0 4px 16px -6px rgba(28,26,23,.10);
}
/* System setting: nothing is stamped, so only the OS preference is available. */
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){${DARK_TOKENS}}
}
/* Explicit choice: the stamp wins over the OS in both directions. */
:root[data-theme="dark"]{${DARK_TOKENS}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.55 ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:940px;margin:0 auto;padding:40px 24px 80px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap;margin-bottom:28px}
h1{margin:0;font-size:34px;letter-spacing:-.02em;font-weight:650}
.meta{color:var(--ink-3);font-size:13px;margin-top:4px}
.kids{display:flex;gap:8px;flex-wrap:wrap}
.kid{display:flex;align-items:center;gap:7px;background:var(--panel);border:1px solid var(--line);
  border-radius:99px;padding:5px 12px 5px 8px;font-size:12.5px;box-shadow:var(--shadow)}
.dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
.kid span{color:var(--ink-3)}
.c1{background:var(--c1)} .c2{background:var(--c2)} .c3{background:var(--c3)}
.topline{font-size:20px;line-height:1.5;letter-spacing:-.01em;margin:0 0 34px;padding:20px 22px;
  background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
.topline .lead{font-weight:600}
section{margin-bottom:34px}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);
  font-weight:650;margin:0 0 12px;display:flex;align-items:center;gap:10px}
h2::after{content:"";flex:1;height:1px;background:var(--line)}
.count{color:var(--ink-3);font-weight:500;letter-spacing:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px 16px;
  margin-bottom:10px;box-shadow:var(--shadow);border-left:3px solid var(--line)}
.card.now{border-left-color:var(--now)}
.card.soon{border-left-color:var(--soon)}
.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px}
.chip{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:6px}
.chip.now{background:var(--now-bg);color:var(--now)}
.chip.soon{background:var(--soon-bg);color:var(--soon)}
.chip.later{background:var(--line-2);color:var(--ink-2)}
.chip.ok{background:var(--ok-bg);color:var(--ok)}
.chip.new{background:transparent;color:var(--ink-3);border:1px dashed var(--line)}
.who{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-2);font-weight:550}
.title{font-size:17.5px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
.why{color:var(--ink-2);font-size:14.5px;margin:0 0 10px}
blockquote{margin:0;padding:9px 14px;background:var(--quote);border-radius:8px;font-size:13.5px;
  color:var(--ink-2);font-style:italic}
.src{margin-top:9px;font-size:12px;color:var(--ink-3)}
.src a{color:var(--ink-3);text-decoration:underline;text-underline-offset:2px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.appt{display:flex;gap:16px;padding:13px 4px;border-bottom:1px solid var(--line-2)}
.appt:last-child{border-bottom:0}
.when{flex:none;width:112px;font-variant-numeric:tabular-nums}
.when b{display:block;font-size:14.5px;font-weight:600}
.when span{font-size:12px;color:var(--ink-3)}
.what b{font-weight:600;font-size:15px}
.what p{margin:3px 0 0;font-size:13.5px;color:var(--ink-2)}
.week{display:grid;grid-template-columns:repeat(7,1fr);gap:7px}
.day{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:11px 10px;
  min-height:104px;box-shadow:var(--shadow)}
.day.today{border-color:var(--now);background:var(--now-bg)}
.day.weekend{background:transparent;border-style:dashed;box-shadow:none}
.dname{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);font-weight:650}
.dnum{font-size:19px;font-weight:600;margin:1px 0 8px;font-variant-numeric:tabular-nums}
.ev{font-size:11.5px;line-height:1.35;margin-bottom:6px;display:flex;gap:5px}
.ev .dot{margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(272px,1fr));gap:12px}
.cc{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.cc h3{margin:0 0 2px;font-size:16.5px;font-weight:650;display:flex;align-items:center;gap:8px}
.cc .sub{font-size:12.5px;color:var(--ink-3);margin-bottom:12px}
.cc ul{margin:0;padding:0;list-style:none}
.cc li{font-size:13.5px;color:var(--ink-2);padding:5px 0;border-top:1px solid var(--line-2);display:flex;gap:8px}
.cc li:first-child{border-top:0}
.times{margin-top:11px;padding-top:10px;border-top:1px solid var(--line-2);font-size:12px;
  color:var(--ink-3);font-variant-numeric:tabular-nums}
details{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
summary{cursor:pointer;padding:15px 18px;font-size:14.5px;font-weight:600;list-style:none;
  display:flex;justify-content:space-between;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"⌄";color:var(--ink-3);font-size:17px;line-height:1}
details[open] summary::after{content:"⌃"}
.di{padding:12px 18px;border-top:1px solid var(--line-2)}
.di:first-of-type{border-top:0}
.di b{font-size:14px;font-weight:600;display:block}
.di p{margin:3px 0 0;font-size:13.5px;color:var(--ink-2)}
details.muted{margin-top:30px;background:transparent;border-style:dashed;box-shadow:none;opacity:.62}
details.muted summary{font-size:12.5px;font-weight:500;color:var(--ink-3);padding:11px 16px}
.chips{display:flex;gap:9px;flex-wrap:wrap}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:11px 14px;
  font-size:13px;box-shadow:var(--shadow);min-width:172px}
.tile b{display:block;font-weight:600;margin-bottom:2px}
.tile span{color:var(--ink-3);font-size:12px}
.st{display:flex;gap:10px;font-size:13.5px;padding:7px 0;border-top:1px solid var(--line-2);align-items:flex-start}
.st:first-child{border-top:0}
.st i{font-style:normal;flex:none}
.st.bad{color:var(--warn)}
.st span{color:var(--ink-2)}
footer{margin-top:26px;text-align:center;color:var(--ink-3);font-size:12px}
@media print{
  body{background:#fff}
  .card,.cc,.day,.panel,details,.tile{box-shadow:none}
  details{opacity:1}
  summary::after{display:none}
  .card,.cc,.di,.appt{break-inside:avoid}
}
@media (max-width:680px){
  .week{grid-template-columns:repeat(2,1fr)}
  .wrap{padding:26px 16px 60px}
  h1{font-size:27px}
  .topline{font-size:17.5px}
}
`;

/** Handed to the composer verbatim, so it builds from tested parts. */
export const COMPONENT_GUIDE = `
Wrapper (required, outermost): <div class="wrap"> … </div>

header      <header><div><h1>Torsdag 13. august</h1><div class="meta">…</div></div>
              <div class="kids"><div class="kid"><span class="dot c1"></span><b>Alma</b><span>2E · 07–17</span></div>…</div></header>
topline     <p class="topline"><span class="lead">Kort konklusion.</span> Uddybning.</p>
section     <section><h2>Overskrift <span class="count">3</span></h2> … </section>
card        <div class="card now|soon" data-signal-id="…" data-source-id="…">
              <div class="row"><span class="chip now|soon|later|ok|new">I DAG</span>
                <span class="who"><span class="dot c1"></span>Alma</span></div>
              <p class="title">…</p><p class="why">…</p>
              <blockquote>«ordret citat»</blockquote>
              <div class="src">kilde · <a href="…">åbn i Aula</a></div></div>
list panel  <div class="panel"><div class="appt"><div class="when"><b>Fre 18/9</b><span>13.00–14.00</span></div>
              <div class="what"><b>Titel</b><p>Detalje</p></div></div>…</div>
week strip  <div class="week"><div class="day today|weekend"><div class="dname">Tor</div><div class="dnum">13</div>
              <div class="ev"><span class="dot c1"></span><span>…</span></div></div>× 7</div>
child cards <div class="grid"><div class="cc"><h3><span class="dot c1"></span>Alma</h3>
              <div class="sub">2E · Eksempelskolen</div><ul><li><i>!</i><span>…</span></li></ul>
              <div class="times">Planlagt i dag 07.00–17.00</div></div>…</div>
collapsible <details><summary>4 opslag uden noget, du skal gøre</summary>
              <div class="di"><b>Titel</b><p>…</p><div class="src">…</div></div>…</details>
muted fold  <details class="muted"><summary>3 kommunale fællesbeskeder skjult</summary>…</details>
tiles       <div class="chips"><div class="tile"><b>Album</b><span>…</span></div>…</div>
status      <div class="panel" data-block="datastatus"><div class="st bad"><i>⚠</i><span>…</span></div>
              <div class="st"><i>✓</i><span>…</span></div></div>
footer      <footer>…</footer>

Child colours: c1 = first child, c2 = second, c3 = third. Use the same one everywhere for a given child.
`;
