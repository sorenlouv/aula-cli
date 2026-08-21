import type { AulaClient } from './client.ts';
import { UsageError } from './errors.ts';
import type { IntegrationContext } from './integrations/types.ts';
import { isoWeekString } from './integrations/types.ts';
import type { Child, Profile, ProfileContext } from './types.ts';
import { type DetectedWidget, detectWidgets } from './widgets.ts';

/**
 * The resolved id sets every other command needs.
 *
 * Getting these wrong is the main failure mode of this API, so it is worked out
 * once, here, and never re-derived at a call site.
 */
export type Family = {
  guardian: {
    profileId: number;
    userId: string;
    name: string;
    /** One institution-profile id per institution the guardian belongs to. */
    institutionProfileIds: number[];
  };
  children: Array<Child & { institutionName: string; institutionType?: string }>;
  institutions: Array<{
    institutionCode: string;
    institutionName: string;
    /** `'School'`, `'Daycare'`, … from `getProfileContext` — see integrations. */
    institutionType?: string;
    institutionProfileId: number;
    groups: Array<{ id: number; name: string }>;
  }>;
  /** posts.getAllPosts wants guardian ids **and** child ids. */
  postInstitutionProfileIds: number[];
  /** calendar + presence want child ids **only** (guardian ids cause a 403). */
  childInstitutionProfileIds: number[];
  /** The third-party widget APIs filter on institution *codes*, not ids. */
  institutionCodes: string[];
  /** Which vendor widgets these schools expose. See src/widgets.ts. */
  widgets: DetectedWidget[];
  /** True when the session was stepped up, which is required to read sensitive threads. */
  isSteppedUp: boolean;
  /** Present only if configured; Meebook and Systematic need it. */
  mitidUsername: string | undefined;
};

export async function resolveFamily(client: AulaClient): Promise<Family> {
  const [profiles, context] = await Promise.all([client.getProfiles(), client.getProfileContext()]);
  return buildFamily(profiles, context, client.mitidUsername);
}

/**
 * The id resolution on its own, separated from fetching so `doctor` can time
 * `getProfilesByLogin` and `getProfileContext` as the two distinct endpoint
 * checks they are, and still build a family from the results rather than
 * issuing both calls a second time.
 */
export function buildFamily(
  profiles: Profile[],
  context: ProfileContext,
  mitidUsername?: string,
): Family {
  const profile = profiles[0];
  if (!profile) throw new Error('Aula returned no profiles for this session.');

  const nameByCode = new Map<string, string>();
  for (const ip of profile.institutionProfiles ?? []) {
    if (ip.institutionName) nameByCode.set(ip.institutionCode, ip.institutionName);
  }
  for (const child of profile.children ?? []) {
    if (child.institutionName) nameByCode.set(child.institutionCode, child.institutionName);
  }

  // The institution *type* lives only on the context's institutions list, so
  // it is joined onto each child here — it is what keeps daycare children away
  // from the weekly-plan vendors.
  const typeByCode = new Map<string, string>();
  for (const inst of context.institutions ?? []) {
    if (inst.institutionType) typeByCode.set(inst.institutionCode, inst.institutionType);
  }

  const children = (profile.children ?? []).map((child) => {
    const institutionType = typeByCode.get(child.institutionCode);
    return {
      ...child,
      institutionName:
        child.institutionName ??
        child.institutionProfile?.institutionName ??
        nameByCode.get(child.institutionCode) ??
        child.institutionCode,
      ...(institutionType ? { institutionType } : {}),
    };
  });

  const guardianInstitutionProfileIds = (profile.institutionProfiles ?? []).map((ip) => ip.id);
  const childInstitutionProfileIds = children.map((c) => c.id);

  const institutions = (context.institutions ?? []).map((inst) => ({
    institutionCode: inst.institutionCode,
    institutionName: inst.institutionName ?? nameByCode.get(inst.institutionCode) ?? inst.institutionCode,
    ...(inst.institutionType ? { institutionType: inst.institutionType } : {}),
    institutionProfileId: inst.institutionProfileId,
    groups: (inst.groups ?? []).map((g) => ({ id: g.id, name: g.name })),
  }));

  // Institution codes can come from three places and a family split across two
  // schools may only have one of them populated in any given response.
  const institutionCodes = [
    ...new Set(
      [
        ...(profile.institutionProfiles ?? []).map((ip) => ip.institutionCode),
        ...children.map((c) => c.institutionCode),
        ...institutions.map((i) => i.institutionCode),
      ].filter((code): code is string => Boolean(code)),
    ),
  ];

  return {
    guardian: {
      profileId: profile.profileId,
      userId: context.userId,
      name: context.institutionProfile?.fullName ?? profile.displayName ?? 'unknown',
      institutionProfileIds: guardianInstitutionProfileIds,
    },
    children,
    institutions,
    postInstitutionProfileIds: [...guardianInstitutionProfileIds, ...childInstitutionProfileIds],
    childInstitutionProfileIds,
    institutionCodes,
    widgets: detectWidgets(context),
    isSteppedUp: Boolean(context.isSteppedUp),
    // Recorded by the MitID login on the stored token record — the one place
    // it exists, since no Aula endpoint ever reveals it.
    mitidUsername,
  };
}

