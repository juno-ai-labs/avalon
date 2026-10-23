import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asUserId, asWorkspaceId, WorkspaceExternalEventMatchResultSchema } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/**
 * Synthetic events from five connectors against rules of every shape the
 * evaluator vocabulary allows, through the workspace's real ledger and
 * matcher. Nothing here runs an automation: what is proved is which
 * destination hears which event, which is the whole of routing.
 */

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009d0");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000009d1");
const OTHER_MEMBER_ID = asUserId("00000000-0000-7000-8000-0000000009d2");
const SESSION_ID = "00000000-0000-7000-8000-0000000009d3";
const NOW = "2026-09-04T09:00:00.000Z";

const CONNECTIONS = {
  github: { id: "00000000-0000-7000-8000-0000000009e1", plugin: "plugin_github" },
  linear: { id: "00000000-0000-7000-8000-0000000009e2", plugin: "plugin_linear" },
  notion: { id: "00000000-0000-7000-8000-0000000009e3", plugin: "plugin_notion" },
  slack: { id: "00000000-0000-7000-8000-0000000009e4", plugin: "plugin_slack" },
  generic_webhook: { id: "00000000-0000-7000-8000-0000000009e5", plugin: "plugin_webhook" },
} as const;
type Connector = keyof typeof CONNECTIONS;

/** Destinations: automations named by id; their directory rows say who may hear a restricted event. */
const AUTOMATIONS = {
  prOpened: "00000000-0000-7000-8000-0000000009f1",
  urgentLinear: "00000000-0000-7000-8000-0000000009f2",
  roadmapNotion: "00000000-0000-7000-8000-0000000009f3",
  deployChat: "00000000-0000-7000-8000-0000000009f4",
  slowDeploys: "00000000-0000-7000-8000-0000000009f5",
  assignedToAuthor: "00000000-0000-7000-8000-0000000009f6",
  personalOfOther: "00000000-0000-7000-8000-0000000009f7",
  workspaceWide: "00000000-0000-7000-8000-0000000009f8",
  unlabelled: "00000000-0000-7000-8000-0000000009f9",
} as const;

let eventOrdinal = 0;

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

async function seed(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,name) VALUES (?,'Other member')").bind(OTHER_MEMBER_ID),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status) VALUES (?,?,'member','active')")
      .bind(WORKSPACE_ID, OTHER_MEMBER_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => {
    for (const [connector, connection] of Object.entries(CONNECTIONS)) {
      state.storage.sql.exec(
        `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, display_name,
            status, config_json, created_at, updated_at, model_plugin_id)
         VALUES (?, ?, ?, 'workspace', NULL, ?, 'healthy', '{}', ?, ?, ?)`,
        connection.id, WORKSPACE_ID, connector, `${connector} fixture`, NOW, NOW, connection.plugin,
      );
    }
  });
  for (const id of Object.values(AUTOMATIONS)) {
    await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: id,
      authorUserId: id === AUTOMATIONS.personalOfOther ? OTHER_MEMBER_ID : AUTHOR_ID,
      scope: id === AUTOMATIONS.workspaceWide ? "workspace" : "personal", owningWorkstreamId: null,
      authorityGeneration: 1 });
    // Routing needs active authority, without publishing a workflow to execute.
    await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "UPDATE automation_directory SET lifecycle='active',title=? WHERE automation_id=?", id, id));
  }
}

type Evaluator = {
  evaluatorId: string;
  source: { connectorType: Connector; connectionId: string; eventType: string };
  when: unknown;
};

async function register(automationId: string, evaluators: Evaluator[]): Promise<void> {
  await workspace().applyExternalEventRegistrations({
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    destination: { kind: "automation", automationId },
    evaluators,
  });
}

function rule(
  automationId: string,
  ordinal: number,
  connector: Connector,
  eventType: string,
  when: unknown,
): Evaluator {
  return {
    evaluatorId: `${automationId.slice(0, -2)}${String(ordinal).padStart(2, "0")}`.replace(/.{2}$/u, `a${ordinal}`),
    source: { connectorType: connector, connectionId: CONNECTIONS[connector].id, eventType },
    when,
  };
}

