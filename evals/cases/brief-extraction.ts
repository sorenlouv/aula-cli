import type { BriefInput, SourceItem } from '../../src/brief/types.ts';
import type { BriefExtractionEvalCase } from '../types.ts';

const children = [
  {
    name: 'Alma Eksempelsen',
    firstName: 'Alma',
    institution: 'Eksempelskolen',
    className: '2.E',
    presence: null,
  },
  {
    name: 'Otto Eksempelsen',
    firstName: 'Otto',
    institution: 'Børnehuset Eksemplet',
    className: 'Sommerfuglene',
    presence: null,
  },
];

function input(items: SourceItem[]): BriefInput {
  return {
    today: '2026-08-23',
    isoWeek: '2026-W34',
    windowDays: 14,
    family: { children, isSteppedUp: true },
    items,
    health: [],
    albums: [],
    preferences: [],
  };
}

function personal(id: string, title: string, at: string, details = ''): SourceItem {
  return {
    key: `cal:familien:${id}:${at}`,
    kind: 'personal',
    title,
    text: [title, details, 'Fra kalenderen «Familien»'].filter(Boolean).join(' · '),
    at,
    author: 'forælder@eksempel.dk',
    groups: [],
    childNames: [],
    audience: 'family',
    important: false,
    url: null,
  };
}

function aulaSource(overrides: Partial<SourceItem> & Pick<SourceItem, 'key'>): SourceItem {
  return {
    kind: 'post',
    title: 'Opslag',
    text: '',
    at: '2026-08-21T09:00:00+02:00',
    author: 'Eksempel Lærer',
    groups: ['2.E'],
    childNames: ['Alma Eksempelsen'],
    audience: 'class',
    important: false,
    url: null,
    ...overrides,
  };
}

const cryptic = personal('cryptic', 'Q', '2026-08-23T09:00:00+02:00');
const glasses = personal('glasses', 'Far nye briller', '2026-08-24T11:00:00+02:00');
const friends = personal('friends', 'Kaffe med gamle venner', '2026-08-25T20:00:00+02:00');
const dentist = personal('dentist', 'Tandlæge', '2026-08-26T13:30:00+02:00');
const weekend = personal('weekend', 'Weekendtur med en ven', '2026-08-29T09:00:00+02:00');
const course = personal('course', 'Keramikkursus', '2026-08-30T10:00:00+02:00');
const playdate = personal(
  'playdate',
  'Tag Otto med hjem',
  '2026-08-24T15:00:00+02:00',
  'Legeaftale efter børnehaven',
);
const photo = personal('photo', 'Otto foto', '2026-08-27T09:00:00+02:00');
const parentMeeting = personal('meeting', 'Forældremøde Otto', '2026-08-27T17:00:00+02:00');
const gymnastics = personal('gymnastics', 'Alma gymnastik', '2026-08-28T16:00:00+02:00');
const childHome = personal(
  'child-home',
  'Almas ven med hjem',
  '2026-08-28T15:00:00+02:00',
  'Legeaftale med Alma',
);

const irrelevantKeys = [cryptic, glasses, friends, dentist, weekend, course].map(
  (item) => item.key,
);
const relevantKeys = [playdate, photo, parentMeeting, gymnastics, childHome].map(
  (item) => item.key,
);
const adultTitles = [glasses, friends, dentist, weekend, course].map((item) => item.title);

const photoPost = aulaSource({
  key: 'post:school-photo',
  title: 'Fotodag i 2.E',
  text: 'Mandag den 31. august 2026 er der skolefoto i 2.E. Alma skal møde i det tøj, hun skal fotograferes i.',
});
const consentThread = aulaSource({
  key: 'thread:trip-consent',
  kind: 'thread',
  title: 'Svar om turen',
  text: 'Kan I svare senest tirsdag den 25. august 2026, om Alma må deltage i klassens tur?',
  important: true,
});
const adultCourse = aulaSource({
  key: 'post:municipal-course',
  title: 'Kursus i kommunens nye intranet',
  text: 'Kommunen tilbyder et frivilligt aftenkursus for interesserede voksne. Kurset vedrører ikke børnene eller deres skoledag.',
  author: 'Eksempel Kommune',
  groups: ['Alle forældre i kommunen'],
  childNames: [],
  audience: 'municipal',
});

export const briefExtractionCases: BriefExtractionEvalCase[] = [
  {
    id: 'personal-calendar-relevance',
    description:
      'Child, school, playdate and activity appointments are included; cryptic and adult-only appointments are excluded.',
    provenance: 'user-labelled',
    input: input([
      cryptic,
      glasses,
      friends,
      dentist,
      weekend,
      course,
      playdate,
      photo,
      parentMeeting,
      gymnastics,
      childHome,
    ]),
    expected: {
      relevantPersonalEvents: relevantKeys,
      irrelevantPersonalEvents: irrelevantKeys,
      toplineNotContains: adultTitles,
      childSummariesNotContain: adultTitles,
    },
  },
  {
    id: 'aula-actions-and-noise',
    description:
      'Concrete child actions become source-grounded cards while an optional municipal adult course is hidden.',
    provenance: 'synthetic',
    input: input([photoPost, consentThread, adultCourse]),
    expected: {
      requiredCards: [
        {
          sourceKeys: [photoPost.key],
          needsAction: true,
          date: '2026-08-31',
          children: ['Alma'],
        },
        {
          sourceKeys: [consentThread.key],
          needsAction: true,
          date: '2026-08-25',
          children: ['Alma'],
        },
      ],
      hiddenIncludes: [adultCourse.key],
      hiddenExcludes: [photoPost.key, consentThread.key],
    },
  },
];
