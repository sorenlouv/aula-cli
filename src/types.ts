/** Shapes returned by the Aula API. Only the fields we actually consume are typed. */

export type ProfilePicture = { url?: string | null } | null;

/**
 * Aula has two overlapping id spaces and mixing them up is the single easiest
 * way to get a 403 out of this API:
 *
 *   - `profileId` identifies the *person* across all institutions.
 *   - `id` identifies that person *at one institution* ("institution profile").
 *
 * Almost every endpoint wants the institution-profile `id`.
 */
export type InstitutionProfile = {
  id: number;
  profileId: number;
  name?: string;
  shortName?: string;
  role?: string;
  institutionCode: string;
  institutionName?: string;
  profilePicture?: ProfilePicture;
};

export type Child = {
  id: number;
  profileId: number;
  name: string;
  shortName?: string;
  institutionCode: string;
  institutionName?: string;
  mainGroupName?: string;
  /**
   * A *third* id space, distinct from both `id` and `profileId`: an opaque
   * per-child token (UniLogin-ish, e.g. `"alma0101"`). None of the Aula
   * endpoints want it, but every third-party widget does — Meebook rejects
   * the numeric id outright, and EasyIQ SkolePortal keys `x-childfilter` on
   * this. See src/integrations/.
   */
  userId?: string | number;
  /** Present in some responses; `metadata` is the class name, e.g. "2BA". */
  institutionProfile?: {
    id?: number;
    institutionCode?: string;
    institutionName?: string;
    metadata?: string;
  } | null;
};

export type Profile = {
  profileId: number;
  displayName?: string;
  name?: string;
  institutionProfiles: InstitutionProfile[];
  children: Child[];
};

/**
 * One entry of `pageConfiguration.widgetConfigurations`. This is how Aula
 * tells you which third-party products a school has bought — the widget id
 * selects the provider (see src/widgets.ts).
 */
export type WidgetConfiguration = {
  /** Current shape. */
  widget?: {
    widgetId?: string;
    name?: string;
    widgetVersion?: string;
    description?: string;
  } | null;
  /** Older flat shape, still seen at some institutions. */
  widgetId?: string;
  institutionCode?: string;
  placement?: string;
  restrictedGroups?: unknown[];
};

export type ProfileContext = {
  id: number;
  userId: string;
  portalRole: string;
  isSteppedUp: boolean;
  institutionProfile: {
    id: number;
    profileId: number;
    fullName?: string;
    shortName?: string;
    institutionCode?: string;
  };
  institutions: Array<{
    institutionCode: string;
    institutionName?: string;
    /** Aula's label: `'School'`, `'Daycare'`, … Decides who has weekly plans. */
    institutionType?: string;
    institutionProfileId: number;
    groups?: Array<{ id: number; name: string }>;
  }>;
  pageConfiguration?: {
    widgetConfigurations?: WidgetConfiguration[];
  } | null;
};

export type MessageText = { html?: string | null } | null;

export type MailBoxOwner = {
  id?: number;
  profileId?: number;
  portalRole?: string;
  mailBoxOwnerType?: string;
};

export type Sender = {
  fullName?: string;
  shortName?: string;
  institutionCode?: string;
  mailBoxOwner?: MailBoxOwner;
};

export type Message = {
  id: string;
  sendDateTime: string;
  deletedAt?: string | null;
  text?: MessageText;
  hasAttachments?: boolean;
  messageType?: string;
  sender?: Sender | null;
  attachments?: Attachment[];
  leaverNames?: string | null;
  inviterName?: string | null;
};

export type Attachment = {
  id?: number;
  name?: string;
  file?: { name?: string; url?: string } | null;
  media?: { name?: string; url?: string } | null;
  link?: { name?: string; url?: string } | null;
};

