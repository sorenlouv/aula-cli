/**
 * The login page as the browser runs it.
 *
 * Everything drawn here is a pure function of one `ViewState`. That is the
 * whole point of the port: the old client patched nodes in place and had to
 * remember to clear each one on the way *out* of a state, which it did not — a
 * rotation counter outlived its QR codes until a manual reset was added to
 * every other branch. A tree rebuilt from the state cannot have that bug,
 * because there is nowhere to put the code that would cause it.
 *
 * The poll loop is next door in session.ts and calls `render` directly, so
 * there is exactly one of it by construction and nothing in this file can start
 * a second.
 *
 * Copy and markup stay in one file on purpose. A state's heading, its lede, its
 * body and the sentence a screen reader hears are a single decision, and the
 * exhaustive switches that make "someone added a state and forgot the copy" a
 * compile error only hold while they are read side by side.
 */

import { render, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createSession, type Submit, type ViewState } from './session.ts';

type Tone = 'neutral' | 'ok' | 'bad';
type Copy = { title: string; lede: string; tone: Tone };

/** Six digits read as six digits, not as four hundred eighty-one thousand. */
const spaced = (code: string) => [...code].join(' ');

/** The id the username field points its `aria-describedby` at. */
const ASK_ERROR_ID = 'ask-error';

/**
 * Everything above the body, for one state.
 *
 * One switch with no `default`, so `noImplicitReturns` turns a new wire state
 * with no copy into a compile error — where the old `render()` silently
 * repainted nothing and returned `false`.
 */
function copyFor(state: ViewState): Copy {
  switch (state.kind) {
    case 'connecting':
      return { title: 'Log ind med MitID', lede: 'Et øjeblik...', tone: 'neutral' };
    case 'ask-username':
      return {
        title: 'Log ind med MitID',
        // Says where the secret part happens, on a page that could otherwise
        // look exactly like the phishing it is not: nothing is approved here.
        lede: 'Skriv dit MitID-brugernavn. Selve godkendelsen sker i MitID-appen på din telefon.',
        tone: 'neutral',
      };
    case 'ask-identity':
      return {
        title: 'Hvem logger du ind som?',
        lede: 'Dit MitID er knyttet til flere. Vælg den, du bruger til Aula.',
        tone: 'neutral',
      };
    case 'starting':
      return {
        title: 'Kontakter MitID',
        lede: 'Åbn MitID på din telefon.',
        tone: 'neutral',
      };
    case 'otp':
      return {
        title: 'Godkend koden i MitID-appen',
        // Framed as a comparison with both answers spelled out: this is the one
        // moment on the page where a parent is defending themselves against
        // something, and "godkend" alone does not say that.
        lede: 'Tjek, at MitID-appen viser det samme tal. Viser den et andet, skal du afvise.',
        tone: 'neutral',
      };
    case 'qr':
      return {
        title: 'Scan en af QR koderne med MitID-appen',
        lede: '',
        tone: 'neutral',
      };
    case 'verified':
      return {
        title: 'QR kode scannet',
        lede: 'Godkend nu dit login i MitID-appen.',
        tone: 'neutral',
      };
    case 'done':
      // `message` is the process's own account of what happened — the CAP008
      // explanation is ~230 characters of it — and it is rendered verbatim,
      // never truncated and never wrapped in wording of ours.
      return {
        title: state.ok ? 'Du er logget ind' : 'Login mislykkedes',
        lede: state.message,
        tone: state.ok ? 'ok' : 'bad',
      };
    case 'session-ended':
      return {
        title: 'Siden mistede forbindelsen',
        // The second clause answers the question a parent actually has here:
        // did something half-happen to my identity?
        lede:
          'Login-kommandoen kører ikke længere, og der blev ikke godkendt noget i MitID. ' +
          'Kør aula login igen, hvis du stadig vil logge ind.',
        tone: 'neutral',
      };
  }
}

/**
 * The one sentence the page says out loud.
 *
 * Every change here is one the *process* made, not one the reader asked for, so
 * nothing else on the page is a live region: the heading and the lede are
 * ordinary text, and this is what a screen reader hears instead.
 */
function announcementFor(state: ViewState): string {
  switch (state.kind) {
    case 'connecting':
      // One round trip on loopback. Announcing it would be noise in front of
      // the sentence that matters.
      return '';
    case 'ask-username':
      // No error text here on purpose. A re-ask remounts the alert with its
      // message already inside it, which screen readers do not reliably speak —
      // so the field's `aria-describedby` carries it instead, read out when the
      // mount effect puts focus in the field. An in-place rejection is a text
      // change inside a mounted alert, which they do speak. Two paths, one
      // utterance each, never both.
      return 'Skriv dit MitID-brugernavn, og vælg Fortsæt.';
    case 'ask-identity': {
      const count = state.options.length;
      return `Vælg, hvem du logger ind som. ${count} ${count === 1 ? 'mulighed' : 'muligheder'}.`;
    }
    case 'starting':
      return 'Kontakter MitID. Åbn MitID på din telefon.';
    case 'otp':
      return `Godkend koden i MitID-appen. Koden er ${spaced(state.otp)}.`;
    case 'qr':
      // Deliberately carries nothing from `updateCount`. A sentence that
      // changed with the rotation would talk over the reader every two seconds
      // for as long as the login takes.
      return 'Scan en af QR koderne med MitID-appen. Hold telefonen op mod skærmen.';
    case 'verified':
      return 'QR kode scannet. Godkend nu dit login i MitID-appen.';
    case 'done':
      return `${state.ok ? 'Du er logget ind.' : 'Login mislykkedes.'} ${state.message}`;
    case 'session-ended':
      return 'Siden mistede forbindelsen. Login-kommandoen kører ikke længere.';
  }
}

