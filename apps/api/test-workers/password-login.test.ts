/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { EngineeringInspectionBridge } from '../src/engineering-inspection-bridge';
import { passwordLogin, verifyPassword } from '../src/services/password-login-service';
import { ensureAuditSchema } from './helpers/audit-fixture';
import passwordMigration from '../../../packages/db/migrations/0129_password_login.sql?raw';

const USER = '00000000-0000-7000-8000-00000000a909';
const OPERATOR = { subject: 'password-test-operator', email: 'operator@example.test', audience: 'engineering' };
beforeEach(async () => {
  await reset();
  await ensureAuditSchema();
  await env.DB.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);');
  await env.DB.batch(passwordMigration.split(';').filter((sql) => sql.trim()).map((sql) => env.DB.prepare(sql)));
  await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(USER, 'reviewer@example.test').run();
});

it('provisions native scrypt credentials through the operator bridge, audits no secrets, and revokes them', async () => {
  const ctx = createExecutionContext();
  const bridge = new EngineeringInspectionBridge(ctx, env);
  const first = await bridge.provisionUserPassword({ userId: USER }, OPERATOR);
  const row = await env.DB.prepare('SELECT password_hash FROM user_password_credentials WHERE user_id = ?').bind(USER).first<{ password_hash: string }>();
  expect(verifyPassword(first.password, row!.password_hash)).toBe(true);
  expect(verifyPassword('wrong password', row!.password_hash)).toBe(false);
  const second = await bridge.provisionUserPassword({ userId: USER }, OPERATOR);
  const rotated = await env.DB.prepare('SELECT password_hash FROM user_password_credentials WHERE user_id = ?').bind(USER).first<{ password_hash: string }>();
  expect(verifyPassword(first.password, rotated!.password_hash)).toBe(false);
  expect(verifyPassword(second.password, rotated!.password_hash)).toBe(true);
  expect(await bridge.revokeUserPassword({ userId: USER }, OPERATOR)).toEqual({ userId: USER, passwordEnabled: false });
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM user_password_credentials').first()).toEqual({ n: 0 });
  const audit = await env.AUDIT_DB.prepare("SELECT action, metadata_json FROM audit_events WHERE target_id = ? ORDER BY rowid").bind(USER).all<{ action: string; metadata_json: string }>();
  expect(audit.results.map((event) => event.action)).toEqual([
    'engineering.provision_user_password.attempt', 'engineering.provision_user_password.result',
    'engineering.provision_user_password.attempt', 'engineering.provision_user_password.result',
    'engineering.revoke_user_password.attempt', 'engineering.revoke_user_password.result',
  ]);
  expect(JSON.stringify(audit.results)).not.toContain(first.password);
  expect(JSON.stringify(audit.results)).not.toContain(row!.password_hash);
  expect(JSON.parse(audit.results[0]!.metadata_json)).toMatchObject({ operator: OPERATOR, representedUserId: USER });
  await waitOnExecutionContext(ctx);
});

it('requires a trusted operator and an available attempt audit before provisioning', async () => {
  const ctx = createExecutionContext();
  const bridge = new EngineeringInspectionBridge(ctx, env);
  await expect(bridge.provisionUserPassword({ userId: USER }, {})).rejects.toThrow(/subject/u);
  await env.AUDIT_DB.prepare(`CREATE TRIGGER reject_password_audit BEFORE INSERT ON audit_events
    WHEN NEW.action = 'engineering.provision_user_password.attempt'
    BEGIN SELECT RAISE(ABORT, 'password_test_audit_unavailable'); END;`).run();
  try {
    await expect(bridge.provisionUserPassword({ userId: USER }, OPERATOR)).rejects.toThrow('password_test_audit_unavailable');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM user_password_credentials').first()).toEqual({ n: 0 });
  } finally {
    await env.AUDIT_DB.exec('DROP TRIGGER reject_password_audit');
    await waitOnExecutionContext(ctx);
  }
});

it('atomically admits only ten concurrent unknown-account attempts in real D1', async () => {
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () =>
    passwordLogin(env, { email: 'missing@example.test', password: 'incorrect' })));
  const codes = outcomes.map((outcome) => outcome.status === 'rejected' ? outcome.reason.code : 'signed_in');
  expect(codes.filter((code) => code === 'password_login_invalid')).toHaveLength(10);
  expect(codes.filter((code) => code === 'password_login_rate_limited')).toHaveLength(2);
});
