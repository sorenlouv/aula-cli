/**
 * The design system the rendered page is built from.
 *
 * The stylesheet is *not* generated. The model writes the cards, but every
 * element and colour on the page comes from here — so a bad model day costs a
 * dull card, never an unreadable page.
 *
 * The look is the hosted login page's, carried onto a long page: its blue
 * (`THEME_COLOR` in `hosting/pages.ts`, sampled from the family's logo) is a
 * masthead band with the same two soft radial glows, the day's one-line
 * summary is a white card that floats over the band's lower edge the way the
 * login card floats on its stage, and every card below takes a quieter cut of
 * the same drop shadow. The heading takes the rounded face the login uses.
 * The child colours, the warm "needs action" edge and the print rules are
 * this page's own.
 *
 * The print rules matter more than they look: the PDF is the copy that gets
 * forwarded, and anything collapsed on screen that is *brief content* has to
 * be expanded there. The one exception is `.more`, which holds verbatim source
 * material rather than brief content — see the print block at the bottom.
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
  --bg:#0f1626; --panel:#1a2436; --ink:#eef2f8; --ink-2:#b3bfd2; --ink-3:#8593a9;
  --line:#2d3a52; --line-2:#26314a;
  --accent:#8fb0e3;
  --band:#16243d; --band-glow:rgba(48,87,145,.6); --band-shade:rgba(0,0,0,.35);
  --c1:#8fb0e3; --c2:#5eead4; --c3:#fda4af;
  --now:#fb923c; --now-bg:#2e1c10; --soon:#a9c4ee; --soon-bg:#1f2f4d;
  --warn:#fbbf24; --warn-bg:#2a2210;
  --quote:#141d2c;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 12px 28px -14px rgba(0,0,0,.6);
  --shadow-lift:0 30px 60px -24px rgba(0,0,0,.7),0 10px 24px -12px rgba(0,0,0,.5);
`;

export const BRIEF_CSS = `
:root{
  --bg:#f1f5fb; --panel:#fff; --ink:#16223a; --ink-2:#4f5d75; --ink-3:#7a889e;
  --line:#dbe3ef; --line-2:#e9eef6;
  --accent:#305791;
  --band:#305791; --band-glow:rgba(120,165,230,.45); --band-shade:rgba(10,26,56,.35);
  --c1:#4f86e0; --c2:#14b8a6; --c3:#e0457b;
  --now:#c2410c; --now-bg:#fff1e7; --soon:#2b5390; --soon-bg:#e6eefa;
  --warn:#b45309; --warn-bg:#fdf4e7;
  --quote:#f3f6fb;
  --shadow:0 1px 2px rgba(16,36,72,.05),0 12px 28px -14px rgba(16,36,72,.22);
  --shadow-lift:0 30px 60px -24px rgba(10,26,56,.45),0 10px 24px -12px rgba(10,26,56,.28);
  /* How far the masthead reaches below its text, and so how far the topline
     card is pulled up over it. */
  --lift:76px;
}
/* System setting: nothing is stamped, so only the OS preference is available. */
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){${DARK_TOKENS}}
}
/* Explicit choice: the stamp wins over the OS in both directions. */
:root[data-theme="dark"]{${DARK_TOKENS}}
*{box-sizing:border-box}
/* The page script hides with the attribute; a display rule further down must
   not quietly win over it. */
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.55 ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}

/* The masthead: the login page's blue stage, as a band. The two glows are the
   login's, drawn on the band's own box rather than as viewport-sized circles,
   so they scale with the band instead of flattening out across a wide screen. */
.masthead{color:#fff;padding:calc(30px + env(safe-area-inset-top,0px)) 0 var(--lift);
  background:
    radial-gradient(120% 150% at 50% -45%,var(--band-glow) 0%,transparent 60%),
    radial-gradient(70% 130% at 100% 130%,var(--band-shade) 0%,transparent 62%),
    var(--band)}
.masthead-inner{max-width:940px;margin:0 auto;padding:0 24px;
  display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap}
.eyebrow{margin:0 0 6px;font-size:12.5px;font-weight:650;letter-spacing:.14em;text-transform:uppercase;
  color:rgba(255,255,255,.74)}
