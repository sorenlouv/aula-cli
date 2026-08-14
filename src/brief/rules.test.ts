import { describe, expect, test } from 'bun:test';
import { extractDates, extractHits, splitSentences, urgencyFor } from './rules.ts';

// Thursday 13 August 2026 — the fixed reference day relative dates resolve against.
const TODAY = new Date(2026, 7, 13);

describe('splitSentences', () => {
  test('does not break on Danish abbreviations or clock times', () => {
    expect(splitSentences('Mødet er fredag d. 18 sep kl 13-14 på skolens kontor.')).toEqual([
      'Mødet er fredag d. 18 sep kl 13-14 på skolens kontor.',
    ]);
    expect(splitSentences('Vi var klar kl. 9.30. Så løb vi.')).toEqual([
      'Vi var klar kl. 9.30.',
      'Så løb vi.',
    ]);
  });

  test('treats newlines as sentence ends', () => {
    expect(splitSentences('Kære forældre\n\nAnsøgningsfristen er 1. september')).toEqual([
      'Kære forældre',
      'Ansøgningsfristen er 1. september',
    ]);
  });
});

describe('extractDates', () => {
  test('named months, with and without a year', () => {
    expect(extractDates('Ansøgningsfristen er tirsdag den 1. september 2026.', TODAY)).toEqual([
      '2026-09-01',
    ]);
    expect(extractDates('Der afholdes informationsaften mandag d. 24. august', TODAY)).toEqual([
      '2026-08-24',
    ]);
  });

  test('abbreviated months — the 18 sep case that carries the real meeting', () => {
    expect(extractDates('Mødet er fredag d. 18 sep kl 13-14', TODAY)).toEqual(['2026-09-18']);
  });

  test('slashed dates from a subject line', () => {
    expect(extractDates('Møde ang. Alma d. 18/9', TODAY)).toEqual(['2026-09-18']);
  });

  test('dotted day.month, but not a clock time', () => {
    expect(extractDates('Vores første møde efter sommerferien den 17.9', TODAY)).toEqual([
      '2026-09-17',
    ]);
    expect(extractDates('Vi var alle klar kl 9.30 og løb afsted', TODAY)).toEqual([]);
    expect(extractDates('kl. 17.30-19.00 i idrætshallen', TODAY)).toEqual([]);
  });

  test('relative days and weekdays', () => {
    expect(extractDates('I dag har vi idræt', TODAY)).toEqual(['2026-08-13']);
    expect(extractDates('I morgen tager vi hul på løbedagen', TODAY)).toEqual(['2026-08-14']);
    expect(extractDates('Vi gør det fast om mandagen', TODAY)).toEqual(['2026-08-17']);
  });

  test('both dates in a sentence that pairs an event with its deadline', () => {
    const sentence =
      'Informationsaftenen afholdes tirsdag den 25. august 2026 og ansøgningsfristen er 1. september 2026.';
    expect(extractDates(sentence, TODAY)).toEqual(['2026-08-25', '2026-09-01']);
  });

  test('a day/month already well past rolls to next year', () => {
    // Written in August, "d. 3/2" means next February, not six months ago.
    expect(extractDates('Vi mødes d. 3/2', TODAY)).toEqual(['2027-02-03']);
    // But last week stays in the past rather than jumping a year.
    expect(extractDates('Vi mødtes d. 11/8', TODAY)).toEqual(['2026-08-11']);
  });

  test('rejects impossible dates', () => {
    expect(extractDates('Sag nr. 45/99 er afsluttet', TODAY)).toEqual([]);
  });
});

describe('extractHits', () => {
  test('a PE kit reminder from a weekly plan', () => {
    const text =
      'I dag har vi vores første idrætstime sammen. Vi skal være i hallen. Husk skiftetøj og badeting til efter timen.';
    const hits = extractHits(text, TODAY);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('bring');
    expect(hits[0]?.quote).toBe('Husk skiftetøj og badeting til efter timen.');
  });

  test('the running-day post, where verb and particle are far apart', () => {
    const text =
      'I morgen holder vi løbedag, og børnene må meget gerne have løbetøj og sko med, de kan løbe i! 🏃';
    const hits = extractHits(text, TODAY);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe('bring');
    expect(hits[0]?.dueAt).toBe('2026-08-14');
  });

  test('an application deadline', () => {
    const hits = extractHits('Ansøgningsfristen er tirsdag den 1. september 2026.', TODAY);
    expect(hits[0]?.kind).toBe('deadline');
    expect(hits[0]?.dueAt).toBe('2026-09-01');
    expect(hits[0]?.urgency).toBe('later');
  });

  test('a meeting keeps its date', () => {
    const hits = extractHits('Mødet er fredag d. 18 sep kl 13-14 på skolens kontor.', TODAY);
    expect(hits[0]?.kind).toBe('event');
    expect(hits[0]?.dueAt).toBe('2026-09-18');
  });

  test('a date with no obligation marker is not an obligation', () => {
    // Describing the past. Treating every date as a commitment is what makes
    // these summaries noisy.
    expect(extractHits('Vi var alle klar kl 9:30 og løb gennem skoven.', TODAY)).toEqual([]);
  });

  test('every quote is a literal substring of the source', () => {
    const text =
      'Kære alle.\n\nI morgen tager vi hul på vores ugentlige løbedag. I morgen må børnene meget gerne have løbetøj og sko med!';
    for (const hit of extractHits(text, TODAY)) {
      expect(text).toContain(hit.quote);
    }
  });
});

describe('urgencyFor', () => {
  test('maps distance to urgency, keeping the past visible', () => {
    expect(urgencyFor('2026-08-13', TODAY, 'week')).toBe('now');
    expect(urgencyFor('2026-08-17', TODAY, 'later')).toBe('week');
    expect(urgencyFor('2026-09-18', TODAY, 'week')).toBe('later');
    expect(urgencyFor('2026-08-01', TODAY, 'week')).toBe('fyi');
    expect(urgencyFor(null, TODAY, 'later')).toBe('later');
  });
});
