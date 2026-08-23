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
import {
  fail,
  fmt,
  info,
  ok,
  openInBrowser,
  prompt,
  promptSecret,
  selectFromList,
  warn,
} from './io.ts';
import type { LoginPage } from './login-page.ts';
import { createQrRenderer } from './qr.ts';
import { errorMessage } from './validation.ts';
import {
  AulaHttpClient,
  AulaLoginClient,
  AulaSilentSsoFailedError,
  JsonlFileTracer,
  MitidParallelSessionError,
  silentLogger,
  stderrLogger,
} from './vendor/aula-auth/index.ts';
import type { IdentityOption, Logger, StoredTokenRecord } from './vendor/aula-auth/index.ts';

export type LoginArgs = {
  username?: string;
  method: 'APP' | 'CODE_TOKEN';
  debug?: boolean;
  /** Stay in the terminal: no local page, no browser. */
  noBrowser?: boolean;
};

export async function runLogin(args: LoginArgs): Promise<number> {
  const username =
    args.username ??
    (await prompt('MitID username:', 'Pass it as --username <your MitID username> instead.'));
  if (!username) throw new UsageError('A MitID username is required.');

  // stderr, never console.*: the CLI's stdout is a data channel (see io.ts),
  // and console.debug/info default to stdout in Bun.
  const tracePath = args.debug ? `${AULA_DIR}/login-trace.jsonl` : undefined;
  const logger: Logger = args.debug ? stderrLogger('aula') : silentLogger;
  const http = new AulaHttpClient({
    logger,
    ...(tracePath ? { tracer: new JsonlFileTracer(tracePath) } : {}),
  });
  const client = new AulaLoginClient({ http, logger });

  if (tracePath) info(`Debug: writing a sanitised wire transcript to ${fmt.dim(tracePath)}`);
  info(`Starting MitID login for ${fmt.bold(username)} (${args.method})`);

  let password: string | undefined;
  if (args.method === 'CODE_TOKEN') {
    password = await promptSecret(
      'MitID password:',
      'A kodeviser login has to be typed; the default app method does not.',
    );
  }

  /**
   * When stderr is not a terminal, an agent is driving and nobody is looking at
   * this output. The OTP mode survives that — the agent can repeat six digits
   * into the chat — but the QR mode cannot: it is two pictures that rotate
   * every few seconds. So the approval moves to a page the user opens, and the
   * terminal rendering below is left alone for the case where a human is
   * actually sitting here. See login-page.ts.
   */
  const page = stderr.isTTY || args.noBrowser === true ? undefined : await openLoginPage();

  let identityIndex: number | undefined;
  let identityName: string | undefined;
  let otpShown = false;
  let lastQrUpdate = -1;
  const renderQr = createQrRenderer();

  try {
    const tokens = await client.login({
      username,
      method: args.method,
      ...(password ? { password } : {}),
      ...(args.method === 'CODE_TOKEN'
        ? {
            promptForCodeToken: () =>
              prompt('6 digits from your kodeviser:', 'A kodeviser login has to be typed.'),
          }
        : {}),
      selectIdentity: async (options: IdentityOption[]) => {
        const choice = await selectFromList(
          'MitID returned more than one identity. Pick one:',
          options.map((o) => o.name),
        );
        identityIndex = choice;
        identityName = options.find((o) => o.index === choice)?.name;
        return choice;
      },
      appCallbacks: {
        // MitID chooses between these two modes per account — an OTP to
        // compare, or a QR pair to scan. Both must be handled: wiring only one
        // leaves the other mode sitting silently in the poll loop, looking
        // exactly like a hang.
        onOtp(otp) {
          page?.update({ kind: 'otp', otp });
          // The same OTP repeats on every poll; printing once keeps the number
          // the user is comparing against stable on screen.
          if (otpShown) return;
          otpShown = true;
          info('');
          info(`  Open the MitID app and approve this code:  ${fmt.bold(otp)}`);
          info('');
        },
        onQr(qr) {
          if (qr.updateCount === lastQrUpdate) return;
          lastQrUpdate = qr.updateCount;
          if (page) {
            // One or the other, never both. The terminal renderer redraws in
            // place on a TTY and *appends* everywhere else, so leaving it on
            // would push a fresh 35-line block of QR into the output on every
            // rotation — straight into the context of the agent this page
            // exists to spare.
            page.update({
              kind: 'qr',
              qr1: qr.qr1Json,
              qr2: qr.qr2Json,
              updateCount: qr.updateCount,
            });
            return;
          }
          renderQr(qr.qr1Json, qr.qr2Json, qr.updateCount);
        },
        onVerified() {
          page?.update({ kind: 'verified' });
          info(`${fmt.green('Channel verified')} — now approve the login in your MitID app.`);
        },
        onPoll(result) {
          // Between "verified" and the user tapping approve there is nothing to
          // draw, and that wait is long enough to look broken. A dot per poll
          // is enough to show it is alive.
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

    // A different login sees different children; anything cached under the old
    // one is at best useless and at worst somebody else's data.
    clearCache();

    // The calendar read is a POST and needs a CSRF token, which only exists in
    // the cookie jar. Keeping the jar is also what makes `refresh-stepup` able
    // to silent-SSO later.
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
    await page?.finish({ ok: true, message: 'Tokens saved. Aula is ready to read.' });
    return 0;
  } catch (err) {
    const message = errorMessage(err);
    fail(`Login failed: ${message}`);
    await page?.finish({ ok: false, message });

    // By far the most common failure, and the least self-explanatory. MitID
    // exposes no way to tear a session down, so this can only be waited out —
    // and the usual cause is an earlier attempt that was abandoned rather than
    // finished, whose app prompt is still sitting there unanswered.
    if (err instanceof MitidParallelSessionError || /parallel/i.test(message)) {
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
 * Starts the page and says where it is, or explains why there is not one.
 *
 * The page is a convenience, not the login: a port that cannot be bound is a
 * reason to fall back to the terminal rendering, not a reason to refuse to log
 * in. The import is dynamic for the same reason — the QR renderer reaches into
 * a dependency's internals (see qr-svg.ts), and nothing about that should be
 * able to keep `login` from running, let alone the rest of the CLI.
 */
async function openLoginPage(): Promise<LoginPage | undefined> {
  try {
    const { startLoginPage } = await import('./login-page.ts');
    const page = startLoginPage();
    info('');
    info('  Nothing is attached to this terminal, so the MitID approval is on a page:');
    info(`  ${fmt.bold(page.url)}`);
    info('');
    openInBrowser(page.url);
    return page;
  } catch (err) {
    warn(`Could not open the login page: ${errorMessage(err)}`);
    warn('Any approval code will only be readable in this output.');
    return undefined;
  }
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
    info(`  Run ${fmt.dim('bun run login')}.`);
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
  if (!existing) throw new UsageError('Not logged in. Run `bun run login` first.');

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
      info(`  Run ${fmt.dim('bun run login')} to step up again.`);
      return 2;
    }
    throw err;
  }
}