h1{margin:0;font:700 38px/1.08 ui-rounded,"SF Pro Rounded","Nunito","Varela Round",system-ui,sans-serif;
  letter-spacing:-.02em;color:#fff}
.kids{display:flex;gap:8px;flex-wrap:wrap}
.kid{display:flex;align-items:center;gap:7px;background:rgba(255,255,255,.14);
  border:1px solid rgba(255,255,255,.26);border-radius:99px;padding:5px 12px 5px 8px;font-size:12.5px;color:#fff}
.kid span{color:rgba(255,255,255,.74)}
.dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
/* On the band a child's colour needs a rim to read as a badge and not a stain. */
.kid .dot{box-shadow:0 0 0 2px rgba(255,255,255,.85)}
.c1{background:var(--c1)} .c2{background:var(--c2)} .c3{background:var(--c3)}

.wrap{max-width:940px;margin:0 auto;padding:40px 24px 80px}
/* The day's one line floats over the band's edge — the login card on its
   stage. Only when it leads the page: a warning that comes first sits above
   it, and the topline then keeps to the flow. */
.topline{position:relative;font-size:20px;line-height:1.5;letter-spacing:-.01em;margin:0 0 34px;
  padding:22px 26px;background:var(--panel);border-radius:18px;box-shadow:var(--shadow-lift)}
.wrap>.topline:first-child{margin-top:calc(-1 * var(--lift))}
.overview-warning .panel{background:var(--warn-bg);border-color:var(--warn)}
.overview-warning .st{font-weight:550}
.overview-warning .st span{color:var(--ink)}
section{margin-bottom:34px}
h2,.timeline-heading{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);
  font-weight:700;margin:0 0 12px;display:flex;align-items:center;gap:10px}
h2::after,.timeline-heading::after{content:"";flex:1;height:1px;background:var(--line)}
.count{color:var(--ink-3);font-weight:500;letter-spacing:0}
.card{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:16px;
  padding:18px 58px 16px 20px;
  margin-bottom:12px;box-shadow:var(--shadow);border-left:3px solid var(--line)}
/* A card that asks something of the family is drawn with the warm edge — the
   whole of what says so, now that Skal gøres heads the work that can be done
   now and a badge saying the same thing has gone. Cards to merely know keep the
   quiet edge, so the reader's eye finds the work in a list that is by date. */
.card.act{border-left-color:var(--now)}
.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px}
.chip{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:7px}
.chip.now{background:var(--now-bg);color:var(--now)}
.chip.soon{background:var(--soon-bg);color:var(--soon)}
.chip.recurring{background:var(--quote);color:var(--ink-2);border:1px solid var(--line)}
.chip.new{background:transparent;color:var(--ink-3);border:1px dashed var(--line)}
.who{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-2);font-weight:550}
.title{font-size:17.5px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
.summary{color:var(--ink-2);font-size:14.5px;margin:0 0 10px}
/* Why the card is on the page, first thing inside Læs mere. */
.reason{margin:0 0 10px;font-size:13.5px;color:var(--ink-2)}
.reason b{font-weight:650;color:var(--ink)}
/* One source inside a card's fold; a second and later one is set off from the
   first, so a merged card reads as its parts. */
.src-block+.src-block{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.src-block>.msg-head{margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.src-block>.msg-head a{margin-left:auto;font-size:11.5px;color:var(--ink-3);text-decoration:underline;text-underline-offset:2px}
.src{margin-top:9px;font-size:12px;color:var(--ink-3)}
.src a{color:var(--ink-3);text-decoration:underline;text-underline-offset:2px}

/* The more-block — the original, one tap under the summary of it. Deliberately
   quiet: on most days it is not needed, and a card that shouts about its own
   footnote is a card that reads slower. */
.more{margin-top:10px;background:transparent;border:0;border-radius:0;box-shadow:none}
.more>summary{padding:4px 0;font-size:12.5px;font-weight:550;color:var(--ink-3);
  justify-content:flex-start;gap:6px}
.more>summary:hover{color:var(--accent)}
.more>summary::after{content:"⌄";font-size:14px}
.more[open]>summary::after{content:"⌃"}
.more>summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.more .body{margin-top:4px;padding:12px 15px;background:var(--quote);border-radius:12px;
  font-size:14px;color:var(--ink-2)}
.more .body>p{margin:0 0 9px}
.more .body>p:last-child{margin-bottom:0}
.msg{padding:11px 0;border-top:1px solid var(--line)}
.msg:first-child{padding-top:0;border-top:0}
.msg:last-child{padding-bottom:0}
.msg-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:5px}
.msg-head b{font-size:13px;font-weight:650;color:var(--ink)}
.msg-head span{font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.msg p{margin:0 0 8px}
.msg p:last-child{margin-bottom:0}
.msg-note{margin:11px 0 0;padding-top:9px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--ink-3)}

/* Ticking off — see done.ts. The circle is drawn rather than imaged, because
   the page may not reference an external resource and has to print. */
.tick{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;
  border:1.5px solid var(--line);background:transparent;color:transparent;
  font-size:15px;line-height:1;padding:0;cursor:pointer;display:grid;place-items:center;
  -webkit-tap-highlight-color:transparent;transition:background .12s,border-color .12s,color .12s}
.tick::before{content:"✓"}
/* A thumb is wider than the circle it is aiming at. */
.tick::after{content:"";position:absolute;inset:-9px;border-radius:50%}
.tick:hover{border-color:var(--accent);color:var(--accent)}
.tick:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tick[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--panel)}
/* Hidden, never dropped: the toggle below puts them back. */
.card.is-done{display:none}
section.reveal .card.is-done{display:block;opacity:.55}
section.reveal .card.is-done .title,
section.reveal .card.is-done .calendar-title{text-decoration:line-through}

/* The timeline is led by dates rather than one generic heading. Each wrapper
   also lets the done-state script hide an empty heading with its cards. */
.timeline-group{margin-bottom:22px}
.timeline-group:last-child{margin-bottom:0}

/* The empty-state line under two visible cards reads as a contradiction,
   however true the count is. While they are on show, the toggle says it. */
section.reveal [data-empty]{display:none}
.done-toggle{display:block;width:100%;margin:2px 0 0;padding:9px 13px;text-align:left;
  border:1px dashed var(--line);border-radius:12px;background:transparent;
  color:var(--ink-3);font:inherit;font-size:12.5px;cursor:pointer}
.done-toggle:hover{color:var(--accent);border-color:var(--accent)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(272px,1fr));gap:12px}
.cc{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow)}
.cc h3{margin:0 0 2px;font-size:16.5px;font-weight:650;display:flex;align-items:center;gap:8px}
.cc .sub{font-size:12.5px;color:var(--ink-3);margin-bottom:12px}
.cc ul{margin:0;padding:0;list-style:none}
.cc li{font-size:13.5px;color:var(--ink-2);padding:5px 0;border-top:1px solid var(--line-2);display:flex;gap:8px}
.cc li:first-child{border-top:0}
.times{margin-top:11px;padding-top:10px;border-top:1px solid var(--line-2);font-size:12px;
  color:var(--ink-3);font-variant-numeric:tabular-nums}
