/**
 * Writes a brief built from the test fixtures — the fictional Eksempelsen
 * family — to stdout, as a whole document. For driving the hosted Worker under
 * `wrangler dev` without putting a real family's page in front of anyone, and
 * for looking at the page's design with every kind of element on it:
 *
 *   bun scripts/fixture-brief.ts | curl -X PUT --data-binary @- \
 *     -H 'authorization: Bearer <UPLOAD_TOKEN from .dev.vars>' \
 *     http://127.0.0.1:8787/api/brief
 *
 *   bun scripts/fixture-brief.ts > /tmp/brief.html && open /tmp/brief.html
 *
 * The day is deliberately busy: a card under every timeline heading, a
 * personal appointment, a recurring routine, a new source, an album, a fold
 * and a hidden item — so a stylesheet change can be judged on one page.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../src/brief/publish.ts';
import { renderPage } from '../src/brief/render.ts';
import { briefInput, card, rankedBrief, sourceItem } from '../src/testing/brief-fixtures.ts';

/** Local calendar days, as the brief itself counts them — not UTC's. */
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const inDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDay(date);
};
const today = inDays(0);
const nextWeekday = (weekday: number) => {
  for (let offset = 1; offset <= 7; offset += 1) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    if (date.getDay() === weekday) return localDay(date);
  }
  return inDays(7);
};
const thursday = nextWeekday(4);
const isoWeek = (() => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - start) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
})();

const items = [
  sourceItem({
    key: 'post:1001',
    title: 'Skolefoto i uge 40',
    text: 'Eksempel Foto kommer og fotograferer alle klasser. Husk at tilmelde jeres barn via linket inden fredag.',
    childNames: ['Alma Eksempelsen'],
    audience: 'institution',
    at: `${inDays(-1)}T08:15:00+00:00`,
    author: 'Eksempelskolens kontor',
    url: 'https://www.aula.dk/portal/#/posts/1001',
  }),
  sourceItem({
    key: 'thread:2002',
    kind: 'thread',
    title: 'Lejrskole for 2E',
    text: 'Vi tager af sted mandag morgen kl. 8. Husk regntøj, madpakke til mandag og en lille rygsæk.',
    childNames: ['Alma Eksempelsen'],
    author: 'Palle',
    at: `${inDays(-2)}T14:30:00+00:00`,
    conversation: {
      total: 2,
      truncated: false,
      messages: [
        {
          from: 'Palle',
          at: `${inDays(-2)}T14:30:00+00:00`,
          text: 'Vi tager af sted mandag morgen kl. 8. Husk regntøj, madpakke til mandag og en lille rygsæk.',
        },
        {
          from: 'Mette Eksempelsen',
          at: `${inDays(-2)}T16:02:00+00:00`,
          text: 'Tak — skal de have sovepose med, eller er der dyner?',
        },
      ],
    },
  }),
  sourceItem({
    key: 'plan:3003',
    kind: 'plan',
    title: 'Ugeplan for 2E',
    text: 'Idræt hver torsdag — husk idrætstøj og drikkedunk. Fredag læser vi højt.',
    childNames: ['Alma Eksempelsen'],
    author: 'Palle',
    at: `${inDays(-3)}T06:00:00+00:00`,
  }),
  sourceItem({
    key: 'post:4004',
    title: 'Lukkedag i Sommerfuglene',
    text: 'Stuen holder lukket fredag på grund af pædagogisk dag. Der er nødpasning på Myretuen.',
    childNames: ['Viggo Eksempelsen'],
    author: 'Kirsten',
    at: `${inDays(-4)}T10:20:00+00:00`,
  }),
  sourceItem({
    key: 'event:5005',
    kind: 'event',
    title: 'Bedsteforældredag',
    text: 'Bedsteforældre er velkomne fra kl. 9 til 11. Vi synger og viser vores værksteder frem.',
    childNames: ['Viggo Eksempelsen'],
    at: `${inDays(19)}T07:00:00+00:00`,
    endsAt: `${inDays(19)}T09:00:00+00:00`,
    author: 'Børnehuset Eksemplet',
  }),
  sourceItem({
    key: 'post:6006',
    title: 'Ny madordning efter efterårsferien',
    text: 'Fra efter efterårsferien kan man bestille frokost via Aula. Mere information følger.',
    childNames: ['Alma Eksempelsen'],
    audience: 'institution',
    at: `${inDays(-5)}T12:00:00+00:00`,
    author: 'Eksempelskolens kontor',
  }),
  sourceItem({
    key: 'thread:7007',
    kind: 'thread',
    title: 'Forældremøde i 2E',
    text: 'Tak for et godt møde i går. Referatet ligger under Fælles filer.',
    childNames: ['Alma Eksempelsen'],
    author: 'Palle',
    at: `${inDays(-3)}T18:45:00+00:00`,
  }),
  sourceItem({
    key: 'post:8008',
    title: 'Nyhedsbrev fra SFO',
    text: 'September i SFO: vi har bygget huler, spillet rundbold og startet et tegneværksted.',
    childNames: ['Alma Eksempelsen'],
    audience: 'institution',
    at: `${inDays(-6)}T15:00:00+00:00`,
    author: 'SFO Eksemplet',
  }),
  sourceItem({
    key: 'post:9009',
    title: 'Kursus for forældre: skærmtid',
    text: 'Kommunen inviterer alle forældre til et aftenkursus om børn og skærme.',
    audience: 'municipal',
    groups: ['Alle forældre alle skoler'],
    at: `${inDays(-7)}T09:00:00+00:00`,
    author: 'Eksempel Kommune',
  }),
  sourceItem({
    key: 'cal:mor@eksempel.dk:dentist',
    kind: 'personal',
    title: 'Tandlæge, Viggo',
    text: 'Tandlæge, Viggo · kl. 13:30–14:00 · Fra kalenderen «Familien»',
    at: `${inDays(1)}T13:30:00`,
    endsAt: `${inDays(1)}T14:00:00`,
    allDay: false,
    author: 'Familien',
    audience: 'family',
    location: 'Tandlægehuset',
    url: 'https://calendar.google.com/calendar/event?eid=eksempel',
  }),
];

