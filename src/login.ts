/**
 * `login` / `logout` / `status` / `refresh-stepup`.
 *
 * These are the only commands that write anything anywhere — encrypted tokens,
 * cookies and the MitID username, all under `~/.aula`. Nothing here writes to
 * Aula; the login handshake creates a session, it does not touch school data.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { stderr } from 'node:process';
import {
  AULA_DIR,
  COOKIE_JAR_PATH,
  KEY_ENV,
  TOKEN_PATH,
  clearCookieJar,
  loadFreshTokens,
  saveCookieJar,
  tokenStore,
} from './auth.ts';
import { clearCache } from './cache.ts';
import { UsageError } from './errors.ts';
import { fail, fmt, info, ok, openInBrowser, warn } from './io.ts';
import type { LoginPage } from './login-page.ts';
import { errorMessage } from './validation.ts';
import {
  AulaHttpClient,
  AulaLoginClient,
  AulaSilentSsoFailedError,
  JsonlFileTracer,
  MitidIdentityNotFoundError,
  MitidParallelSessionError,
  silentLogger,
  stderrLogger,
} from './vendor/aula-auth/index.ts';
import type { IdentityOption, Logger, StoredTokenRecord } from './vendor/aula-auth/index.ts';
import { cmd } from './runtime.ts';

export type LoginArgs = {
  debug?: boolean;
  /**
   * Print the page's address but do not spawn a browser at it.
   *
   * Not a second login surface — the page is still the only one, and the URL is
   * printed either way. It exists because spawning a browser is the one thing
   * `login` does that a test cannot tolerate: without this, asserting that the
   * page comes up before MitID is contacted means opening a real window on
   * whoever runs `bun test`. Also the honest answer on a machine with no
   * browser to open.
   */
  noOpen?: boolean;
};

/**
 * How long the identity picker may sit unanswered.
 *
 * The username wait above it has no ceiling, and the difference is the point:
 * this is the only wait with a real deadline on the other side of it. By now a
 * MitID session is live and expiring, and we are blocked inside MitID's own
 * `selectIdentity` callback — polling nothing, noticing nothing. Without a
 * ceiling, a session that dies while the user is deciding leaves `login`
 * waiting on a corpse for as long as the process lives. Two minutes is a
 * generous allowance for what is one click on a page already in front of them.
 */
const IDENTITY_WAIT_MS = 2 * 60_000;

/**
 * How many usernames one `login` will accept before giving up.
 *
 * Enough for a typo and a second thought; few enough that a user who does not
 * know their MitID username is sent to find it rather than guessing at it.
 */
const MAX_USERNAME_ATTEMPTS = 3;

/**
 * A wait this process ended itself, carrying both halves of the explanation.
 *
 * The two surfaces have different readers: stderr is read by whatever is
 * driving the CLI, the page by the parent. Same event, two languages, so the
 * Danish half travels with the error rather than being reconstructed in the
 * catch.
 */
class LoginWaitExpired extends Error {
  override readonly name = 'LoginWaitExpired';
  constructor(
    message: string,
    readonly pageMessage: string,
  ) {
    super(message);
  }
}

/**
 * Answers from the page, with a ceiling.
 *
 * Only for waits that have a deadline on the other side of them — see
 * `IDENTITY_WAIT_MS`, currently the only one. A ceiling on a wait that nothing
 * is expiring behind would be a deadline we invented, and inventing one here is
 * strictly harmful: `login` is already run under a timeout by whatever drives
 * it, so a second, tighter timer underneath can only fire early and turn a
 * user who is still typing into a failure the caller was happy to keep waiting
 * for.
 */
