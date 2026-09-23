/**
 * What the brief page, the CLI and the Worker agree on.
 *
 * Its own module so each side can import it without the others: the Worker
 * once took `KEEP_DAYS` from `brief/done.ts` and shipped the whole page script
 * inside its bundle as dead code, because esbuild cannot prove a template
 * literal with a substitution free of side effects.
 */

/** Where the CLI uploads the page, with a service token. */
export const BRIEF_PATH = '/api/brief';

/**
 * The largest page the Worker stores: SQLite in a Durable Object holds at most
 * 2 MB in one row. A brief is around 90 KB.
 */
export const MAX_PAGE_BYTES = 2_000_000;

/** Where the page reads and writes ticks, on its own origin. */
export const DONE_PATH = '/api/done';

/**
 * How long a tick is kept, in days — by the page's own cache and by the Worker.
 *
 * Long enough that a fortnight's window can never outlive a tick, short enough
 * that the store cannot grow forever. Nothing depends on the exact number: an
 * entry that expires early re-shows an item, which is the safe direction to
 * fail in.
 */
export const KEEP_DAYS = 45;