/**
 * Resolves a user-supplied child reference — an id, a first name, or a
 * shortName like "HBLA" — to the matching children. Returns all children when
 * `ref` is undefined.
 */
export function selectChildren(family: Family, ref?: string): Family['children'] {
  if (!ref) return family.children;
  const needle = ref.trim().toLowerCase();
  const exactMatches = family.children.filter(
    (c) =>
      String(c.id) === needle ||
      String(c.profileId) === needle ||
      c.shortName?.toLowerCase() === needle ||
      c.name.toLowerCase() === needle,
  );
  if (exactMatches.length === 1) return exactMatches;

  const partialMatches = family.children.filter((c) => c.name.toLowerCase().includes(needle));
  if (partialMatches.length === 1) return partialMatches;

  const matches = exactMatches.length > 1 ? exactMatches : partialMatches;
  const describe = (children: Family['children']) =>
    children.map((c) => `${c.name} (${c.shortName ?? 'no short name'}, id ${c.id})`).join('; ');
  if (matches.length > 1) {
    throw new UsageError(`Child reference "${ref}" is ambiguous. Matches: ${describe(matches)}`);
  }
  throw new UsageError(`No child matches "${ref}". Known children: ${describe(family.children)}`);
}

/**
 * The `institutionProfileIds[]` a posts read should be filtered on, for some
 * subset of the children.
 *
 * `family.postInstitutionProfileIds` is this for *all* of them; `--child` needs
 * the same set narrowed. The guardian's own ids stay in either way, because
 * dropping them is what makes `posts.getAllPosts` return an empty list with
 * status 0 rather than an error.
 *
 * Aula offers no finer filter than this, so a guardian who has children at two
 * schools will still see posts addressed to them at the *other* school. That is
 * a limit of the endpoint, not of the narrowing — and over-reporting a post is
 * a great deal safer than silently dropping one.
 */
export function postIdsFor(family: Family, children: Family['children']): number[] {
  return [...family.guardian.institutionProfileIds, ...children.map((c) => c.id)];
}

/**
 * Everything the vendor integrations need, assembled from the family.
 *
 * The interesting part is `sessionId`. Aula's own guardian id (`userId`) is
 * what MinUddannelse and EasyIQ expect, but Meebook and Systematic identify
 * the session by the MitID username instead — a value that exists nowhere in
 * the API, because it is what the human types into MitID. When it has not been
 * configured we fall back to the guardian id and say so, so a rejection reads
 * as a missing setting rather than a broken integration.
 */
export function integrationContext(
  family: Family,
  opts: {
    children?: Family['children'];
    isoWeek?: string;
    fromDate?: string;
    toDate?: string;
  } = {},
): IntegrationContext {
  const children = opts.children ?? family.children;
  return {
    isoWeek: opts.isoWeek ?? isoWeekString(),
    guardianId: String(family.guardian.userId),
    sessionId: family.mitidUsername ?? String(family.guardian.userId),
    sessionIdIsFallback: family.mitidUsername === undefined,
    children: children.map((child) => ({
      id: child.id,
      name: child.name,
      userId: child.userId === undefined || child.userId === null ? '' : String(child.userId),
      ...(child.institutionType ? { institutionType: child.institutionType } : {}),
    })),
    institutionCodes: family.institutionCodes,
    ...(opts.fromDate ? { fromDate: opts.fromDate } : {}),
    ...(opts.toDate ? { toDate: opts.toDate } : {}),
  };
}
