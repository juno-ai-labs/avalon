/**
 * The account an email address names, and its place in one Organization: what
 * `addMember` and `offer_to_add_member` both ask. Only a verified address
 * names an account, the rule sign-in keeps (`resolveVerifiedEmailIdentity`):
 * an account holding the address unverified is reported as such, never
 * returned, since adding it would add whoever typed that profile address.
 */
export async function memberByAddress(db: D1Database, workspaceId: string, email: string): Promise<
  | { kind: "account"; id: string; name: string; status: string | null; accessClass: string | null }
  | { kind: "held_unverified" }
  | { kind: "none" }
> {
  const account = await db.prepare(
    `SELECT u.id, u.name, m.status, m.access_class FROM user_verified_emails v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?
      WHERE v.email = ? COLLATE NOCASE`,
  ).bind(workspaceId, email).first<{ id: string; name: string; status: string | null; access_class: string | null }>();
  if (account) return { kind: "account", id: account.id, name: account.name, status: account.status, accessClass: account.access_class };
  const unverified = await db.prepare(`SELECT 1 AS held FROM users WHERE email = ? COLLATE NOCASE`).bind(email).first<{ held: number }>();
  return unverified ? { kind: "held_unverified" } : { kind: "none" };
}