export type ThreadSummary = {
  id: number;
  subject?: string | null;
  read: boolean;
  sensitive: boolean;
  muted?: boolean;
  marked?: boolean;
  startedTime?: string;
  institutionCode?: string;
  extraRecipientsCount?: number;
  latestMessage?: { id?: string; sendDateTime?: string; text?: MessageText } | null;
  regardingChildren?: Array<{ profileId: number; displayName?: string; shortName?: string }>;
  creator?: { fullName?: string; mailBoxOwner?: MailBoxOwner } | null;
  recipients?: Array<{ fullName?: string; mailBoxOwner?: MailBoxOwner }>;
};

export type ThreadList = {
  threads: ThreadSummary[];
  moreMessagesExist: boolean;
  page: number;
};

export type ThreadDetail = {
  id: number;
  subject?: string | null;
  sensitive: boolean;
  messages: Message[];
  totalMessageCount?: number;
  moreMessagesExist?: boolean;
  page?: number;
  recipients?: Array<{ fullName?: string; mailBoxOwner?: MailBoxOwner }>;
  threadStartedDateTime?: string;
};

export type Post = {
  id: number;
  title?: string | null;
  content?: { html?: string | null } | null;
  timestamp?: string;
  publishAt?: string;
  expireAt?: string | null;
  isExpired?: boolean;
  isImportant?: boolean;
  importantFrom?: string | null;
  importantTo?: string | null;
  ownerProfile?: { fullName?: string; institutionCode?: string } | null;
  sharedWithGroups?: Array<{ id?: number; name?: string; institutionCode?: string }>;
  attachments?: Attachment[];
  commentCount?: number;
  isBookmarked?: boolean;
};

export type PostList = {
  posts: Post[];
  hasMorePosts: boolean;
  profileLastSeenPostDate?: string;
};

/**
 * A photo album.
 *
 * `id` is nullable because the first row Aula returns is not an album at all:
 * it is a synthetic "Medier af dig og dine børn" bucket collecting media your
 * children are tagged in. It has no id, no creator and no groups, and must be
 * dropped before the list means anything.
 *
 * Note what is *absent*: `mediaCreatedAt`. Aula sorts on it — it is the only
 * sensible `sortOn` value — but never returns it, so the array arrives in an
 * order the payload cannot explain. `creationDate` is the only date here.
 */
export type Album = {
  id?: number | null;
  title?: string | null;
  description?: string | null;
  creationDate?: string;
  creator?: {
    id?: number;
    name?: string;
    institutionCode?: string;
    institutionName?: string;
    metadata?: string;
  } | null;
  sharedWithGroups?: Array<{ id?: number; name?: string; institutionName?: string }>;
  /**
   * Signed, short-lived CloudFront URLs — and a *cover preview*, not the album
   * contents. Real albums return exactly one however many photos they hold, so
   * this length is not a media count. `gallery.getMedia` has the real one.
   */
  thumbnailsUrls?: string[];
  regardingInstitutionProfileId?: number | null;
};

export type CalendarEvent = {
  id: number;
  title?: string | null;
  allDay?: boolean;
  startDateTime: string;
  endDateTime?: string;
  type?: string;
  responseRequired?: boolean;
  responseStatus?: string | null;
  responseDeadline?: string | null;
  requiresNewAnswer?: boolean;
  creatorName?: string | null;
  primaryResourceText?: string | null;
  institutionCode?: string;
  institutionName?: string;
  belongsToProfiles?: number[];
  repeating?: unknown;
  lesson?: unknown;
};

export type PresenceEntry = {
  id: number;
  institutionProfile?: InstitutionProfile;
  status?: number | string;
  location?: { name?: string } | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  entryTime?: string | null;
  exitTime?: string | null;
  exitWith?: string | null;
  comment?: string | null;
  vacationNote?: string | null;
  sleepIntervals?: unknown[];
  activityType?: number | string | null;
};

/**
 * One entry in "Fælles Filer" — the shared-file shelf each institution keeps for
 * documents that are not tied to a message or post: holiday plans, class
 * timetables, policies.
 *
 * The double `file.file` nesting is Aula's, not a typo: the outer object is the
 * attachment record, the inner one is the stored blob carrying the presigned
 * URL.
 */
