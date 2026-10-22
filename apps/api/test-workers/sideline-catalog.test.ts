import { seedParticipantGrants } from "./helpers/hosted-parent";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Sideline catalog, built against the real Organization object.
 *
 * Every Channel is a hosted parent of that one object, so the Breakouts a
 * person can open across all of their Channels are one read per person. The
 * catalog used to ask once per Channel per person; this pins both what it
 * lists and how many round trips it spends doing so.
 * `docs/impersonation.md` owns the catalog.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AuthContext } from "../src/env";
import { uuidV7 } from "../src/lib/uuid-v7";
import { ImpersonationService } from "../src/services/impersonation-service";
import { countingEnv } from "./helpers/counting-namespace";
import { hostedParentStub, insertChannelRow } from "./helpers/hosted-parent";

/** Its own workspace: object names are shared across files, storage is not. */
const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000c500");
const operatorId = asUserId("00000000-0000-7000-8000-00000000c501");
const representedId = asUserId("00000000-0000-7000-8000-00000000c502");
const channels = [
  { id: asWorkstreamId("00000000-0000-7000-8000-00000000c5a0"), title: "Launch", breakout: asSubstreamId("00000000-0000-7000-8000-00000000c5a1"), members: [operatorId] },
  { id: asWorkstreamId("00000000-0000-7000-8000-00000000c5b0"), title: "Hiring", breakout: asSubstreamId("00000000-0000-7000-8000-00000000c5b1"), members: [representedId] },
  { id: asWorkstreamId("00000000-0000-7000-8000-00000000c5c0"), title: "Research", breakout: asSubstreamId("00000000-0000-7000-8000-00000000c5c1"), members: [operatorId, representedId] },
] as const;

const operator: AuthContext = {
  sessionId: "sideline-catalog-session",
  userId: operatorId,
  workspaceId,
  region: "global",
  role: "member",
};

const organization = () => hostedParentStub(env, workspaceId);

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, avatar_url TEXT)"),
    env.DB.prepare("INSERT INTO users VALUES (?, 'Operator', 'operator@rallywith.ai', NULL)").bind(operatorId),
    env.DB.prepare("INSERT INTO users VALUES (?, 'Participant', 'participant@example.test', NULL)").bind(representedId),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, abandoned_at TEXT,
      region TEXT DEFAULT 'global', placement_affinity TEXT DEFAULT 'wnam')`),
    env.DB.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'Rally Test')").bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT, status TEXT,
      incarnation TEXT DEFAULT 'existing-member', revision INTEGER DEFAULT 1, access_class TEXT DEFAULT 'member')`),
    ...[operatorId, representedId].map((userId) => env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id, user_id, role, status) VALUES (?, ?, 'member', 'active')",
    ).bind(workspaceId, userId)),
  ]);
  await organization().initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(organization(), (_instance, state) => {
    for (const channel of channels) {
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, channel.id, workspaceId);
      insertChannelRow(state, channel.id, channel.title, "workspace");
      // The directory page parses its event ids; the helper's placeholder is not one.
      state.storage.sql.exec("UPDATE channels SET source_event_id = ? WHERE workstream_id = ?", uuidV7(), channel.id);
      state.storage.sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_at, title, created_by_user_id)
        VALUES (?, '0', 'main', 0, 'Main', ?), (?, ?, 'child', 0, ?, ?)`,
      channel.id, operatorId, channel.id, channel.breakout, `${channel.title} breakout`, operatorId);
      for (const userId of channel.members) {
        state.storage.sql.exec(`INSERT INTO parent_breakout_members
          (parent_id, substream_id, user_id, active, version, added_by_user_id, added_at, updated_at)
          VALUES (?, ?, ?, 1, 1, ?, 0, 0)`, channel.id, channel.breakout, userId, operatorId);
      }
    }
  });
  for (const channel of channels) await seedParticipantGrants(env, workspaceId, channel.id, channel.members, channel.breakout);
  await organization().upsertImpersonationRelationships({
    workspaceId,
    relationships: [{ impersonatorUserId: operatorId, representedUserId: representedId, authorityBasis: "support:approved" }],
  });
});

describe("Sideline catalog", () => {
  it("lists each person's Channels and their own Breakouts with one Breakout read per person", async () => {
    const calls: string[] = [];

    const catalog = await new ImpersonationService(countingEnv(calls), operator).catalog();

    const main = (index: number) => ({
      workstreamId: channels[index]!.id, substreamId: "0", label: channels[index]!.title, workstreamLabel: channels[index]!.title,
    });
    const breakout = (index: number) => ({
      workstreamId: channels[index]!.id, substreamId: channels[index]!.breakout,
      label: `${channels[index]!.title} breakout`, workstreamLabel: channels[index]!.title,
    });
    const destinations = (userId: string) => Object.fromEntries(catalog.participants
      .find((participant) => participant.userId === userId)!.destinations
      .map((destination) => [`${destination.workstreamId}:${destination.substreamId}`, destination]));
    expect(catalog.participants.map((participant) => participant.userId)).toEqual([operatorId, representedId]);
    // Each person sees every workspace Channel's Main, and only the Breakouts
    // they belong to — nobody else's, and no Channel's Breakout under another.
    expect(destinations(operatorId)).toEqual(Object.fromEntries([main(0), breakout(0), main(1), main(2), breakout(2)]
      .map((destination) => [`${destination.workstreamId}:${destination.substreamId}`, destination])));
    expect(destinations(representedId)).toEqual(Object.fromEntries([main(0), main(1), breakout(1), main(2), breakout(2)]
      .map((destination) => [`${destination.workstreamId}:${destination.substreamId}`, destination])));
    // A Breakout follows its own Channel's Main in the list.
    for (const participant of catalog.participants) {
      participant.destinations.forEach((destination, index) => {
        if (destination.substreamId !== "0") {
          expect(participant.destinations[index - 1]).toMatchObject({ workstreamId: destination.workstreamId, substreamId: "0" });
        }
      });
    }
    // Three Channels, two people: one Breakout read per person, not one per Channel.
    expect(calls.filter((call) => call === "listVisiblePrivateChildrenForParents")).toHaveLength(2);
  });
});