async function ingest(
  connector: Connector,
  eventType: string,
  input: {
    metadata?: Record<string, unknown>;
    textSnippet?: string;
    targetUserIds?: string[];
    visibility?: Record<string, unknown>;
  } = {},
): Promise<string> {
  eventOrdinal += 1;
  const eventId = `00000000-0000-7000-8000-00000000${(0x9d00 + eventOrdinal).toString(16).padStart(4, "0")}`;
  await workspace().ingestConnectorEvent({
    workspaceId: WORKSPACE_ID,
    ingressEventId: eventId,
    payloadHash: `sha256:${eventOrdinal.toString(16).padStart(2, "0").repeat(32)}`,
    event: {
      connectorType: connector,
      activity: {
        id: eventId,
        workspaceId: WORKSPACE_ID,
        region: "global",
        connectionId: CONNECTIONS[connector].id,
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: connector,
        providerEventId: `provider-${eventOrdinal}`,
        eventType,
        resourceType: null,
        providerResourceId: null,
        actor: {},
        subject: {},
        occurredAt: NOW,
        receivedAt: NOW,
        title: `${connector} ${eventType}`,
        summary: "",
        textSnippet: input.textSnippet ?? "",
        payloadRef: null,
        visibility: input.visibility ?? { kind: "workspace" },
        targetUserIds: input.targetUserIds ?? [],
        entityKeys: [],
        dedupeKey: `${connector}:${eventOrdinal}`,
        rawContentHash: null,
        metadata: input.metadata ?? {},
        externalPeople: [],
      },
    },
  });
  return eventId;
}

async function matchFor(eventId: string) {
  return WorkspaceExternalEventMatchResultSchema.parse(
    await workspace().matchExternalEventDestinations({ workspaceId: WORKSPACE_ID, eventId }),
  );
}

async function destinationsFor(eventId: string): Promise<string[]> {
  const result = await matchFor(eventId);
  return result.deliveries
    .map((delivery) => (delivery.destination.kind === "automation" ? delivery.destination.automationId : "workstream"))
    .sort();
}

