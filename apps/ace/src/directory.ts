import { z } from 'zod';
import type { Env } from './env';

export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  region: 'global' | 'eu';
}

/** One workspace row as the page reads it; the page parses the answer with this rather than trusting it. */
export const DirectoryWorkspaceSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  region: z.enum(['global', 'eu']),
});
export type DirectoryWorkspace = z.infer<typeof DirectoryWorkspaceSchema>;

export type DirectoryRegion = 'global' | 'eu';

/**
 * A workspace search over both regions. A region that did not answer is named
 * rather than folded into an empty list: an operator about to retire a
 * workspace has to know the list is short because a directory was down, not
 * because the workspace does not exist.
 */
export const WorkspaceSearchResultSchema = z.strictObject({
  results: z.array(DirectoryWorkspaceSchema),
  unavailableRegions: z.array(z.enum(['global', 'eu'])),
});
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultSchema>;

function like(query: string): string {
  return `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

async function users(db: D1Database, region: 'global' | 'eu', query: string): Promise<DirectoryUser[]> {
  const result = await db.prepare(
    `SELECT platform_user_id AS id, email, name
       FROM users
      WHERE platform_user_id IS NOT NULL
        AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
      ORDER BY email`,
  ).bind(like(query), like(query)).all<{ id: string; email: string; name: string }>();
  return (result.results ?? []).map((row) => ({ ...row, region }));
}

async function workspaces(
  db: D1Database,
  region: 'global' | 'eu',
  query: string,
): Promise<DirectoryWorkspace[]> {
  // By id as well as by name or slug: the retirement form asks the operator to
  // paste the workspace id, and the id is often what they were handed.
  const result = await db.prepare(
    `SELECT id, name, slug FROM workspaces
      WHERE name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR id = ?
      ORDER BY name`,
  ).bind(like(query), like(query), query).all<{ id: string; name: string; slug: string }>();
  return (result.results ?? []).map((row) => ({ ...row, region }));
}

export async function searchUsers(env: Env, query: string): Promise<DirectoryUser[]> {
  const [global, eu] = await Promise.all([
    users(env.GLOBAL_DB, 'global', query),
    users(env.EU_DB, 'eu', query),
  ]);
  return [...global, ...eu];
}

export async function searchWorkspaces(env: Env, query: string): Promise<WorkspaceSearchResult> {
  // Settled, not raced: one region's outage must not blank the other's rows,
  // and it must be reported rather than read as "no matches".
  const settled = await Promise.allSettled([
    workspaces(env.GLOBAL_DB, 'global', query),
    workspaces(env.EU_DB, 'eu', query),
  ]);
  const regions: DirectoryRegion[] = ['global', 'eu'];
  const results: DirectoryWorkspace[] = [];
  const unavailableRegions: DirectoryRegion[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') results.push(...outcome.value);
    else unavailableRegions.push(regions[index]!);
  });
  if (unavailableRegions.length === regions.length) throw new Error('directory_unavailable');
  return { results, unavailableRegions };
}
