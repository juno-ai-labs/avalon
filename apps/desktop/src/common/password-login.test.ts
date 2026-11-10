import { expect, it } from 'vitest';
import { parsePasswordLoginRequest, passwordLoginErrorMessage } from './password-login';

it('normalizes the email and preserves password bytes at the IPC boundary', () => {
  expect(parsePasswordLoginRequest({ email: ' REVIEWER@EXAMPLE.TEST ', password: ' secret ' }))
    .toEqual({ email: 'reviewer@example.test', password: ' secret ' });
});

it('rejects a dotless email with a field diagnostic and no credential values', () => {
  expect(() => parsePasswordLoginRequest({ email: 'reviewer@localhost', password: 'private-value' }))
    .toThrow('password_login_request_invalid:email:invalid_format');
});

it.each([
  ["Error invoking remote method 'auth:password': Error: password_login_request_invalid:email:invalid_format", 'Enter a valid email address.'],
  ["Error invoking remote method 'auth:password': Error: password_login_request_invalid:password:too_small", 'Enter a password.'],
  ["Error invoking remote method 'auth:password': RallyApiResponseError: The email or password is incorrect.", 'The email or password is incorrect.'],
  ['Network connection unavailable', 'Network connection unavailable'],
])('renders a readable sign-in error for %s', (input, expected) => {
  expect(passwordLoginErrorMessage(input)).toBe(expected);
});