function Page({ state, submit }: { state: ViewState; submit: Submit }) {
  const { title, lede, tone } = copyFor(state);
  return (
    <>
      <Announcer text={announcementFor(state)} />
      <h1 class="title" data-tone={tone}>
        {title}
      </h1>
      <p class="lede">{lede}</p>
      <Body state={state} submit={submit} />
    </>
  );
}

/**
 * Mounted once, above the switch, and never keyed.
 *
 * A live region inserted at the same moment as its text is a region most screen
 * readers never announce, so this element has to outlive every state it
 * describes. Polite, because none of it is urgent enough to cut off a word
 * already being spoken.
 *
 * `<output>` rather than a `<p role="status">`: the role is this element's
 * implicit one, so the tag says it without an attribute that could be dropped.
 * The two aria attributes stay written out anyway — they are what makes this a
 * live region even where the implicit role is not honoured, and this is the
 * only place the page speaks.
 */
function Announcer({ text }: { text: string }) {
  return (
    <output class="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </output>
  );
}

function Body({ state, submit }: { state: ViewState; submit: Submit }): VNode | null {
  switch (state.kind) {
    case 'connecting':
      return <Waiting label="Forbinder" />;
    case 'ask-username':
      // key={state.rev}: one question, one mounted form. `arm()` bumps the
      // revision and nothing else does while an ask sits armed, so the key is
      // constant *within* a question and changes *between* two — which rebuilds
      // the field empty and refocused with no ask id on the wire and no reset
      // logic anywhere. It is also what makes this correct when
      // `ask -> starting -> ask` collapses into one poll window and the browser
      // never sees `starting` at all. An in-place rejection does not bump
      // `rev`, so it keeps what the parent had already typed.
      return <UsernameForm key={state.rev} error={state.error} submit={submit} />;
    case 'ask-identity':
      return (
        <IdentityList key={state.rev} options={state.options} error={state.error} submit={submit} />
      );
    case 'starting':
      return <Waiting label="Venter på MitID" />;
    case 'otp':
      return <OtpCode code={state.otp} />;
    case 'qr':
      return (
        <>
          <QrPair svg1={state.svg1} svg2={state.svg2} />
          {/* The only motion on this screen. The rotation counter it replaces
              was developer telemetry a parent cannot act on, and it was the one
              node the old code had to clear on every state *exit* — the bug
              this port exists to delete. A dot that pulses says the same "still
              alive" without changing twice a second. */}
          <Waiting label="Venter på scanning" />
        </>
      );
    case 'verified':
      return <Waiting label="Venter på din godkendelse" />;
    case 'done':
    case 'session-ended':
      // No card, no spinner: the outcome is entirely the heading and the lede
      // above it. The old page left a bordered, shadowed, empty box floating
      // here — a container for content that no longer exists.
      return null;
  }
}

/** Waiting has nothing to hold, so it gets no card — only something to say. */
function Waiting({ label }: { label: string }) {
  return (
    <p class="waiting">
      <span class="dot" aria-hidden="true" />
      {label}
    </p>
  );
}

