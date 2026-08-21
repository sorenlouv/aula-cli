import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors.ts';
import { selectChildren, type Family } from './family.ts';

const family: Family = {
  guardian: { profileId: 1, userId: 'guardian', name: 'Guardian', institutionProfileIds: [10] },
  children: [
    {
      id: 20,
      profileId: 200,
      name: 'Alma Andersen',
      shortName: 'ALMA',
      institutionCode: 'school',
      institutionName: 'School',
    },
    {
      id: 21,
      profileId: 201,
      name: 'Alma Bertelsen',
      shortName: 'ALMB',
      institutionCode: 'school',
      institutionName: 'School',
    },
    {
      id: 22,
      profileId: 202,
      name: 'Viggo Andersen',
      shortName: 'VIGG',
      institutionCode: 'school',
      institutionName: 'School',
    },
  ],
  institutions: [],
  postInstitutionProfileIds: [10, 20, 21, 22],
  childInstitutionProfileIds: [20, 21, 22],
  institutionCodes: ['school'],
  widgets: [],
  isSteppedUp: true,
  mitidUsername: undefined,
};

describe('selectChildren', () => {
  test('returns all children only when no selector was supplied', () => {
    expect(selectChildren(family)).toEqual(family.children);
  });

  test('resolves ids, profile ids, short names and full names exactly', () => {
    expect(selectChildren(family, '20')[0]?.name).toBe('Alma Andersen');
    expect(selectChildren(family, '201')[0]?.name).toBe('Alma Bertelsen');
    expect(selectChildren(family, 'vigg')[0]?.name).toBe('Viggo Andersen');
    expect(selectChildren(family, 'ALMA ANDERSEN')[0]?.id).toBe(20);
  });

  test('allows a unique partial name', () => {
    expect(selectChildren(family, 'Viggo')[0]?.id).toBe(22);
  });

  test('refuses an ambiguous partial name instead of selecting several children', () => {
    expect(() => selectChildren(family, 'Andersen')).toThrow(UsageError);
    expect(() => selectChildren(family, 'Andersen')).toThrow(/ambiguous.*Alma Andersen.*Viggo Andersen/i);
  });

  test('reports the known children when nothing matches', () => {
    expect(() => selectChildren(family, 'Freja')).toThrow(/No child matches.*Known children/);
  });
});
