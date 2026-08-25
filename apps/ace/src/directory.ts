import type { Env } from './env';

export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  region: 'global' | 'eu';
}

export interface DirectoryWorkspace {
  id: string;
  name: string;
  slug: string;
  region: 'global' | 'eu';
}

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
  const result = await db.prepare(
    `SELECT id, name, slug FROM workspaces
      WHERE name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\'
      ORDER BY name`,
  ).bind(like(query), like(query)).all<{ id: string; name: string; slug: string }>();
  return (result.results ?? []).map((row) => ({ ...row, region }));
}

export async function searchUsers(env: Env, query: string): Promise<DirectoryUser[]> {
  const [global, eu] = await Promise.all([
    users(env.GLOBAL_DB, 'global', query),
    users(env.EU_DB, 'eu', query),
  ]);
  return [...global, ...eu];
}

export async function searchWorkspaces(env: Env, query: string): Promise<DirectoryWorkspace[]> {
  const [global, eu] = await Promise.all([
    workspaces(env.GLOBAL_DB, 'global', query),
    workspaces(env.EU_DB, 'eu', query),
  ]);
  return [...global, ...eu];
}
