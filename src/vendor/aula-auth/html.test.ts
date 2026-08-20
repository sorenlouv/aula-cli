import { describe, expect, test } from 'bun:test';
import { extractAttr, extractFormAction, extractHiddenInputs } from './html.ts';

const samlForm = `
<html><body>
  <form method="post" action="https://login.aula.dk/saml/acs">
    <input type="hidden" name="SAMLResponse" value="abc123" />
    <input type="hidden" name="RelayState" value="state-token" />
    <input type="submit" value="Continue" />
  </form>
</body></html>
`;

const loginOptionsPage = `
<html><body>
  <a class="list-link" data-loginoptions='{"id":"1","name":"Child A"}'>
    <div class="list-link-text">Child A (Guardian)</div>
  </a>
  <a class="list-link" data-loginoptions='{"id":"2","name":"Child B"}'>
    <div class="list-link-text">Child B (Guardian)</div>
  </a>
</body></html>
`;

describe('extractHiddenInputs', () => {
  test('returns name → value for SAML form fields', () => {
    expect(extractHiddenInputs(samlForm)).toEqual({
      SAMLResponse: 'abc123',
      RelayState: 'state-token',
    });
  });

  test('skips submit/button inputs', () => {
    const inputs = extractHiddenInputs(samlForm);
    expect(inputs).not.toHaveProperty('Continue');
  });

  test('returns empty object when there is no form', () => {
    expect(extractHiddenInputs('<html><body><p>nothing here</p></body></html>')).toEqual({});
  });
});

describe('extractFormAction', () => {
  test('returns the action URL', () => {
    expect(extractFormAction(samlForm)).toBe('https://login.aula.dk/saml/acs');
  });

  test('returns null when no form is present', () => {
    expect(extractFormAction('<html></html>')).toBeNull();
  });
});

describe('extractAttr', () => {
  test('returns the first matching attribute', () => {
    expect(extractAttr(loginOptionsPage, 'a.list-link', 'data-loginoptions')).toBe(
      '{"id":"1","name":"Child A"}',
    );
  });
});