function OtpCode({ code }: { code: string }) {
  return (
    <div class="card">
      {/* role="img" is what lets a name be put on a run of digits. Without it a
          screen reader reads "481592" as one number, and the reader's job here
          is to compare it against a phone one digit at a time.

          The linter's advice — use an <img> — cannot apply: this is text that
          has to be selectable and rendered in the page's own type, and the CSP
          allows no image source but data:. The role is the only way to name it. */}
      {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <p class="otp" role="img" aria-label={`Kontrolkode ${spaced(code)}`}>
        {code}
      </p>
    </div>
  );
}

function QrPair({ svg1, svg2 }: { svg1: string; svg2: string }) {
  return (
    <div class="card">
      <div class="codes">
        {/* Server-rendered SVG from our own encoder: the payload is drawn as
            geometry and never interpolated into markup, which is why these two
            are the only `dangerouslySetInnerHTML` on the page.

            Keyed by *position*, never by updateCount. A key that changes on
            rotation remounts both hosts — a visible blink, and a phone that
            loses the lock it just got. A position key lets Preact diff `__html`
            by string equality, so an unchanged code costs no DOM write at all. */}
        <div key="1" class="code" dangerouslySetInnerHTML={{ __html: svg1 }} />
        <div key="2" class="code" dangerouslySetInnerHTML={{ __html: svg2 }} />
      </div>
    </div>
  );
}

/**
 * Always in the DOM, empty when nothing is wrong.
 *
 * `role="alert"` announces text arriving *into* a region the screen reader was
 * already watching, so this cannot be a node that appears with the message
 * inside it — and an error appearing must not shift the control it belongs to.
 */
function ErrorNote({ id, message }: { id: string; message: string | undefined }) {
  return (
    <p class="error" id={id} role="alert">
      {/* `{message}`, not `{message ?? ''}`: Preact turns undefined into no
          child at all, while an empty string is a real text node — and a text
          node, however short, is what stops `.error:empty` from matching and
          leaves a margin under a message nobody can see. */}
      {message}
    </p>
  );
}

/**
 * Uncontrolled on purpose: the value lives in the DOM node, so nothing a poll
 * does can move the caret. A controlled `value={...}` would reset the selection
 * on any re-render, and the caret is the only state a parent cares about
 * mid-word.
 */
function UsernameForm({ error, submit }: { error: string | undefined; submit: Submit }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // A rejection the server answered inline (200 with ok:false). It is newer
  // than anything the wire carried, so it wins — and it cannot outlive the
  // question, because a re-ask arrives with a new revision that remounts this
  // component and takes the local state with it.
  const [rejected, setRejected] = useState<string | undefined>(undefined);
  const message = rejected ?? error;

  // Fires on mount and again whenever the field comes back from a submit. A
  // disabled input drops focus to <body>, so without this a parent is left
  // staring at a field they have to click before they can fix the typo it is
  // complaining about. It is also how the error reaches a screen reader on a
  // re-ask: focusing the field reads its label, its value and its
  // aria-describedby.
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy]);

  async function send(): Promise<void> {
    setBusy(true);
    setRejected(undefined);
    const result = await submit(input.current?.value ?? '');
    // Accepted: stay disabled and let the poll paint the `starting` the server
    // just pushed. Clearing `busy` here flashes a live field for one frame.
    if (result.ok) return;
    setBusy(false);
    setRejected(result.error);
  }

  return (
    <div class="card">
      <label class="field">
        <span class="field-label">MitID-brugernavn</span>
        <input
          ref={input}
          type="text"
          name="username"
          autocomplete="username"
          // A MitID username is not a word: a phone keyboard would otherwise
          // capitalise the first letter and autocorrect the rest of it.
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          enterkeyhint="go"
          disabled={busy}
          aria-invalid={message !== undefined}
          aria-describedby={ASK_ERROR_ID}
          onKeyDown={(event) => {
            // Enter by hand, because there is no <form> to press it against —
            // see the comment on the fetch in session.ts.
            if (event.key === 'Enter') void send();
          }}
        />
      </label>
      <ErrorNote id={ASK_ERROR_ID} message={message} />
      {/* type="button" is the honest spelling: there is no ancestor form today,
          and if one ever appeared the default would be a navigation that
          form-action 'none' kills with nothing on screen to explain it.
          `disabled` is the double-submit guard — a disabled control fires
          neither click nor keydown, and the server's 409 is the backstop. */}
      <button type="button" class="go" disabled={busy} onClick={() => void send()}>
        Fortsæt
      </button>
    </div>
  );
}

/**
 * One button per identity, rather than a radio group plus a submit.
 *
 * The choice *is* the interaction, so making it two — pick, then confirm — buys
 * nothing but a second tap. It also deletes the only place the 1-based index
 * could be got wrong: it comes off `map` at the point of use instead of a
 * string in a radio's `value`. MitID numbers its own option list from 1, and an
 * off-by-one here logs the parent in as the wrong person.
 *
 * Nothing is focused on mount, unlike the username field: an auto-focused
 * button is one Enter away from choosing an identity nobody chose.
 */
function IdentityList({
  options,
  error,
  submit,
}: {
  options: string[];
  error: string | undefined;
  submit: Submit;
}) {
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string | undefined>(undefined);
  const message = rejected ?? error;

  async function choose(index: number): Promise<void> {
    setBusy(true);
    setRejected(undefined);
    // A string, not a number: the server answers a JSON number with a 400.
    const result = await submit(String(index + 1));
    if (result.ok) return;
    setBusy(false);
    setRejected(result.error);
  }

  return (
    <div class="card">
      <ErrorNote id="pick-error" message={message} />
      {/* A list, so a screen reader says how many options there are before it
          reads the first one. */}
      <ul class="options">
        {options.map((name, index) => (
          <li key={index}>
            <button type="button" class="option" disabled={busy} onClick={() => void choose(index)}>
              {name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('login shell is missing #root');

// Started from module scope, never from an effect: an effect with the wrong
// deps starts a second loop, and two loops against this server means a poll
// after `done`, which the server answers by force-closing mid-body.
const session = createSession((state) => {
  render(<Page state={state} submit={session.submit} />, root);
});
render(<Page state={{ kind: 'connecting' }} submit={session.submit} />, root);
session.start();