function withDeadline<T>(work: Promise<T>, ms: number, expired: LoginWaitExpired): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(expired), ms);
    // `unref` so the ceiling never outlives the thing it is capping: a timer
    // still on the loop would keep the process alive for the remaining minutes
    // of a login that already succeeded in seconds.
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function runLogin(args: LoginArgs): Promise<number> {
  // The page comes up before anything else, and its URL is printed before a
  // single MitID byte moves. That ordering is the whole point: the username is
  // typed on the page, and MitID's clock does not start until it arrives. Ask
  // first and start the session second, and the session ages through the whole
  // stretch where the user is finding the link, switching windows and typing —
  // an aged, half-finished session is exactly what the CAP008 parallel-session
  // detector is looking for.
  const page = await openLoginPage(args.noOpen === true);

  // Deliberately unbounded. Nothing MitID-side exists yet, so there is no clock
  // to beat — the user can go and find a username they have not typed in a year
  // and the only thing it costs is a held port. Whatever runs `login` already
  // caps it (SETUP.md has the agent do so), and Ctrl-C covers a human, so a
  // ceiling here would only duplicate a control that already exists one layer
  // up, and duplicate it tighter: it would fire first, ending a login the
  // caller was still willing to wait for.
  const askUsername = (opts?: { error?: string }) => page.askUsername(opts);

  let identityIndex: number | undefined;
  let identityName: string | undefined;
  let lastQrUpdate = -1;

  // Everything from here down runs inside the catch, including the very first
  // ask. `Bun.serve` holds the event loop open, so a throw that escapes past
  // `finish()` would not exit noisily — it would leave the process sitting on a
  // port with the page still showing a form.
  try {
    info('Waiting for the MitID username to be entered on that page.');
    let username = await askUsername();

    // stderr, never console.*: the CLI's stdout is a data channel (see io.ts),
    // and console.debug/info default to stdout in Bun.
    const tracePath = args.debug ? `${AULA_DIR}/login-trace.jsonl` : undefined;
    const logger: Logger = args.debug ? stderrLogger('aula') : silentLogger;
    if (tracePath) info(`Debug: writing a sanitised wire transcript to ${fmt.dim(tracePath)}`);

    for (let attempt = 1; ; attempt += 1) {
      // A fresh HTTP client, and therefore a fresh cookie jar, per attempt. The
      // jar is `readonly` and has no reset, and it is not inert: the completion
      // form reads `SessionUuid` and `Challenge` back out of it by name, so a
      // retry on a reused jar can post the abandoned attempt's session into the
      // new one and fail far downstream, after the user has already approved.
      const http = new AulaHttpClient({
        logger,
        ...(tracePath ? { tracer: new JsonlFileTracer(tracePath) } : {}),
      });
      const client = new AulaLoginClient({ http, logger });

      info(`Contacting MitID for ${fmt.bold(username)}.`);

      try {
        const tokens = await client.login({
          username,
          selectIdentity: async (options: IdentityOption[]) => {
            const choice = await withDeadline(
              page.askIdentity(options.map((o) => o.name)),
              IDENTITY_WAIT_MS,
              new LoginWaitExpired(
                'Nobody picked an identity on the login page in time, and the MitID session ' +
                  `expires sooner than a longer wait would allow. Re-run \`${cmd('login')}\`.`,
                'Der gik for lang tid, inden der blev valgt en identitet, så MitID-sessionen ' +
                  'udløb. Kør login igen, og vælg, når siden spørger.',
              ),
            );
            identityIndex = choice;
            identityName = options.find((o) => o.index === choice)?.name;
            return choice;
          },
          appCallbacks: {
            // MitID chooses between these two modes per account — an OTP to
            // compare, or a QR pair to scan. Both must be handled: wiring only
            // one leaves the other mode sitting silently in the poll loop,
            // looking exactly like a hang.
            onOtp(otp) {
              page.update({ kind: 'otp', otp });
            },
            onQr(qr) {
              // The same code arrives on every poll, a second apart, and
              // `update()` re-encodes both symbols and bumps the revision
              // unconditionally. Without this the browser would swap in two
              // freshly drawn but identical SVGs once a second, and the phone
              // would lose its lock on a code that never actually changed.
              if (qr.updateCount === lastQrUpdate) return;
              lastQrUpdate = qr.updateCount;
              page.update({
                kind: 'qr',
                qr1: qr.qr1Json,
                qr2: qr.qr2Json,
                updateCount: qr.updateCount,
              });
            },
            onVerified() {
              page.update({ kind: 'verified' });
              info(`${fmt.green('Channel verified')} — now approve the login in your MitID app.`);
            },
            onPoll(result) {
              // Between "verified" and the user tapping approve there is
              // nothing to draw, and that wait is long enough to look broken. A
              // dot per poll is enough to show it is alive.
              if (result.kind === 'waiting') stderr.write('.');
            },
          },
        });

        const record: StoredTokenRecord = {
          version: 1,
          username,
          tokens,
          saved_at: Math.floor(Date.now() / 1000),
          ...(identityIndex ? { identityIndex } : {}),
          ...(identityName ? { identityName } : {}),
        };
        await tokenStore().save(record);
        ok(`Login successful. Tokens encrypted into ${fmt.dim(TOKEN_PATH)}.`);
        if (!process.env[KEY_ENV]) {
          info(`  Set ${fmt.dim(`$${KEY_ENV}`)} to keep the key out of the filesystem.`);
        }

        // A different login sees different children; anything cached under the
        // old one is at best useless and at worst somebody else's data.
        clearCache();

        // The calendar read is a POST and needs a CSRF token, which only exists
        // in the cookie jar. Keeping the jar is also what makes
        // `refresh-stepup` able to silent-SSO later.
        try {
          await saveCookieJar(http.jar);
        } catch (err) {
          warn(`Could not persist cookies: ${errorMessage(err)}`);
          warn('Calendar reads may fail; everything else will work.');
        }

        const secondsLeft = Math.max(0, tokens.expires_at - Math.floor(Date.now() / 1000));
        info(
          `Access token valid for ${Math.round(secondsLeft / 60)} min; it refreshes itself after that.`,
        );
        // Not "Du er logget ind" — the page already says that as the heading,
        // and this string is the line under it.
        await page.finish({ ok: true, message: 'Du kan lukke vinduet' });
        return 0;
      } catch (err) {
        // The only retryable error, and narrow on purpose. `identity_not_found`
        // comes back from the very first MitID call — the identity claim — so
        // when it throws no identity is bound, no authenticator has been
        // selected, and nothing has been pushed to the user's phone. There is
        // no pending approval left behind for the next attempt to collide with.
        // Widen this catch by a single error and that stops holding: everything
        // thrown after that point leaves a live session ageing on MitID's side,
        // and retrying into it is precisely how the CAP008 remediation below
        // gets reached.
        if (!(err instanceof MitidIdentityNotFoundError) || attempt >= MAX_USERNAME_ATTEMPTS) {
          throw err;
        }
        warn(`MitID has no user called "${username}". Asking again on the login page.`);
        username = await askUsername({
          error: 'Ugyldigt MitID brugernavn. Prøv igen',
        });
      }
    }
  } catch (err) {
    const message = errorMessage(err);
    fail(`Login failed: ${message}`);

    // By far the most common failure, and the least self-explanatory. MitID
    // exposes no way to tear a session down, so this can only be waited out —
    // and the usual cause is an earlier attempt that was abandoned rather than
    // finished, whose app prompt is still sitting there unanswered.
    const parallel = err instanceof MitidParallelSessionError || /parallel/i.test(message);
    await page.finish({ ok: false, message: pageFailure(err, parallel) });

    if (parallel) {
      info('');
      info(`${fmt.bold('This is MitID\'s "parallel sessions" detector (CAP008).')}`);
      info('  In order:');
      info('    1. Open the MitID app and reject any pending approval request.');
      info('       An abandoned login leaves one there, and that alone trips this.');
      info('    2. Close any tabs logged in to aula.dk.');
      info('    3. Wait 60 seconds — 2-3 minutes if this is a repeat — then retry.');
      info('');
      info('  There is no way to clear it faster: MitID has no session-teardown');
      info('  endpoint, so the session has to age out on their side.');
    } else if (!args.debug) {
      info(`Re-run with ${fmt.dim('--debug')} to capture a sanitised wire transcript.`);
    }
    return 2;
  }
}