const cards = [
  card({
    id: 'model:0',
    title: 'Tilmeld Alma til skolefoto',
    summary: 'Tilmeldingen sker via linket i opslaget og skal være på plads inden fredag.',
    children: ['Alma'],
    date: today,
    needsAction: true,
    actionableNow: true,
    reason: 'Kræver en tilmelding, og fristen er i denne uge.',
    sourceKeys: ['post:1001'],
  }),
  card({
    id: 'model:1',
    title: 'Lejrskole: regntøj, madpakke og rygsæk mandag',
    summary: 'Afgang kl. 8. Kun madpakke til mandag; resten af turen sørger skolen for maden.',
    children: ['Alma'],
    date: inDays(2),
    needsAction: true,
    reason: 'Noget skal pakkes, og dagen ligger inden for overblikkets vindue.',
    sourceKeys: ['thread:2002'],
  }),
  card({
    id: 'model:2',
    title: 'Husk idrætstøj om torsdagen',
    summary: 'Alma har idræt hver torsdag og skal have idrætstøj og drikkedunk med.',
    children: ['Alma'],
    date: thursday,
    recurring: true,
    needsAction: true,
    reason: 'En fast ugentlig rutine fra ugeplanen.',
    sourceKeys: ['plan:3003'],
  }),
  card({
    id: 'model:3',
    title: 'Sommerfuglene holder lukket fredag',
    summary: 'Pædagogisk dag på stuen. Viggo kan passes på Myretuen, hvis I har brug for det.',
    children: ['Viggo'],
    date: nextWeekday(5) === inDays(1) ? inDays(8) : nextWeekday(5),
    reason: 'Ændrer en almindelig pasningsdag.',
    sourceKeys: ['post:4004'],
  }),
  card({
    id: 'model:4',
    title: 'Bedsteforældredag i Børnehuset',
    summary: 'Bedsteforældre er velkomne kl. 9–11 med sang og værksteder.',
    children: ['Viggo'],
    date: inDays(19),
    reason: 'En dato familien kan invitere bedsteforældrene til.',
    sourceKeys: ['event:5005'],
  }),
  card({
    id: 'model:5',
    title: 'Frokost kan bestilles via Aula efter efterårsferien',
    summary: 'Skolen får en madordning. Hvordan man bestiller, kommer i et senere opslag.',
    children: ['Alma'],
    date: null,
    reason: 'Godt at vide, men uden en dato at handle på endnu.',
    sourceKeys: ['post:6006'],
  }),
  card({
    id: 'model:6',
    title: 'Referat fra forældremødet ligger i Aula',
    summary: 'Palle takker for mødet; referatet er lagt under Fælles filer.',
    children: ['Alma'],
    date: inDays(-3),
    reason: 'Opfølgning på et møde, der har været.',
    sourceKeys: ['thread:7007'],
  }),
];

const input = briefInput({
  today,
  isoWeek,
  items,
  family: {
    children: [
      {
        name: 'Alma Eksempelsen',
        firstName: 'Alma',
        institution: 'Eksempelskolen',
        className: '2E',
        presence: {
          child: 'Alma Eksempelsen',
          institution: 'Eksempelskolen',
          statusDanish: 'Kommet',
          plannedEntry: '07:45:00',
          plannedExit: '15:30:00',
        },
      },
      {
        name: 'Viggo Eksempelsen',
        firstName: 'Viggo',
        institution: 'Børnehuset Eksemplet',
        className: 'Sommerfuglene',
        presence: {
          child: 'Viggo Eksempelsen',
          institution: 'Børnehuset Eksemplet',
          statusDanish: 'Kommet',
          plannedEntry: '08:10:00',
          plannedExit: '16:00:00',
        },
      },
    ],
    isSteppedUp: true,
  },
  albums: [
    { title: 'Skovtur med 2E', at: inDays(-2), childNames: ['Alma'] },
    { title: 'Motorikdag på legepladsen', at: inDays(-5), childNames: ['Viggo'] },
  ],
  health: [
    { level: 'ok', message: 'Aula: 9 opslag, 3 beskeder og 2 albums læst.' },
    { level: 'ok', message: 'Ugeplan for 2E hentet fra MinUddannelse.' },
    { level: 'ok', message: 'Kalenderen «Familien» læst: 1 aftale i vinduet.' },
  ],
});

const brief = rankedBrief(input, cards, {
  hidden: ['post:9009'],
  personalEvents: [
    {
      sourceKey: 'cal:mor@eksempel.dk:dentist',
      relevant: true,
      summary: 'Viggo skal hentes tidligt; tandlægen ligger midt i børnehavens eftermiddag.',
      reason: 'Aftalen vedrører et barn og falder i institutionens åbningstid.',
    },
  ],
});

const body = renderPage(brief, {
  topline: 'Skolefotoet skal tilmeldes i dag, og Alma pakker til lejrskole søndag aften.',
  summaries: {
    Alma: 'Skolefoto, lejrskole mandag og idræt torsdag.',
    Viggo: 'Tandlæge i morgen; stuen holder lukket fredag.',
  },
  isNew: (key) => key === 'post:1001',
});
const dir = mkdtempSync(join(tmpdir(), 'aula-fixture-brief-'));
try {
  const { document } = await publish(body, { day: today, title: 'Aula AI oversigt', dir });
  process.stdout.write(document);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
