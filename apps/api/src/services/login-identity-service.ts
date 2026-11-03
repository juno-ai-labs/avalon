import type { SignupFlow } from '../telemetry/signup';
import { newId, nowIso } from "@rally/db";
import { z } from "zod";
import { ApiError } from "../lib/api-error";

const EmailSchema = z.string().trim().email().transform((email) => email.toLowerCase());

/** Call only after the provider or single-use mailbox challenge has been verified. */
export async function persistVerifiedGoogleIdentity(db: D1Database, input: {
  subject: string; email: string; name: string; avatarUrl: string | null;
}, signup?: SignupFlow): Promise<{ id: string; created: boolean }> {
  const email = EmailSchema.parse(input.email);
  const candidateId = newId();
  const at = nowIso();
  await db.batch([
    // Both providers have proved this primary mailbox. Attach the provider to
    // the existing user, preserving grants, sessions and immutable platform ID.
    db.prepare(`UPDATE users SET google_subject = ?
      WHERE google_subject IS NULL AND email = ?
        AND id = (SELECT user_id FROM user_verified_emails WHERE email = ?)
        AND NOT EXISTS (SELECT 1 FROM users WHERE google_subject = ?)`)
      .bind(input.subject, email, email, input.subject),
    // The flow ID is client-supplied: a flow already recorded on another
    // account is not recorded again, so one flow never follows two people.
    db.prepare(`INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at, signup_flow_id, signup_client_platform)
      VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE signup_flow_id = ?)), ?)
      ON CONFLICT(google_subject) DO UPDATE SET
        email = excluded.email, name = COALESCE(json_extract(users.presentation_json, '$.displayName'), excluded.name),
        avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`)
      .bind(candidateId, input.subject, email, input.name, input.avatarUrl, at, at, signup?.flowId ?? null, signup?.flowId ?? null, signup?.clientPlatform ?? null),
    db.prepare(`INSERT INTO user_login_identities (provider, subject, user_id, verified_at)
      SELECT 'google', google_subject, id, ? FROM users WHERE google_subject = ?
      ON CONFLICT(provider, subject) DO UPDATE SET verified_at = excluded.verified_at`)
      .bind(at, input.subject),
    // Only the current primary mailbox may be used for email login. Keeping a
    // prior address after a provider email change would enable future owners of
    // that mailbox to sign in as this person.
    db.prepare(`DELETE FROM user_login_identities WHERE provider = 'email'
      AND user_id = (SELECT id FROM users WHERE google_subject = ?) AND subject <> ?`)
      .bind(input.subject, email),
    db.prepare(`DELETE FROM user_verified_emails
      WHERE user_id = (SELECT id FROM users WHERE google_subject = ?) AND email <> ?`)
      .bind(input.subject, email),
    db.prepare(`INSERT INTO user_verified_emails (email, user_id, verified_at)
      SELECT email, id, ? FROM users WHERE google_subject = ?
      ON CONFLICT(email) DO UPDATE SET verified_at = excluded.verified_at`)
      .bind(at, input.subject),
  ]);
  const row = await db.prepare("SELECT id, signup_flow_id FROM users WHERE google_subject = ?").bind(input.subject).first<{ id: string; signup_flow_id: string | null }>();
  if (!row) throw new ApiError(500, "identity_persistence_failed", "Could not persist the user identity");
  return { id: row.id, created: row.id === candidateId || !!(signup?.flowId && row.signup_flow_id === signup.flowId) };
}

/**
 * Resolve a verified mailbox to the ordinary user ledger. Existing accounts
 * require an already-bound verified address; an unverified profile match is
 * never an account-linking operation. Concurrent first logins converge through
 * the unique email and provider-subject constraints in one D1 batch.
 */
export async function resolveVerifiedEmailIdentity(db: D1Database, verifiedEmail: string, signup?: SignupFlow): Promise<{ id: string; created: boolean }> {
  const email = EmailSchema.parse(verifiedEmail);
  const id = newId();
  const at = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO users
      (id, email, name, platform_user_id, onboarding_eligible, created_at, updated_at, signup_flow_id, signup_client_platform)
      SELECT ?, ?, ?, ?, 0, ?, ?, (SELECT ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE signup_flow_id = ?)), ?
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`)
      .bind(id, email, email, id, at, at, signup?.flowId ?? null, signup?.flowId ?? null, signup?.clientPlatform ?? null, email),
    db.prepare(`INSERT INTO user_verified_emails (email, user_id, verified_at)
      SELECT email, id, ? FROM users WHERE id = ?`)
      .bind(at, id),
    db.prepare(`INSERT INTO user_login_identities (provider, subject, user_id, verified_at)
      SELECT 'email', ?, user_id, ? FROM user_verified_emails WHERE email = ?
      ON CONFLICT(provider, subject) DO UPDATE SET verified_at = excluded.verified_at`)
      .bind(email, at, email),
  ]);
  const row = await db.prepare(`SELECT identity.user_id FROM user_login_identities identity
    JOIN user_verified_emails verified ON verified.user_id = identity.user_id AND verified.email = identity.subject
    JOIN users u ON u.id = identity.user_id AND u.email = verified.email
    WHERE identity.provider = 'email' AND identity.subject = ?`).bind(email).first<{ user_id: string }>();
  if (!row) throw new ApiError(409, "verified_identity_required", "This address needs an explicit account link before email sign-in");
  return { id: row.user_id, created: row.user_id === id };
}