/**
 * What the parent reads on the page when the attempt ends badly.
 *
 * The page is Danish and the errors underneath it are not: they come from
 * MitID, from a SAML form, or from a socket, and none of them were written for
 * a reader who just wants to know whether to try again. So the two failures
 * that have an answer get one in Danish, and everything else gets a Danish
 * frame around the original text rather than a translation that would be a
 * guess.
 */
function pageFailure(err: unknown, parallel: boolean): string {
  if (err instanceof LoginWaitExpired) return err.pageMessage;
  if (parallel) {
    return (
      'MitID afviste login, fordi der allerede er en åben MitID-session. Åbn MitID-appen, ' +
      'afvis en eventuel ventende anmodning, luk faner med aula.dk, og prøv igen om et par minutter.'
    );
  }
  return `Login mislykkedes: ${errorMessage(err)}`;
}

/**
 * Starts the page, or ends the login explaining why it could not.
 *
 * This used to be a convenience with the terminal rendering behind it, and a
 * port that would not bind was a reason to fall back rather than to stop. It is
 * now the only surface there is: the username is typed here, so no page means
 * no login. It is also the right place to fail — nothing MitID-side has been
 * started yet, so refusing here leaves no session ageing behind us.
 *
 * The import stays dynamic for the reason it always was: the QR rendering
 * reaches into a dependency's internals (see qr-svg.ts), and a module that
 * throws while loading should take `login` down, not the whole CLI.
 */
