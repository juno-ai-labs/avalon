/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { expect, it } from "vitest";
import { asUserId } from "@rally/contracts";
import { BrowserSessionService } from "../src/services/browser-session-service";
import { issueAccessToken } from "../src/services/auth-service";

it("converges concurrent browser activation in real D1 without changing another tab's session",async () => {
  await reset();
  const userId = asUserId(crypto.randomUUID()), rootId = crypto.randomUUID();
  const first = crypto.randomUUID(), second = crypto.randomUUID(), at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,name TEXT,avatar_url TEXT,timezone TEXT,created_at TEXT,analytics_person_id TEXT)"),
    env.DB.prepare("CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,slug TEXT,region TEXT,timezone TEXT,created_at TEXT,abandoned_at TEXT,analytics_workspace_id TEXT)"),
    env.DB.prepare(`CREATE TABLE workspace_members(workspace_id TEXT,user_id TEXT,status TEXT,role TEXT,access_class TEXT,
      incarnation TEXT,revision INTEGER DEFAULT 1,joined_at TEXT,last_seen_at TEXT,PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare(`CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,workspace_id TEXT,region TEXT,refresh_token_hash TEXT,
      previous_refresh_token_hash TEXT,refresh_rotated_at TEXT,expires_at TEXT,created_at TEXT,revoked_at TEXT,workspace_incarnation TEXT)`),
    env.DB.prepare(`CREATE TRIGGER bind_session_incarnation AFTER INSERT ON sessions WHEN NEW.workspace_id IS NOT NULL
      BEGIN UPDATE sessions SET workspace_incarnation=(SELECT incarnation FROM workspace_members
      WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id AND status='active') WHERE id=NEW.id; END`),
    env.DB.prepare("CREATE TABLE browser_sessions(session_id TEXT PRIMARY KEY,credential_hash TEXT UNIQUE)"),
    env.DB.prepare("CREATE TABLE browser_workspace_sessions(browser_session_id TEXT,workspace_id TEXT,session_id TEXT UNIQUE,PRIMARY KEY(browser_session_id,workspace_id))"),
    env.DB.prepare("INSERT INTO users(id,email,name,timezone,created_at) VALUES (?,'guest@example.test','Guest','UTC',?)").bind(userId,at),
    env.DB.prepare("INSERT INTO sessions(id,user_id,region,expires_at,created_at) VALUES (?,?,'global','2099-01-01T00:00:00.000Z',?)").bind(rootId,userId,at),
    ...[first,second].flatMap((id) => [
      env.DB.prepare("INSERT INTO workspaces(id,name,slug,region,timezone,created_at) VALUES (?,'Shared',?,'global','UTC',?)").bind(id,id,at),
      env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role,access_class,incarnation,joined_at) VALUES (?,?,'active',NULL,'guest',?,?)")
        .bind(id,userId,id,at),
    ]),
  ]);
  const service = new BrowserSessionService(env);
  const cookie = await service.register({ user:{ id:userId,email:"guest@example.test",name:"Guest",avatarUrl:null,timezone:"UTC",createdAt:at },
    workspace:null,apiBaseUrl:"https://api.test",expiresAt:"2099-01-01T00:00:00.000Z",refreshToken:"test-browser-root-credential",
    accessToken:await issueAccessToken(env,{ sessionId:rootId,userId,workspaceId:null,region:"global" }) });
  await Promise.all([first,first,second].map((workspaceId) => service.select(cookie.credential,workspaceId)));
  const one = await service.read(cookie.credential,first), two = await service.read(cookie.credential,second);
  expect(one.workspaceId).toBe(first);
  expect(two.workspaceId).toBe(second);
  expect(one.sessionId).not.toBe(two.sessionId);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").first()).toEqual({ n:3 });
  await env.DB.prepare("UPDATE workspace_members SET incarnation='replacement' WHERE workspace_id=?").bind(first).run();
  await expect(service.read(cookie.credential,first)).rejects.toMatchObject({ status:401 });
  await service.select(cookie.credential,first);
  expect((await service.read(cookie.credential,first)).sessionId).not.toBe(one.sessionId);
  expect((await service.read(cookie.credential,second)).sessionId).toBe(two.sessionId);
});
