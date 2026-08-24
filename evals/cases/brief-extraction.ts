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

function input(
  items: SourceItem[],
  opts: {
    windowDays?: number;
    preferences?: string[];
    today?: string;
    isoWeek?: string;
  } = {},
): BriefInput {
  return {
    today: opts.today ?? '2026-08-23',
    isoWeek: opts.isoWeek ?? '2026-W34',
    windowDays: opts.windowDays ?? 60,
    family: { children, isSteppedUp: true },
    items,
    health: [],
    albums: [],
    preferences: opts.preferences ?? [],
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
const runningRoutine = aulaSource({
  key: 'post:weekly-running',
  title: 'Fast løbedag',
  text: 'Sommerfuglene har fast løbedag hver mandag. Husk at sende Otto i tøj og sko, der er rare at løbe i.',
  at: '2026-08-10T09:00:00+02:00',
  groups: ['Sommerfuglene'],
  childNames: ['Otto Eksempelsen'],
  audience: 'class',
});

const weekReply = aulaSource({
  key: 'post:week-reply',
  title: 'Svar om efterårsaktiviteter',
  text: 'Husk at svare på tilmeldingen i uge 41, så Alma kan komme med.',
});
const oldCampAnnouncement = aulaSource({
  key: 'post:camp-announcement',
  title: 'Lejrskole i september',
  text: 'Lejrskolen for 2.E afholdes onsdag den 30. september 2026. Husk sovepose.',
  at: '2026-07-03T09:00:00+02:00',
});
const campReminder = aulaSource({
  key: 'thread:camp-reminder',
  kind: 'thread',
  title: 'Husk lejrskolen',
  text: 'Dette er en påmindelse om lejrskolen den 30. september 2026. Alma skal have sovepose med.',
  important: true,
});
const twoObligations = aulaSource({
  key: 'post:two-obligations',
  title: 'Turdag mandag',
  text: 'Husk badetøj på mandag den 31. august 2026. Husk også madpakke på mandag den 31. august 2026.',
});
const photoRegistration = aulaSource({
  key: 'post:photo-registration',
  title: 'Skolefoto - uge 35',
  text: 'Fotografen er på Eksempelskolen 24.-28. august 2026. Tilmeld Alma til skolefoto med koden Eksempel26.',
  at: '2026-08-13T09:00:00+02:00',
  groups: ['Alle på Eksempelskolen'],
  childNames: [],
  audience: 'institution',
  important: true,
});
const photoDayMessage = aulaSource({
  key: 'thread:photo-day',
  kind: 'thread',
  title: 'Fotografering på tirsdag',
  text: 'På tirsdag den 25. august 2026 er det fotodag i 2.E. Alma skal have fint tøj på og håret redt.',
  at: '2026-08-20T09:00:00+02:00',
  important: true,
});
const photoDayPlan = aulaSource({
  key: 'plan:weekly-photo-day',
  kind: 'plan',
  title: '2.E',
  text: 'Vi skal fotograferes i dag. Husk pænt tøj og redt hår.',
  at: '2026-08-25T08:00:00+02:00',
  important: true,
});
const libraryReturnPlan = aulaSource({
  key: 'plan:weekly-library-return',
  kind: 'plan',
  title: 'Dansk / 2.E',
  text: 'Vi får læsevejleder til hjælp i første lektion. Husk gamle biblioteksbøger til aflevering. Vi arbejder videre i danskbog 2.',
  at: '2026-08-25T08:00:00+02:00',
  important: true,
});
const broadPhotoAction = aulaSource({
  key: 'post:broad-photo-action',
  title: 'Skolefoto for hele skolen',
  text: 'Alle elever fotograferes. Tilmeld Alma og betal senest tirsdag den 1. september 2026.',
  groups: ['Alle på Eksempelskolen'],
  audience: 'institution',
  important: true,
});
const fatherMessage = aulaSource({
  key: 'thread:father-message',
  kind: 'thread',
  title: 'Besked fra Hjaltes far',
  text: 'Hjalte vil gerne lege med Alma efter skole en dag.',
  author: 'John, Hjaltes far',
});
const municipalNewsletter = aulaSource({
  key: 'post:municipal-newsletter',
  title: 'Kommunalt nyhedsbrev',
  text: 'Generelle nyheder fra forvaltningen uden betydning for børnenes dag.',
  groups: ['Alle forældre i kommunen'],
  childNames: [],
  audience: 'municipal',
});
const ongoingChange = aulaSource({
  key: 'post:ongoing-change',
  title: 'Ny fast mødetid',
  text: 'Fra lørdag den 1. august 2026 er den faste mødetid for 2.E kl. 08.00 hver dag.',
  at: '2026-07-31T09:00:00+02:00',
});
const partialThread = aulaSource({
  key: 'thread:partial-visible-action',
  kind: 'thread',
  title: 'Svar om mødet',
  text: 'Lærer: Kan I svare senest tirsdag den 25. august 2026, om Alma deltager?',
  important: true,
  conversation: {
    messages: [
      {
        from: 'Eksempel Lærer',
        at: '2026-08-21T09:00:00+02:00',
        text: 'Kan I svare senest tirsdag den 25. august 2026, om Alma deltager?',
      },
    ],
    total: 3,
    truncated: true,
  },
});
const longTailAction = aulaSource({
  key: 'post:long-tail-action',
  title: 'Lang orientering om klassens tur',
  text: `${'Baggrund om turen og undervisningen. '.repeat(260)}Husk at aflevere Almas samtykke senest fredag den 28. august 2026.`,
});
const schoolDentistTime = aulaSource({
  key: 'event:school-dentist-time',
  kind: 'event',
  title: 'Skolebibliotek med Alma',
  text: 'Skolebibliotek med Alma onsdag den 26. august 2026 kl. 13.30.',
  at: '2026-08-26T13:30:00+02:00',
});
const almaDentist = personal(
  'alma-dentist',
  'Alma tandlæge',
  '2026-08-26T13:30:00+02:00',
  'Almas tandlægetid',
);

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
  {
    id: 'iso-week-deadline',
    description: 'A Danish week-number obligation becomes a grounded card on that ISO week Monday.',
    provenance: 'synthetic',
    input: input([weekReply]),
    expected: {
      requiredCards: [
        { sourceKeys: [weekReply.key], needsAction: true, date: '2026-10-05', children: ['Alma'] },
      ],
    },
  },
  {
    id: 'old-announcement-merged-with-reminder',
    description:
      'A 60-day-old announcement and current reminder are merged without losing the original date.',
    provenance: 'synthetic',
    input: input([oldCampAnnouncement, campReminder], { windowDays: 60 }),
    expected: {
      requiredCards: [
        {
          sourceKeys: [oldCampAnnouncement.key, campReminder.key],
          needsAction: true,
          date: '2026-09-30',
          children: ['Alma'],
        },
      ],
    },
  },
  {
    id: 'same-day-distinct-obligations',
    description: 'Two different things to bring on the same day remain separately visible.',
    provenance: 'synthetic',
    input: input([twoObligations]),
    expected: {
      requiredCards: [
        {
          sourceKeys: [twoObligations.key],
          needsAction: true,
          date: '2026-08-31',
          textContains: 'badetøj',
        },
        {
          sourceKeys: [twoObligations.key],
          needsAction: true,
          date: '2026-08-31',
          textContains: 'madpakke',
        },
      ],
    },
  },
  {
    id: 'school-photo-library-reminder',
    description:
      'A library-return reminder in a neighbouring weekly-plan item becomes its own visible action instead of being nested under school photo.',
    provenance: 'user-labelled',
    input: input([photoRegistration, photoDayMessage, photoDayPlan, libraryReturnPlan], {
      today: '2026-08-24',
      isoWeek: '2026-W35',
    }),
    expected: {
      requiredCards: [
        {
          sourceKeys: [photoDayMessage.key],
          excludedSourceKeys: [libraryReturnPlan.key],
          needsAction: true,
          date: '2026-08-25',
          children: ['Alma'],
          textContains: 'foto',
          textNotContains: ['bibliotek'],
          maxRank: 12,
        },
        {
          sourceKeys: [libraryReturnPlan.key],
          sourceKeysExactly: true,
          needsAction: true,
          date: '2026-08-25',
          children: ['Alma'],
          titleContains: 'bibliotek',
          textNotContains: ['foto'],
          maxRank: 12,
        },
      ],
      hiddenExcludes: [
        photoRegistration.key,
        photoDayMessage.key,
        photoDayPlan.key,
        libraryReturnPlan.key,
      ],
    },
  },
  {
    id: 'broad-important-child-action',
    description:
      'A school-wide source remains signal when it contains a concrete action for the child.',
    provenance: 'synthetic',
    input: input([broadPhotoAction]),
    expected: {
      requiredCards: [
        {
          sourceKeys: [broadPhotoAction.key],
          needsAction: true,
          date: '2026-09-01',
          children: ['Alma'],
        },
      ],
      hiddenExcludes: [broadPhotoAction.key],
    },
  },
  {
    id: 'parent-preferences',
    description: 'Explicit always/never preferences affect relevance without loosening grounding.',
    provenance: 'user-labelled',
    input: input([fatherMessage, municipalNewsletter], {
      preferences: [
        'Beskeder fra John, Hjaltes far, er altid relevante.',
        'Kommunale nyhedsbreve er aldrig relevante.',
      ],
    }),
    expected: {
      requiredCards: [{ sourceKeys: [fatherMessage.key], date: null }],
      hiddenIncludes: [municipalNewsletter.key],
      hiddenExcludes: [fatherMessage.key],
    },
  },
  {
    id: 'past-ongoing-change',
    description:
      'A past date remains visible when the source establishes an ongoing changed routine.',
    provenance: 'synthetic',
    input: input([ongoingChange]),
    expected: {
      requiredCards: [
        {
          sourceKeys: [ongoingChange.key],
          needsAction: false,
          date: '2026-08-01',
          children: ['Alma'],
        },
      ],
    },
  },
  {
    id: 'partial-thread-visible-evidence',
    description:
      'A partial thread may yield a card from visible evidence without inventing missing content.',
    provenance: 'synthetic',
    input: input([partialThread]),
    expected: {
      requiredCards: [
        {
          sourceKeys: [partialThread.key],
          needsAction: true,
          date: '2026-08-25',
          children: ['Alma'],
        },
      ],
    },
  },
  {
    id: 'long-tail-obligation',
    description: 'An obligation beyond the old head-only prompt boundary remains extractable.',
    provenance: 'synthetic',
    input: input([longTailAction]),
    expected: {
      requiredCards: [
        {
          sourceKeys: [longTailAction.key],
          needsAction: true,
          date: '2026-08-28',
          children: ['Alma'],
        },
      ],
    },
  },
  {
    id: 'calendar-no-clash-analysis',
    description:
      'A relevant child appointment is shown beside Aula without conflict or reassurance claims.',
    provenance: 'user-labelled',
    input: input([schoolDentistTime, almaDentist]),
    expected: {
      relevantPersonalEvents: [almaDentist.key],
      toplineNotContains: ['konflikt', 'kolliderer', 'sammenfald'],
      childSummariesNotContain: ['konflikt', 'kolliderer', 'sammenfald'],
    },
  },
  {
    id: 'recurring-aula-routine',
    description:
      'A weekly Aula routine without a one-off date is dated to today when the brief runs on that weekday.',
    provenance: 'user-labelled',
    input: input([runningRoutine], { today: '2026-08-24', isoWeek: '2026-W35' }),
    expected: {
      requiredCards: [
        {
          sourceKeys: [runningRoutine.key],
          needsAction: true,
          date: '2026-08-24',
          recurring: true,
          children: ['Otto'],
        },
      ],
      hiddenExcludes: [runningRoutine.key],
    },
  },
];