async function openLoginPage(noOpen: boolean): Promise<LoginPage> {
  let page: LoginPage;
  try {
    const { startLoginPage } = await import('./login-page.ts');
    page = startLoginPage();
  } catch (err) {
    throw new UsageError(
      `Could not start the local login page: ${errorMessage(err)}. ` +
        'Both the MitID username and the approval are collected there, so `login` needs ' +
        'a machine that can bind a loopback port and open a browser.',
    );
  }
  info('');
  info('  Everything happens on this page — it asks for the MitID username first:');
  info(`  ${fmt.bold(page.url)}`);
  info('  Hand over the link; do not ask for the username in the chat.');
  info('');
  if (!noOpen) openInBrowser(page.url);
  return page;
}

export async function runLogout(): Promise<number> {
  await tokenStore().clear();
  ok(`Cleared MitID tokens from ${fmt.dim(TOKEN_PATH)}.`);
  if (existsSync(COOKIE_JAR_PATH)) {
    clearCookieJar();
    unlinkSync(COOKIE_JAR_PATH);
    ok('Cleared stored cookies.');
  }
  // The cache holds message bodies about the children; logging out and leaving
  // them readable on disk would make `logout` a lie.
  if (clearCache()) ok('Cleared the cached responses.');
  return 0;
}

export async function runStatus(asText: boolean): Promise<number> {
  const record = await loadFreshTokens();
  const now = Math.floor(Date.now() / 1000);

  const status = {
    tokenStore: TOKEN_PATH,
    tokenKeyFromEnv: Boolean(process.env[KEY_ENV]),
    loggedIn: Boolean(record),
    username: record?.username ?? null,
    identityName: record?.identityName ?? null,
    accessTokenExpiresInSeconds: record ? Math.max(0, record.tokens.expires_at - now) : null,
    cookieJar: existsSync(COOKIE_JAR_PATH) ? COOKIE_JAR_PATH : null,
  };

  if (!asText) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  if (status.loggedIn) {
    const mins = Math.round((status.accessTokenExpiresInSeconds ?? 0) / 60);
    ok(
      `Logged in as ${fmt.bold(status.username ?? '?')}${status.identityName ? ` (${status.identityName})` : ''}`,
    );
    info(`  Access token valid for ${mins} min, then refreshed automatically.`);
  } else {
    warn('Not logged in with MitID.');
    info(`  Run ${fmt.dim(cmd('login'))}.`);
  }
  info(
    `  Token store:     ${status.tokenStore}${status.tokenKeyFromEnv ? ` (key from $${KEY_ENV})` : ''}`,
  );
  info(`  Cookie jar:      ${status.cookieJar ?? 'none'}`);
  return 0;
}

/**
 * Re-authorize against a still-alive broker session.
 *
 * Aula drops the step-up assurance level long before the login itself expires,
 * and without it the sensitive threads — the ones about a specific child — read
 * as empty. This gets it back without a full MitID round-trip.
 */
export async function runRefreshStepUp(): Promise<number> {
  const store = tokenStore();
  const existing = await store.load();
  if (!existing) throw new UsageError(`Not logged in. Run \`${cmd('login')}\` first.`);

  const http = new AulaHttpClient({ logger: silentLogger });
  const client = new AulaLoginClient({ http, logger: silentLogger });

  try {
    const tokens = await client.attemptSilentReauthorize();
    await store.save({ ...existing, tokens, saved_at: Math.floor(Date.now() / 1000) });
    await saveCookieJar(http.jar).catch(() => undefined);
    // Everything cached before this point was read by a session that could not
    // see sensitive threads, and those come back *empty* rather than failing —
    // so serving them again would silently undo the step-up we just bought.
    clearCache();
    ok('Step-up refreshed silently — sensitive threads should read again.');
    return 0;
  } catch (err) {
    if (err instanceof AulaSilentSsoFailedError) {
      warn('The broker session has expired, so a silent refresh is not possible.');
      info(`  Run ${fmt.dim(cmd('login'))} to step up again.`);
      return 2;
    }
    throw err;
  }
}
