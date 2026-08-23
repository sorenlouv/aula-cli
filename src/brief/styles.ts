/**
 * The design system the rendered page is built from.
 *
 * The stylesheet is *not* generated. The model writes the cards, but every
 * element and colour on the page comes from here — so a bad model day costs a
 * dull card, never an unreadable page.
 *
 * Derived from the mockup that was reviewed and approved, including the print
 * rules, which matter more than they look: the PDF is the copy that gets
 * forwarded, and anything collapsed on screen that is *brief content* has to be
 * expanded there. The one exception is `.more`, which holds verbatim source
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
  --bg:#16151a; --panel:#1e1d23; --ink:#f0eeea; --ink-2:#b4afa8; --ink-3:#807b74;
  --line:#302e37; --line-2:#26252c;
  --c1:#a5a0fb; --c2:#5eead4; --c3:#fda4af;
  --now:#fb923c; --now-bg:#2e1c10; --soon:#fbbf24; --soon-bg:#2a2210;
  --warn:#fbbf24; --warn-bg:#2a2210;
  --quote:#26252c;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px -6px rgba(0,0,0,.5);
`;

export const BRIEF_CSS = `
:root{
  --bg:#faf8f5; --panel:#fff; --ink:#1c1a17; --ink-2:#57534e; --ink-3:#8a837c;
  --line:#e7e2db; --line-2:#f0ece6;
  --c1:#4f46e5; --c2:#0d9488; --c3:#be123c;
  --now:#c2410c; --now-bg:#fff1e7; --soon:#a16207; --soon-bg:#fdf6e3;
  --warn:#b45309; --warn-bg:#fdf4e7;
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
/* The page script hides with the attribute; a display rule further down must
   not quietly win over it. */
[hidden]{display:none!important}
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
section{margin-bottom:34px}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);
  font-weight:650;margin:0 0 12px;display:flex;align-items:center;gap:10px}
h2::after{content:"";flex:1;height:1px;background:var(--line)}
.count{color:var(--ink-3);font-weight:500;letter-spacing:0}
.card{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:18px 58px 16px 20px;
  margin-bottom:10px;box-shadow:var(--shadow);border-left:3px solid var(--line)}
/* A card that asks something of the family is drawn with the warm edge; the
   chip beside its date says so in words. Cards to merely know keep the quiet
   edge, so the reader's eye finds the work in a list that is otherwise by date. */
.card.act{border-left-color:var(--now)}
.chip.act{background:var(--now-bg);color:var(--now)}
.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px}
.chip{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:6px}
.chip.now{background:var(--now-bg);color:var(--now)}
.chip.soon{background:var(--soon-bg);color:var(--soon)}
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
.more>summary:hover{color:var(--ink-2)}
.more>summary::after{content:"⌄";font-size:14px}
.more[open]>summary::after{content:"⌃"}
.more>summary:focus-visible{outline:2px solid var(--c2);outline-offset:3px;border-radius:4px}
.more .body{margin-top:4px;padding:12px 15px;background:var(--quote);border-radius:10px;
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
.tick:hover{border-color:var(--c2);color:var(--c2)}
.tick:focus-visible{outline:2px solid var(--c2);outline-offset:2px}
.tick[aria-pressed="true"]{background:var(--c2);border-color:var(--c2);color:var(--panel)}
/* Hidden, never dropped: the toggle below puts them back. Two classes on
   purpose: .cal-row sets its own display further down, and a single-class
   rule here would lose to it. */
.card.is-done,.cal-row.is-done{display:none}
section.reveal .card.is-done{display:block;opacity:.55}
section.reveal .card.is-done .title{text-decoration:line-through}
section.reveal .cal-row.is-done{display:flex;opacity:.55}
section.reveal .cal-row.is-done .cal-title{text-decoration:line-through}

/* Kommende is in date order; the undated tail — mostly Kræver handling's
   overflow — is set off so it is visible why those carry no date chip. */
.divider{margin:16px 0 10px;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-3);font-weight:650}

/* The family's own calendar — see calendarSection in render.ts. One line per
   appointment, days as plain labels, folded shut: the summary carries what is
   worth knowing before the fold is opened. */
.cal>summary{font-weight:500;font-size:14px;color:var(--ink-2);gap:14px;line-height:1.45}
.cal-body{padding:4px 18px 12px}
.cal-day{margin:12px 0 4px;font-size:12px;font-weight:650;color:var(--ink-3)}
.cal-day:first-child{margin-top:4px}
.cal-row{position:relative;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
  padding:7px 40px 7px 0;border-top:1px solid var(--line-2);font-size:14px}
.cal-day+.cal-row{border-top:0}
.cal-when{flex:none;min-width:7.5em;color:var(--ink-3);font-size:12.5px;font-variant-numeric:tabular-nums}
.cal-title{flex:1 1 auto;min-width:0;font-weight:600}
.cal-src{margin-left:auto;font-size:12px;color:var(--ink-3);white-space:nowrap}
.cal-src a{color:var(--ink-3);text-decoration:underline;text-underline-offset:2px;white-space:nowrap}
.cal-row .tick{top:50%;right:4px;width:24px;height:24px;margin-top:-12px;font-size:12px}
/* The empty-state line under two visible cards reads as a contradiction,
   however true the count is. While they are on show, the toggle says it. */
section.reveal [data-empty]{display:none}
.done-toggle{display:block;width:100%;margin:2px 0 0;padding:9px 13px;text-align:left;
  border:1px dashed var(--line);border-radius:10px;background:transparent;
  color:var(--ink-3);font:inherit;font-size:12.5px;cursor:pointer}
.done-toggle:hover{color:var(--ink-2);border-color:var(--ink-3)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
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
/* Direct child, not descendant: a more-block sits *inside* the context section, and a
   descendant selector points its chevron up while it is still shut — the outer
   section's open state deciding the inner one's arrow. */
details[open]>summary::after{content:"⌃"}
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
  .card,.cc,.panel,details,.tile{box-shadow:none}
  details{opacity:1}
  summary::after{display:none}
  .card,.cc,.di{break-inside:avoid}
  /* A tick is something to press, so it is chrome, not content. The count it
     produced stays — the forwarded PDF should still say two were dealt with —
     but the cards themselves keep out of it however the section was left. */
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
  .cal-row{padding-right:0;break-inside:avoid}
  section.reveal .card.is-done,section.reveal .cal-row.is-done{display:none}
  .done-toggle{border-style:solid;cursor:auto}
}
@media (max-width:680px){
  .wrap{padding:26px 16px 60px;overflow-wrap:anywhere}
  h1{font-size:27px}
  .topline{font-size:17.5px}
  /* As a flex item, the chip row otherwise keeps its max-content width and
     makes the whole page wider than a narrow phone before its own wrap runs. */
  .kids{width:100%;min-width:0}
  /* A phone has no room for time, title and source on one line: the source
     drops under the title, indented past the time column, rather than
     floating right on a line of its own. */
  .cal-when{min-width:6.5em}
  .cal-src{flex-basis:100%;margin-left:0;margin-top:-2px;padding-left:calc(6.5em + 10px);white-space:normal}
}
`;