details{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
summary{cursor:pointer;padding:15px 18px;font-size:14.5px;font-weight:600;list-style:none;
  display:flex;justify-content:space-between;align-items:center}
summary::-webkit-details-marker{display:none}
summary::after{content:"⌄";color:var(--ink-3);font-size:17px;line-height:1}
/* Direct child, not descendant: a more-block sits *inside* the context section, and a
   descendant selector points its chevron up while it is still shut — the outer
   section's open state deciding the inner one's arrow. */
details[open]>summary::after{content:"⌃"}

/* A personal appointment shares the timeline's chronology without borrowing the
   visual weight of an Aula card. The face is one compact flex row; the model's
   summary and reason live in the individual fold. */
.calendar-card{padding:0 46px 0 0;border-left-color:var(--line);box-shadow:none;margin-bottom:6px}
details.calendar-details{background:transparent;border:0;border-radius:12px;box-shadow:none}
details.calendar-details>summary{padding:9px 8px 9px 13px;font-weight:500;gap:8px;min-height:46px}
details.calendar-details>summary::after{margin-left:auto;flex:none}
.calendar-face{display:flex;align-items:center;gap:9px;flex:1 1 auto;min-width:0;flex-wrap:wrap}
.calendar-when{color:var(--ink-3);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.calendar-title{font-size:14px;font-weight:600;color:var(--ink);min-width:0}
.calendar-origin{margin-left:auto;color:var(--ink-3);font-size:11.5px;white-space:nowrap}
.calendar-body{padding:11px 14px 13px;border-top:1px solid var(--line-2);color:var(--ink-2)}
.calendar-copy{font-size:13.5px;margin:0 0 9px}
.calendar-body .reason{font-size:12.5px;margin-bottom:9px}
.calendar-meta{font-size:12px;color:var(--ink-3)}
.calendar-meta a{color:var(--ink-3);text-decoration:underline;text-underline-offset:2px}
.calendar-card .tick{top:11px;right:10px;width:24px;height:24px;font-size:12px}
.di{padding:12px 18px;border-top:1px solid var(--line-2)}
.di:first-of-type{border-top:0}
.di b{font-size:14px;font-weight:600;display:block}
.di p{margin:3px 0 0;font-size:13.5px;color:var(--ink-2)}
.di .src{margin-top:7px}
.di .more .body p{font-size:14px}
details.muted{margin-top:30px;background:transparent;border-style:dashed;box-shadow:none;opacity:.62}
details.muted summary{font-size:12.5px;font-weight:500;color:var(--ink-3);padding:11px 16px}
/* The datastatus panel lives in two places — hoisted as its own section on a
   day something failed to fetch, and inside this fold on a day nothing did.
   Inside, it drops the card it draws elsewhere; a panel within a panel reads
   as two things. */
details.muted .panel{background:transparent;border:0;border-radius:0;box-shadow:none;padding:0 16px 13px}
.chips{display:flex;gap:9px;flex-wrap:wrap}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:11px 14px;
  font-size:13px;box-shadow:var(--shadow);min-width:172px}
.tile b{display:block;font-weight:600;margin-bottom:2px}
.tile span{color:var(--ink-3);font-size:12px}
.st{display:flex;gap:10px;font-size:13.5px;padding:7px 0;border-top:1px solid var(--line-2);align-items:flex-start}
.st:first-child{border-top:0}
.st i{font-style:normal;flex:none}
.st.bad{color:var(--warn)}
.st span{color:var(--ink-2)}
footer{margin-top:34px;text-align:center;color:var(--ink-3);font-size:12px}
@media print{
  body{background:#fff}
  /* The band is screen chrome; on paper the masthead is plain ink, and the
     topline card takes its place in the flow. */
  .masthead{background:none;color:var(--ink);padding:0 0 14px}
  .eyebrow{color:var(--accent)}
  h1{color:var(--ink)}
  .kid{background:transparent;border-color:var(--line);color:var(--ink)}
  .kid span{color:var(--ink-3)}
  .kid .dot{box-shadow:none}
  .wrap>.topline:first-child{margin-top:0}
  .topline{border:1px solid var(--line)}
  .topline,.card,.cc,.panel,details,.tile{box-shadow:none}
  details{opacity:1}
  summary::after{display:none}
  .card,.cc,.di{break-inside:avoid}
  /* A tick is something to press, so it is chrome, not content. Completed
     cards keep out of the forwarded PDF however the section was left. */
  .tick{display:none}
  /* Every other <details> is expanded for print, because a collapsed section
     would print as a heading with nothing under it. Not this one: it holds
     verbatim source material rather than brief content, and expanding all of
     it would turn two forwardable pages into twenty. What the brief actually
     says — title, why and summary — is outside the
     toggle and prints; the original stays one link away in Aula. See the
     beforeprint hook in publish.ts, which skips these to match. */
  .more{display:none}
  .card{padding-right:20px}
  section.reveal .card.is-done{display:none}
  .done-toggle{border-style:solid;cursor:auto}
}
@media (max-width:680px){
  :root{--lift:64px}
  .masthead{padding-top:calc(22px + env(safe-area-inset-top,0px))}
  .masthead-inner{padding:0 16px;gap:16px}
  .wrap{padding:26px 16px 60px;overflow-wrap:anywhere}
  h1{font-size:29px}
  .topline{font-size:17.5px;padding:18px 20px}
  /* As a flex item, the chip row otherwise keeps its max-content width and
     makes the whole page wider than a narrow phone before its own wrap runs. */
  .kids{width:100%;min-width:0}
  .calendar-card{padding-right:42px}
  .calendar-origin{flex-basis:100%;margin-left:0}
}
`;