export type CommonFile = {
  id: number;
  title?: string | null;
  created?: string;
  isDataPolicy?: boolean;
  institution?: { institutionCode?: string; institutionName?: string } | null;
  groupRestrictions?: Array<{ id?: number; name?: string }>;
  profileTypeRestrictions?: string[];
  file?: {
    id?: number;
    name?: string;
    /** "available" once the virus scan has cleared it. */
    status?: string;
    creator?: { name?: string; institutionCode?: string; institutionName?: string } | null;
    file?: { id?: number; name?: string; url?: string } | null;
  } | null;
};

export type CommonFileList = {
  commonFiles: CommonFile[];
  totalAmount: number;
};

export type Notification = {
  notificationId: string;
  notificationEventType?: string;
  notificationArea?: string;
  notificationType?: string;
  institutionCode?: string;
  institutionProfileId?: number;
  relatedChildName?: string | null;
  triggered?: string;
  expires?: string;
  threadId?: number;
  postId?: number;
  albumId?: number;
  mediaId?: number;
};

/**
 * `groups.getGroupsByContext` — one entry per child, listing the groups that
 * child belongs to. The child's *class* is the group whose `name` equals the
 * child's `institutionProfile.metadata`; the rest are subject teams, year
 * groups and similar.
 */
export type GroupContext = {
  profileId: number;
  institutionProfileId?: number;
  institutionCode?: string;
  groups?: Array<{
    id: number;
    name: string;
    shortName?: string;
    institutionCode?: string;
    mainGroup?: boolean;
    /** Group type, e.g. "Klasse" / "Hold". */
    type?: string;
  }>;
};

/**
 * `profiles.getContactlist` — the class contact list ("kontaktliste").
 *
 * Which fields are populated depends on what each family chose to share, so
 * everything past the identity is optional. The index signature keeps the
 * unmodelled fields reachable in the raw JSON output rather than dropping
 * them on the floor.
 */
export type Contact = {
  profileId?: number;
  institutionProfileId?: number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  shortName?: string;
  /** "child" | "guardian" | "employee". */
  role?: string;
  /** `YYYY-MM-DD`, and only for children whose guardians share it. */
  birthday?: string | null;
  institutionCode?: string;
  institutionName?: string;
  mainGroupName?: string;
  metadata?: string;
  address?: { street?: string; postalCode?: string; postalDistrict?: string } | null;
  email?: string | null;
  mobilePhone?: string | null;
  homePhone?: string | null;
  /** A child's guardians, or a guardian's children. */
  relations?: Array<{ profileId?: number; name?: string; role?: string }>;
  [key: string]: unknown;
};

/**
 * `presence.getPresenceTemplates` — the recurring "komme/gå" registrations:
 * the drop-off and pickup times a guardian has entered per weekday.
 *
 * Distinct from `presence.getDailyOverview`, which is what actually happened
 * today. This is the plan; that is the fact.
 */
export type PresenceDayTemplate = {
  date?: string;
  /** 1 = Monday … 7 = Sunday. */
  dayOfWeek?: number;
  entryTime?: string | null;
  exitTime?: string | null;
  comment?: string | null;
  /** See PRESENCE_ACTIVITY_TYPES in cli-helpers.ts. */
  activityType?: number | null;
  pickup?: { entryTime?: string | null; exitTime?: string | null; exitWith?: string | null } | null;
  selfDecider?: {
    entryTime?: string | null;
    exitStartTime?: string | null;
    exitEndTime?: string | null;
  } | null;
  sendHome?: { entryTime?: string | null; exitTime?: string | null } | null;
  goHomeWith?: {
    entryTime?: string | null;
    exitTime?: string | null;
    exitWith?: string | null;
  } | null;
  [key: string]: unknown;
};

export type PresenceWeekTemplate = {
  /** Carries the institution-profile id the template belongs to. */
  institutionProfile?: { id: number; name?: string; institutionName?: string } | null;
  dayTemplates?: PresenceDayTemplate[];
  [key: string]: unknown;
};

export type PresenceTemplates = {
  presenceWeekTemplates?: PresenceWeekTemplate[];
  [key: string]: unknown;
};
