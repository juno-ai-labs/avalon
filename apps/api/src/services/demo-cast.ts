/**
 * The people a demo is cast from.
 *
 * Every role in a pack is played by a colleague with a real account: the
 * presenter, who signs in and shows the demo, and the rest, who are seated in
 * the workspace so the seeded conversations are theirs. The presenter comes
 * from the template's own members, because the new workspace receives copies
 * of the template's connections; everybody else comes from this list.
 *
 * The list is the company's directory, filtered to one thing — an account on
 * the company's email domain that has signed in to this region. That filter is
 * the boundary, not a convenience for the form: seating an account in a demo
 * workspace hands it the template's copied connections, so it is enforced here
 * when the demo is started and again by `checking_template` before the first
 * write, whatever the page sent.
 *
 * `docs/demo-workspaces.md` owns the feature.
 */
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import type { DemoPackRole } from "./demo-pack";

/**
 * The company's own email domain. Demos are cast from the people on it and
 * from nobody else, so this is the one place the domain is written down and
 * changing it changes who may be seated in a demo workspace.
 */
export const DEMO_CAST_EMAIL_DOMAIN = "rallywith.ai";

/** One person a role can be played by. */
export interface DemoCastCandidate {
  userId: string;
  name: string;
  email: string;
}

/**
 * A LIKE pattern matching every address on the domain, with the wildcards a
 * domain can legally contain escaped: `_` is one character to LIKE and an
 * ordinary one to a hostname, so an unescaped domain would match addresses on
 * neighbouring ones.
 */
function domainPattern(domain: string): string {
  return `%@${domain.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}`;
}

/**
 * Everyone a cast role may be played by, by address. Ordered by email rather
 * than by name so the form's list is stable and an operator finds the person
 * they are looking for where they left them.
 */
export async function listDemoCastCandidates(env: Env): Promise<DemoCastCandidate[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, email FROM users
      WHERE platform_user_id IS NOT NULL AND email LIKE ? ESCAPE '\\'
      ORDER BY email`,
  ).bind(domainPattern(DEMO_CAST_EMAIL_DOMAIN)).all<{ id: string; name: string; email: string }>();
  return (rows.results ?? []).map((row) => ({ userId: row.id, name: row.name, email: row.email }));
}

/**
 * Read the cast as accounts, refusing any id that is not one of the people
 * above. Answers each of them, so the caller can check the demo's directory
 * for two people under one name.
 *
 * The presenter is excluded: they are checked against the template instead,
 * which is the stricter question. The refusal's status is the caller's,
 * because the same question means two different things — a start request
 * naming somebody who is not a colleague is a bad request, and a stored cast
 * that has stopped being one is a conflict with what the row says.
 */
export async function readDemoCast(env: Env, input: {
  cast: Readonly<Record<DemoPackRole, string>>;
  presenterRole: DemoPackRole | null;
  status: 422 | 409;
}): Promise<Record<DemoPackRole, DemoCastCandidate>> {
  const read: Record<DemoPackRole, DemoCastCandidate> = {};
  for (const [role, userId] of Object.entries(input.cast)) {
    if (role === input.presenterRole) continue;
    const person = await env.DB.prepare(
      `SELECT id, name, email FROM users
        WHERE id = ? AND platform_user_id IS NOT NULL AND email LIKE ? ESCAPE '\\'`,
    ).bind(userId, domainPattern(DEMO_CAST_EMAIL_DOMAIN))
      .first<{ id: string; name: string; email: string }>();
    if (!person) {
      throw new ApiError(
        input.status,
        "demo_cast_not_a_colleague",
        `The person cast as "${role}" is not a @${DEMO_CAST_EMAIL_DOMAIN} account in this region`,
      );
    }
    read[role] = { userId: person.id, name: person.name, email: person.email };
  }
  return read;
}
