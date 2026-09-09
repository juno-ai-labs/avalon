/**
 * Personas: the people in a demo who do not exist.
 *
 * Every role in a pack but the presenter's is played by a persona — a regional
 * user row this operation mints, with the name the operator typed, no platform
 * identity, and no way to sign in. That is what frees a demo from the people
 * who happen to be in the template: the operator names the cast for the company
 * they are presenting to, rather than casting colleagues whose real names and
 * addresses would be on screen in front of a customer.
 *
 * A persona belongs to one operation and is minted before its row is written,
 * so everything downstream — the cast binding, the seeder, the readiness
 * barrier — keeps working in user ids and knows nothing about how those ids
 * came to be. Identity is derived rather than stored: `google_subject` is the
 * operation and the role, which is what makes minting idempotent (a repeated
 * submission or a retry finds the same person rather than a second one) and
 * what lets the template check prove, before the first write, that a cast id
 * is this operation's own persona rather than somebody's account.
 *
 * `docs/demo-workspaces.md` owns the feature.
 */
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { uuidV7 } from "../lib/uuid-v7";
import type { DemoPackRole } from "./demo-pack";

/** How a persona is recognised: this operation, this role, and nothing else. */
export function demoPersonaSubject(operationId: string, role: DemoPackRole): string {
  return `demo-persona:${operationId}:${role}`;
}

/**
 * A persona's address. It is never delivered to and never signed in with, but
 * it is on screen — the composer's people picker shows a member's address
 * under their name — so it reads like one, under the reserved `.invalid`
 * top-level domain, which nobody can register and no mail can reach. The
 * operation's first hex group makes it unique: two demos for the same company
 * cast the same default names, and `users.email` is unique.
 */
export function demoPersonaEmail(operationId: string, role: DemoPackRole, displayName: string): string {
  const local = displayName.toLowerCase().normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/gu, ".").replaceAll(/^\.+|\.+$/gu, "");
  return `${local || role}@${operationId.slice(0, 8)}.demo.invalid`;
}

/**
 * Mint this operation's personas, or find the ones it already has.
 *
 * Answered in role order with the user id each name is played by. Idempotent
 * by the derived subject: a second submission of the same operation id, or a
 * retry, meets the people it made the first time — with the names it was
 * given the first time, because the cast of a demo that is already being
 * prepared is not something a repeated request may change.
 */
export async function ensureDemoPersonas(env: Env, input: {
  operationId: string;
  names: Readonly<Record<DemoPackRole, string>>;
  /**
   * The presenter's, so the whole cast reads as one company in one place. A
   * persona's timezone is on their directory row like anybody's, and the
   * column's default would put the cast in California in front of a customer
   * in London.
   */
  timezone: string;
}): Promise<Record<DemoPackRole, string>> {
  const at = new Date().toISOString();
  const bound: Record<DemoPackRole, string> = {};
  for (const [role, displayName] of Object.entries(input.names)) {
    const subject = demoPersonaSubject(input.operationId, role);
    await env.DB.prepare(
      `INSERT INTO users (id, google_subject, email, name, avatar_url, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (google_subject) DO NOTHING`,
    ).bind(
      uuidV7(), subject, demoPersonaEmail(input.operationId, role, displayName), displayName,
      input.timezone, at, at,
    ).run();
    const persona = await env.DB.prepare(
      `SELECT id FROM users WHERE google_subject = ?`,
    ).bind(subject).first<{ id: string }>();
    if (!persona) throw new ApiError(500, "demo_persona_not_minted", `The persona playing "${role}" could not be created`);
    bound[role] = persona.id;
  }
  return bound;
}

/**
 * Prove every role but the presenter's is played by this operation's own
 * persona. The ids are the region's, never the operator's — the start request
 * carries names — and this is the check that keeps it that way through a row
 * that was written minutes ago: a cast id that is somebody's account would
 * seat that person in a demo workspace and hand them the template's copied
 * connections.
 */
export async function assertDemoPersonas(env: Env, input: {
  operationId: string;
  cast: Readonly<Record<DemoPackRole, string>>;
  presenterRole: DemoPackRole | null;
}): Promise<void> {
  for (const [role, userId] of Object.entries(input.cast)) {
    if (role === input.presenterRole) continue;
    const persona = await env.DB.prepare(
      `SELECT google_subject, platform_user_id FROM users WHERE id = ?`,
    ).bind(userId).first<{ google_subject: string | null; platform_user_id: string | null }>();
    if (
      !persona
      || persona.google_subject !== demoPersonaSubject(input.operationId, role)
      || persona.platform_user_id !== null
    ) {
      throw new ApiError(409, "demo_cast_not_persona", `The cast member playing "${role}" is not this preparation's persona`);
    }
  }
}
