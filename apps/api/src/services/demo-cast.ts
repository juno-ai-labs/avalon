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
 * The company's own email domain — the one its people sign in to Rally with,
 * which is not the one the product is served from and not the one the
 * Cloudflare Access policy on the internal tools names. Demos are cast from
 * the accounts on it and from nobody else, so this is the one place it is
 * written down and changing it changes who may be seated in a demo workspace.
 */
export const DEMO_CAST_EMAIL_DOMAIN = "rallywith.ai";

/** One person a role can be played by. */
export interface DemoCastCandidate {
  userId: string;
  name: string;
  email: string;
}

/**
 * What makes somebody castable: an account on the domain that has signed in.
 * One predicate, used by the list the form is built from and by the read that
 * checks what the form sent, so the two cannot drift into disagreeing about
 * who is a colleague.
 */
const CASTABLE = `platform_user_id IS NOT NULL AND email LIKE ? ESCAPE '\\'`;

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
 * Everyone a cast role may be played by. Ordered the way the form shows them —
 * by name, with the address breaking a tie between two people who share one —
 * so a dropdown an operator scans reads as sorted rather than as arbitrary.
 */
export async function listDemoCastCandidates(env: Env): Promise<DemoCastCandidate[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, email FROM users WHERE ${CASTABLE} ORDER BY name, email`,
  ).bind(domainPattern(DEMO_CAST_EMAIL_DOMAIN)).all<{ id: string; name: string; email: string }>();
  return (rows.results ?? []).map((row) => ({ userId: row.id, name: row.name, email: row.email }));
}

/**
 * Read the cast as accounts, refusing any id that is not one of the people
 * above. Answers each of them, so the caller can check the demo's directory
 * for two people under one name.
 *
 * The presenter is excluded: they are checked against the template instead,
 * which is the stricter question. In a start request the cast never carries
 * them — naming the presenter's role is refused outright — but a stored cast
 * does, and this is the read `checking_template` makes of it.
 *
 * One statement for the whole cast rather than one per role: the roles are
 * few, but a query in a loop is a shape that grows with the pack.
 */
export async function readDemoCast(env: Env, input: {
  cast: Readonly<Record<DemoPackRole, string>>;
  presenterRole: DemoPackRole | null;
}): Promise<Record<DemoPackRole, DemoCastCandidate>> {
  const wanted = Object.entries(input.cast).filter(([role]) => role !== input.presenterRole);
  if (wanted.length === 0) return {};
  const ids = [...new Set(wanted.map(([, userId]) => userId))];
  const rows = await env.DB.prepare(
    `SELECT id, name, email FROM users
      WHERE ${CASTABLE} AND id IN (${ids.map(() => "?").join(", ")})`,
  ).bind(domainPattern(DEMO_CAST_EMAIL_DOMAIN), ...ids)
    .all<{ id: string; name: string; email: string }>();
  const colleagues = new Map((rows.results ?? []).map((row) => [row.id, row]));
  const read: Record<DemoPackRole, DemoCastCandidate> = {};
  for (const [role, userId] of wanted) {
    const person = colleagues.get(userId);
    if (!person) {
      throw new ApiError(
        422,
        "demo_cast_not_a_colleague",
        `The person cast as "${role}" is not a @${DEMO_CAST_EMAIL_DOMAIN} account in this region`,
      );
    }
    read[role] = { userId: person.id, name: person.name, email: person.email };
  }
  return read;
}

/**
 * Refuse two people in one demo under one display name.
 *
 * A mention resolves to a user id, but what the room validates it against is
 * the visible text, and nobody watching can tell which of two identically
 * named people was named — the presenter reading their own name on somebody
 * else's message worst of all. Checked when the demo is started and again
 * before the first write, because a name is not fixed: it is refreshed from
 * the platform identity every time somebody signs in, so two people can
 * collide between a start request and the phase that acts on it, and a retry
 * can be days later.
 */
export function assertDemoCastNamesDistinct(names: readonly string[]): void {
  const folded = names.map((name) => name.toLowerCase());
  if (new Set(folded).size === folded.length) return;
  throw new ApiError(
    422,
    "demo_cast_name_duplicate",
    "Two people in this demo have the same name; nobody watching could tell which of them a mention names",
  );
}
