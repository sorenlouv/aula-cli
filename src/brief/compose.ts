/**
 * The page-writing call, and the layout used when it fails.
 *
 * The composer is given only *validated* signals — never the raw Aula payload —
 * so it can arrange facts but cannot invent one. That is what makes it safe to
 * hand it real freedom over the layout.
 */

import { runClaude } from './llm.ts';
import { COMPONENT_GUIDE } from './styles.ts';
import type { RankedBrief, RankedSignal } from './types.ts';

const DA_DAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const DA_MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
];

export function danishDate(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return `${DA_DAYS[date.getDay()]} ${date.getDate()}. ${DA_MONTHS[date.getMonth()]}`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** What the composer is allowed to know: facts, already checked. */
function composePayload(brief: RankedBrief, topline: string | null, summaries: Record<string, string>, isNew: (key: string) => boolean) {
  const signal = (s: RankedSignal) => ({
    signalId: s.id,
    sourceId: s.sourceKey,
    tier: s.tier,
    kind: s.kind,
    titel: s.title,
    barn: s.child,
    dato: s.dueAt,
    datoDansk: s.dueAt ? danishDate(s.dueAt) : null,
    hastighed: s.urgency,
    citat: s.quote,
    hvorfor: s.why,
    kilde: `${s.source.kind === 'post' ? 'Opslag' : s.source.kind === 'thread' ? 'Besked' : s.source.kind === 'plan' ? 'Ugeplan' : 'Kalender'} «${s.source.title}»`,
    afsender: s.source.author,
    link: s.source.url,
    nyt: isNew(s.sourceKey),
    ogsaaFra: s.mergedSourceKeys.length,
  });

  const { input } = brief;
  return {
    idag: input.today,
    idagDansk: capitalise(danishDate(input.today)),
    uge: input.isoWeek,
    topline,
    born: input.family.children.map((c, i) => ({
      navn: c.firstName,
      farve: `c${i + 1}`,
      institution: c.institution,
      klasse: c.className,
      planlagtIdag: c.presence
        ? `${(c.presence.plannedEntry ?? '').slice(0, 5)}–${(c.presence.plannedExit ?? '').slice(0, 5)}`
        : null,
      status: c.presence?.statusDanish ?? null,
      resume: summaries[c.firstName] ?? null,
    })),
    kraeverHandling: brief.signals.filter((s) => s.tier === 'act').map(signal),
    kommende: brief.signals.filter((s) => s.tier === 'week').map(signal),
    baggrund: brief.signals.filter((s) => s.tier === 'context').map(signal),
    skjult: brief.signals
      .filter((s) => s.tier === 'hidden')
      .map((s) => ({ titel: s.title, kilde: s.source.title, grupper: s.source.groups })),
    ubrugteKilder: brief.unusedSources.map((item) => ({
      sourceId: item.key,
      titel: item.title,
      afsender: item.author,
      skrevet: item.at,
      raekkevidde: item.audience,
    })),
    albums: input.albums,
    datastatus: input.health,
    noter: brief.degraded,
    billeder: input.newMediaCount,
  };
}

const INSTRUCTIONS = `Du designer og skriver en dansk HTML-side: en daglig "Aula AI oversigt" til en travl forælder, der sjældent åbner Aula.

Input er JSON på stdin med FÆRDIGT VALIDEREDE fakta. Du må omarrangere, gruppere, formulere og prioritere — men du må ALDRIG tilføje fakta, datoer eller citater, der ikke står i inputtet.

Svar KUN med HTML-markup til <body>. Ingen <!DOCTYPE>, <html>, <head> eller <body>. Ingen kodeblok. Ingen forklaring.

Stylesheet er allerede indlæst. Brug disse komponenter og klasser:
${COMPONENT_GUIDE}

Ufravigelige krav (siden afvises automatisk hvis de brydes):
1. Hvert punkt fra "kraeverHandling" og "kommende" SKAL med som et element med både data-signal-id="…" og data-source-id="…" præcis som i inputtet.
2. Alt fra "datastatus" SKAL med i <div class="panel" data-block="datastatus">. Fejl (level "warn") skal fremgå tydeligt — en fejlet hentning må ALDRIG ligne en stille uge.
3. Ingen eksterne filer: ingen <img>, <script src>, <link>, @import eller url(http…). Links med <a href> til aula.dk er i orden.
4. Intet må forsvinde: "baggrund" og "ubrugteKilder" hører til i en sammenklappet <details>, og "skjult" i <details class="muted"> nederst.
5. Skriv alt på dansk. Citater gengives ordret som de står i "citat", i «…».

Design:
- Øverst: <header> med dagens dato og børnene, derefter <p class="topline">. Den rækkefølge ligger fast.
- Under det bestemmer du selv layoutet ud fra hvad der faktisk er i dag: er der én stor ting, så giv den plads; er der mange små, så komprimér.
- Er "kraeverHandling" tom, så sig det tydeligt og roligt ("Intet kræver handling lige nu") frem for at vise en tom kasse.
- Marker ting hvor "nyt" er true med <span class="chip new">Ny</span>.
- Brug barnets farve (c1/c2/c3) konsekvent.
- Hold det skimbart på 20 sekunder.`;

export type ComposeResult = { html: string; origin: 'model' | 'fallback'; problems: string[] };

export async function composePage(
  brief: RankedBrief,
  opts: {
    topline?: string | null;
    summaries?: Record<string, string>;
    isNew?: (key: string) => boolean;
    timeoutMs?: number;
  } = {},
): Promise<ComposeResult> {
  const payload = composePayload(
    brief,
    opts.topline ?? null,
    opts.summaries ?? {},
    opts.isNew ?? (() => false),
  );
  const html = await runClaude(INSTRUCTIONS, JSON.stringify(payload), {
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  return { html: stripFence(html), origin: 'model', problems: [] };
}

function stripFence(raw: string): string {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}

/**
 * The layout used when the composer fails validation twice.
 *
 * Deliberately plain. Its job is to be *correct* — every required signal, every
 * health note, every source — on a day when the interesting path did not work.
 */
export function fallbackPage(
  brief: RankedBrief,
  opts: { topline?: string | null; summaries?: Record<string, string>; note?: string } = {},
): string {
  const { input } = brief;
  const colour = new Map(input.family.children.map((c, i) => [c.firstName, `c${i + 1}`]));
  const card = (s: RankedSignal) => `
    <div class="card ${s.urgency === 'now' ? 'now' : 'soon'}" data-signal-id="${escapeHtml(s.id)}" data-source-id="${escapeHtml(s.sourceKey)}">
      <div class="row">
        ${s.dueAt ? `<span class="chip ${s.urgency === 'now' ? 'now' : 'soon'}">${escapeHtml(capitalise(danishDate(s.dueAt)))}</span>` : ''}
        ${s.child ? `<span class="who"><span class="dot ${colour.get(s.child) ?? 'c1'}"></span>${escapeHtml(s.child)}</span>` : ''}
      </div>
      <p class="title">${escapeHtml(s.title)}</p>
      ${s.why ? `<p class="why">${escapeHtml(s.why)}</p>` : ''}
      ${s.quote ? `<blockquote>«${escapeHtml(s.quote)}»</blockquote>` : ''}
      <div class="src">${escapeHtml(s.source.title)}${s.source.author ? ` · ${escapeHtml(s.source.author)}` : ''}${s.source.url ? ` · <a href="${escapeHtml(s.source.url)}">åbn i Aula</a>` : ''}</div>
    </div>`;

  const act = brief.signals.filter((s) => s.tier === 'act');
  const week = brief.signals.filter((s) => s.tier === 'week');
  const context = brief.signals.filter((s) => s.tier === 'context');
  const hidden = brief.signals.filter((s) => s.tier === 'hidden');

  return `<div class="wrap">
  <header>
    <div>
      <h1>${escapeHtml(capitalise(danishDate(input.today)))}</h1>
      <div class="meta">Aula AI oversigt · uge ${escapeHtml(input.isoWeek)}${opts.note ? ` · ${escapeHtml(opts.note)}` : ''}</div>
    </div>
    <div class="kids">
      ${input.family.children
        .map(
          (c, i) =>
            `<div class="kid"><span class="dot c${i + 1}"></span><b>${escapeHtml(c.firstName)}</b><span>${escapeHtml(c.className ?? c.institution)}</span></div>`,
        )
        .join('')}
    </div>
  </header>
  <p class="topline">${escapeHtml(opts.topline ?? (act.length === 0 ? 'Intet kræver handling lige nu.' : `${act.length} ting kræver din opmærksomhed.`))}</p>

  <section><h2>Kræver handling <span class="count">${act.length}</span></h2>
    ${act.length ? act.map(card).join('') : '<div class="panel">Intet kræver handling lige nu.</div>'}
  </section>

  ${week.length ? `<section><h2>Kommende <span class="count">${week.length}</span></h2>${week.map(card).join('')}</section>` : ''}

  <section><h2>Per barn</h2><div class="grid">
    ${input.family.children
      .map(
        (c, i) => `<div class="cc"><h3><span class="dot c${i + 1}"></span>${escapeHtml(c.firstName)}</h3>
        <div class="sub">${escapeHtml([c.className, c.institution].filter(Boolean).join(' · '))}</div>
        ${opts.summaries?.[c.firstName] ? `<ul><li><i>·</i><span>${escapeHtml(opts.summaries[c.firstName] ?? '')}</span></li></ul>` : ''}
        ${c.presence ? `<div class="times">Planlagt i dag ${escapeHtml((c.presence.plannedEntry ?? '').slice(0, 5))}–${escapeHtml((c.presence.plannedExit ?? '').slice(0, 5))} · ${escapeHtml(c.presence.statusDanish)}</div>` : ''}
      </div>`,
      )
      .join('')}
  </div></section>

  ${
    context.length || brief.unusedSources.length
      ? `<section><h2>Godt at vide</h2><details><summary>${context.length + brief.unusedSources.length} ting uden noget, du skal gøre</summary>
      ${context.map((s) => `<div class="di" data-source-id="${escapeHtml(s.sourceKey)}"><b>${escapeHtml(s.title)}</b>${s.quote ? `<p>«${escapeHtml(s.quote)}»</p>` : ''}</div>`).join('')}
      ${brief.unusedSources.map((i) => `<div class="di" data-source-id="${escapeHtml(i.key)}"><b>${escapeHtml(i.title)}</b><p>${escapeHtml(i.author ?? '')}</p></div>`).join('')}
    </details></section>`
      : ''
  }

  <section><h2>Datastatus</h2><div class="panel" data-block="datastatus">
    ${input.health.map((h) => `<div class="st ${h.level === 'warn' ? 'bad' : ''}"><i>${h.level === 'warn' ? '⚠' : '○'}</i><span>${escapeHtml(h.message)}</span></div>`).join('')}
    ${brief.degraded.map((d) => `<div class="st bad"><i>⚠</i><span>${escapeHtml(d)}</span></div>`).join('')}
  </div></section>

  ${hidden.length ? `<details class="muted"><summary>${hidden.length} fællesbeskeder skjult</summary>${hidden.map((s) => `<div class="di"><b>${escapeHtml(s.title)}</b><p>${escapeHtml(s.source.groups.join(', '))}</p></div>`).join('')}</details>` : ''}

  <footer>Genereret lokalt af aula-cli · kun modelkald til Claude forlader maskinen</footer>
</div>`;
}