describe("external event rules across connectors", () => {
  beforeEach(async () => {
    await reset();
    eventOrdinal = 0;
    await seed();
  });

  it("routes on event type alone, the easiest rule, and only that type", async () => {
    await register(AUTOMATIONS.prOpened, [
      rule(AUTOMATIONS.prOpened, 1, "github", "github.pull_request.opened", { kind: "always" }),
    ]);

    const opened = await ingest("github", "github.pull_request.opened", { metadata: { number: 41 } });
    const closed = await ingest("github", "github.pull_request.closed", { metadata: { number: 41 } });
    const linear = await ingest("linear", "linear.issue.created");

    expect(await destinationsFor(opened)).toEqual([AUTOMATIONS.prOpened]);
    expect(await destinationsFor(closed)).toEqual([]);
    expect(await destinationsFor(linear)).toEqual([]);
  });

  it("hands the run the event it matched on: snippet and metadata ride the delivery", async () => {
    await register(AUTOMATIONS.slowDeploys, [
      rule(AUTOMATIONS.slowDeploys, 1, "generic_webhook", "deploy.finished", { kind: "always" }),
    ]);
    const eventId = await ingest("generic_webhook", "deploy.finished", {
      textSnippet: "checkout deployed in 7 minutes",
      metadata: { service: "checkout", durationMs: 420_000 },
    });

    const [delivery] = (await matchFor(eventId)).deliveries;

    // What the rule selected on is what the run gets to read; a run that saw
    // only the event type could not name the service its rule was about.
    expect(delivery?.event).toMatchObject({
      id: eventId,
      textSnippet: "checkout deployed in 7 minutes",
      metadata: { service: "checkout", durationMs: 420_000 },
    });
  });

  it("combines string, string-set, number, boolean and presence leaves as one AND group", async () => {
    await register(AUTOMATIONS.urgentLinear, [
      rule(AUTOMATIONS.urgentLinear, 1, "linear", "linear.issue.updated", {
        kind: "all",
        allOf: [
          { kind: "string", attribute: "state", operator: "in", value: ["In Progress", "Todo"] },
          { kind: "string_array", attribute: "labels", operator: "has_any", value: ["urgent", "p0"] },
          { kind: "number", attribute: "priority", operator: "less_than_or_equals", value: 2 },
          { kind: "boolean", attribute: "archived", operator: "equals", value: false },
          { kind: "presence", attribute: "assignee", operator: "exists" },
        ],
      }),
    ]);
    const base = { state: "Todo", labels: ["p0", "backend"], priority: 1, archived: false, assignee: "ada" };

    const matching = await ingest("linear", "linear.issue.updated", { metadata: base });
    const wrongState = await ingest("linear", "linear.issue.updated", { metadata: { ...base, state: "Done" } });
    const noLabel = await ingest("linear", "linear.issue.updated", { metadata: { ...base, labels: ["backend"] } });
    const lowPriority = await ingest("linear", "linear.issue.updated", { metadata: { ...base, priority: 3 } });
    const archived = await ingest("linear", "linear.issue.updated", { metadata: { ...base, archived: true } });
    const unassigned = await ingest("linear", "linear.issue.updated", {
      metadata: { state: "Todo", labels: ["p0"], priority: 1, archived: false },
    });

    expect(await destinationsFor(matching)).toEqual([AUTOMATIONS.urgentLinear]);
    for (const miss of [wrongState, noLabel, lowPriority, archived, unassigned]) {
      expect(await destinationsFor(miss)).toEqual([]);
    }
  });

  it("reads message text and nested-looking metadata the way the context flattens it", async () => {
    // Only scalar and string-array metadata fields reach the context, plus
    // the snippet as `messageText`; a nested object is not addressable.
    await register(AUTOMATIONS.roadmapNotion, [
      rule(AUTOMATIONS.roadmapNotion, 1, "notion", "notion.page.updated", {
        kind: "all",
        allOf: [
          { kind: "string", attribute: "pageTitle", operator: "contains", value: "Roadmap" },
          { kind: "number", attribute: "changedProperties", operator: "greater_than", value: 2 },
          { kind: "presence", attribute: "parent", operator: "not_exists" },
        ],
      }),
    ]);
    await register(AUTOMATIONS.deployChat, [
      rule(AUTOMATIONS.deployChat, 1, "slack", "slack.message.posted", {
        kind: "all",
        allOf: [
          { kind: "string", attribute: "messageText", operator: "contains", value: "deploy" },
          { kind: "string", attribute: "channel", operator: "starts_with", value: "eng-" },
          { kind: "string", attribute: "channel", operator: "not_in", value: ["eng-random"] },
        ],
      }),
    ]);

    const roadmap = await ingest("notion", "notion.page.updated", {
      metadata: { pageTitle: "Q4 Roadmap", changedProperties: 3, parent: { id: "nested" } },
    });
    const roadmapTop = await ingest("notion", "notion.page.updated", {
      metadata: { pageTitle: "Q4 Roadmap", changedProperties: 3 },
    });
    const smallEdit = await ingest("notion", "notion.page.updated", {
      metadata: { pageTitle: "Q4 Roadmap", changedProperties: 1 },
    });
    const deployTalk = await ingest("slack", "slack.message.posted", {
      textSnippet: "starting the deploy of checkout now",
      metadata: { channel: "eng-platform" },
    });
    const randomTalk = await ingest("slack", "slack.message.posted", {
      textSnippet: "deploy memes",
      metadata: { channel: "eng-random" },
    });
    const wrongChannel = await ingest("slack", "slack.message.posted", {
      textSnippet: "deploy done",
      metadata: { channel: "sales" },
    });

    // The nested `parent` object is dropped by the context, so `not_exists`
    // holds for both pages; this pins that a rule cannot see into an object.
    expect(await destinationsFor(roadmap)).toEqual([AUTOMATIONS.roadmapNotion]);
    expect(await destinationsFor(roadmapTop)).toEqual([AUTOMATIONS.roadmapNotion]);
    expect(await destinationsFor(smallEdit)).toEqual([]);
    expect(await destinationsFor(deployTalk)).toEqual([AUTOMATIONS.deployChat]);
    expect(await destinationsFor(randomTalk)).toEqual([]);
    expect(await destinationsFor(wrongChannel)).toEqual([]);
  });

  it("delivers one event to every destination whose rule holds, across event types of one connector", async () => {
    await register(AUTOMATIONS.slowDeploys, [
      rule(AUTOMATIONS.slowDeploys, 1, "generic_webhook", "deploy.finished", {
        kind: "all",
        allOf: [
          { kind: "string", attribute: "service", operator: "equals", value: "checkout" },
          { kind: "number", attribute: "durationMs", operator: "greater_than", value: 300_000 },
        ],
      }),
      // A second rule on another event type of the same connection: OR across
      // event types is two rules, which is the only OR the contract has.
      rule(AUTOMATIONS.slowDeploys, 2, "generic_webhook", "deploy.failed", { kind: "always" }),
    ]);
    await register(AUTOMATIONS.workspaceWide, [
      rule(AUTOMATIONS.workspaceWide, 1, "generic_webhook", "deploy.finished", { kind: "always" }),
    ]);

    const slow = await ingest("generic_webhook", "deploy.finished", { metadata: { service: "checkout", durationMs: 420_000 } });
    const fast = await ingest("generic_webhook", "deploy.finished", { metadata: { service: "checkout", durationMs: 12_000 } });
    const failed = await ingest("generic_webhook", "deploy.failed", { metadata: { service: "search" } });

    expect(await destinationsFor(slow)).toEqual([AUTOMATIONS.slowDeploys, AUTOMATIONS.workspaceWide].sort());
    expect(await destinationsFor(fast)).toEqual([AUTOMATIONS.workspaceWide]);
    expect(await destinationsFor(failed)).toEqual([AUTOMATIONS.slowDeploys]);
  });

  it("names people by id, and keeps a restricted event away from an automation its audience cannot read", async () => {
    await register(AUTOMATIONS.assignedToAuthor, [
      rule(AUTOMATIONS.assignedToAuthor, 1, "github", "github.issue.assigned", {
        kind: "all",
        allOf: [
          { kind: "person_id", attribute: "assigneePersonId", operator: "equals", value: AUTHOR_ID },
          { kind: "person_id_array", attribute: "reviewerPersonIds", operator: "has_none", value: [OTHER_MEMBER_ID] },
        ],
      }),
    ]);
    await register(AUTOMATIONS.personalOfOther, [
      rule(AUTOMATIONS.personalOfOther, 1, "github", "github.issue.assigned", { kind: "always" }),
    ]);
    await register(AUTOMATIONS.workspaceWide, [
      rule(AUTOMATIONS.workspaceWide, 1, "github", "github.issue.assigned", { kind: "always" }),
    ]);

    const toAuthor = await ingest("github", "github.issue.assigned", {
      metadata: { assigneePersonId: AUTHOR_ID, reviewerPersonIds: [] },
    });
    const reviewedByOther = await ingest("github", "github.issue.assigned", {
      metadata: { assigneePersonId: AUTHOR_ID, reviewerPersonIds: [OTHER_MEMBER_ID] },
    });
    // Restricted events require an eligible delegate in their actual audience,
    // for both personal and Organization-owned Sidekicks.
    const restrictedToAuthor = await ingest("github", "github.issue.assigned", {
      metadata: { assigneePersonId: AUTHOR_ID, reviewerPersonIds: [] },
      visibility: { kind: "restricted" },
      targetUserIds: [AUTHOR_ID],
    });

    expect(await destinationsFor(toAuthor))
      .toEqual([AUTOMATIONS.assignedToAuthor, AUTOMATIONS.personalOfOther, AUTOMATIONS.workspaceWide].sort());
    expect(await destinationsFor(reviewedByOther))
      .toEqual([AUTOMATIONS.personalOfOther, AUTOMATIONS.workspaceWide].sort());
    expect(await destinationsFor(restrictedToAuthor)).toEqual([AUTOMATIONS.assignedToAuthor, AUTOMATIONS.workspaceWide].sort());
  });

  it("does not hear an event that arrived before the rule, and hears nothing after the rule is replaced", async () => {
    const early = await ingest("linear", "linear.issue.created");
    await register(AUTOMATIONS.unlabelled, [
      rule(AUTOMATIONS.unlabelled, 1, "linear", "linear.issue.created", { kind: "always" }),
    ]);
    const late = await ingest("linear", "linear.issue.created");
    expect(await destinationsFor(early)).toEqual([]);
    expect(await destinationsFor(late)).toEqual([AUTOMATIONS.unlabelled]);

    // A complete replacement, as pause and re-apply do: the old rule is gone.
    await register(AUTOMATIONS.unlabelled, []);
    const afterRemoval = await ingest("linear", "linear.issue.created");
    expect(await destinationsFor(afterRemoval)).toEqual([]);
  });

  it("treats a missing attribute as a miss for every leaf but presence, and a type mismatch as a miss", async () => {
    await register(AUTOMATIONS.unlabelled, [
      rule(AUTOMATIONS.unlabelled, 1, "slack", "slack.reaction.added", {
        kind: "all",
        allOf: [{ kind: "number", attribute: "count", operator: "greater_than", value: 1 }],
      }),
      rule(AUTOMATIONS.unlabelled, 2, "slack", "slack.message.posted", {
        kind: "all",
        allOf: [{ kind: "presence", attribute: "threadTs", operator: "not_exists" }],
      }),
    ]);

    const noCount = await ingest("slack", "slack.reaction.added", { metadata: { emoji: "eyes" } });
    const stringCount = await ingest("slack", "slack.reaction.added", { metadata: { count: "3" } });
    const realCount = await ingest("slack", "slack.reaction.added", { metadata: { count: 3 } });
    const topLevel = await ingest("slack", "slack.message.posted", { metadata: { channel: "eng" } });
    const inThread = await ingest("slack", "slack.message.posted", { metadata: { threadTs: "1.2" } });

    expect(await destinationsFor(noCount)).toEqual([]);
    expect(await destinationsFor(stringCount)).toEqual([]);
    expect(await destinationsFor(realCount)).toEqual([AUTOMATIONS.unlabelled]);
    expect(await destinationsFor(topLevel)).toEqual([AUTOMATIONS.unlabelled]);
    expect(await destinationsFor(inThread)).toEqual([]);
  });

  it("names the offending field when a malformed projection is rejected across the RPC boundary", async () => {
    // What the caller is left holding is the whole point. `replaceRegistrations`
    // calls this over a Durable Object RPC hop, and the serializer reduces a
    // `ZodError` to a bare `Error` — no `issues`, no derived message, not even
    // the name — so a `sidekick_publication` alarm retrying against a malformed
    // projection logged the bare word `ZodError` and nothing else. Only the
    // message text crosses, so the paths have to be in it.
    const rejection = await register(AUTOMATIONS.unlabelled, [
      { ...rule(AUTOMATIONS.unlabelled, 1, "linear", "linear.issue.created", { kind: "always" }), source: { connectorType: "linear", connectionId: 7 } },
    ] as unknown as Evaluator[]).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain("external_event_registration_projection_invalid");
    expect(message).toContain("evaluators.0.source");
  });
});
