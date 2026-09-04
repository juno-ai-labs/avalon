/**
 * SPIKE — throwaway. Not production code, not on the release path.
 *
 * The Tidepoint demo pack, and the seeder that plays it into a workspace.
 *
 * The rule this file exists to obey: **every seeded fact is written by calling
 * Rally's own production write path, as the persona who did it.** No
 * `POST /dev/seed-product`, no `seedFromFixture`, no `seedDevelopmentRun`, no
 * `seedDevelopmentReceipt`, no `seedDevelopmentConversationTurn`. A work stream
 * is created by `WorkstreamObjectCreationService`, a message by
 * `SubstreamAgent`'s `create_message`, a resource by `ResourceService.upload`,
 * an attachment by `attach_resource`, an assistant turn by an ordinary harness
 * run whose provider bytes are recorded rather than inferred.
 *
 * Two things the pack cannot get from a production path, both recorded in
 * SPIKE-REPORT.md:
 *
 * - **A persona user.** There is no product API that creates a member who never
 *   signs in. Identity and membership are regional D1's authority, so the rows
 *   are written here, with a `google_subject` sentinel that can never collide
 *   with a real Google subject (Google subjects are decimal digit strings).
 * - **A connector connection.** The only production writer is an OAuth
 *   callback, which needs a public HTTPS redirect. The pack does not need one:
 *   its connector tool calls are *recorded outcomes*, so the run registers
 *   fixture plugins instead and the receipts, plugin rows and durations are
 *   written by the production path.
 */
import {
  asHarnessRunId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
import { newId } from "@rally/db";

import { substreamAgentName, workspaceDOName, workstreamDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { ResourceService } from "../services/resource-service";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { WorkstreamObjectCreationService } from "../services/workstream-object-creation-service";
import { readWorkstreamAuthorityControl } from "../services/workstream-authority";
import type { ReplayContext, SpikeAssistantFixture } from "./replay";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * A member who exists so a demo has people in it, and who can never sign in.
 *
 * Google's `sub` is an opaque decimal string, so a `persona:` prefix cannot
 * collide with one. `upsertIdentity` matches on `google_subject`, so a real
 * sign-in can never resolve to one of these rows.
 */
export interface Persona {
  slug: string;
  name: string;
  email: string;
}

export const TIDEPOINT_PERSONAS: readonly Persona[] = [
  { slug: "priya-raman", name: "Priya Raman", email: "priya@tidepoint.example" },
  { slug: "marcus-hale", name: "Marcus Hale", email: "marcus@tidepoint.example" },
  { slug: "dana-okafor", name: "Dana Okafor", email: "dana@tidepoint.example" },
  { slug: "sam-lindqvist", name: "Sam Lindqvist", email: "sam@tidepoint.example" },
  { slug: "yusuf-benali", name: "Yusuf Benali", email: "yusuf@tidepoint.example" },
  { slug: "elena-park", name: "Elena Park", email: "elena@tidepoint.example" },
];

const CONNECTOR_FIXTURE_PLUGINS: SpikeAssistantFixture["plugins"] = [
  {
    modelId: "plugin_google_drive",
    shortWireName: "gdrive",
    displayName: "Google Drive",
    description: "Read documents in the workspace's Google Drive.",
    tools: [{ name: "drive_read_document", description: "Read one Drive document." }],
  },
  {
    modelId: "plugin_granola",
    shortWireName: "granola",
    displayName: "Granola",
    description: "Read meeting notes captured in Granola.",
    tools: [{ name: "granola_read_meeting_notes", description: "Read one meeting's notes." }],
  },
  {
    modelId: "plugin_linear",
    shortWireName: "linear",
    displayName: "Linear",
    description: "Search issues in Linear.",
    tools: [{ name: "linear_search_issues", description: "Search Linear issues." }],
  },
];

/** Work stream A: the decision memo, with three recorded connector reads. */
function decisionMemoFixture(documentTitle: string): SpikeAssistantFixture {
  return {
    plugins: CONNECTOR_FIXTURE_PLUGINS,
    elicitationTargetUserId: null,
    turns: [
      {
        kind: "tools",
        calls: [
          {
            id: "call_drive_q4_plan",
            pluginModelId: "plugin_google_drive",
            toolName: "drive_read_document",
            arguments: { documentId: "1kQ4PlanTidepoint", title: "Q4 Plan — Tidepoint" },
            result: [
              "Q4 Plan — Tidepoint (Google Doc, last edited 11 days ago)",
              "",
              "Insights is priced as a $12k/yr add-on. Q4 target is 18 attached accounts.",
              "Open question in the plan: whether to fold Insights into the Growth tier at",
              "$4k uplift instead of selling it separately. Finance modelled both; the",
              "bundled case reaches the revenue target at 41 accounts.",
            ].join("\n"),
            summary: "Read Q4 Plan — Tidepoint",
            durationMs: 900,
          },
          {
            id: "call_granola_pricing_call",
            pluginModelId: "plugin_granola",
            toolName: "granola_read_meeting_notes",
            arguments: { meeting: "Pricing sync", within: "last 7 days" },
            result: [
              "Pricing sync — 6 days ago, 42 min, 5 attendees",
              "",
              "- Sales say the separate line item is what stalls the deal, not the number.",
              "- Two renewals this quarter asked for Insights to be included.",
              "- Finance will not model a bundle that lowers ARPA below $31k.",
              "- Agreed: decide before the Northgate renewal closes.",
            ].join("\n"),
            summary: "Read notes from Pricing sync",
            durationMs: 640,
          },
          {
            id: "call_linear_pricing_issues",
            pluginModelId: "plugin_linear",
            toolName: "linear_search_issues",
            arguments: { query: "pricing", state: "open" },
            result: [
              "4 open issues matching \"pricing\":",
              "- TID-412 Insights pricing page still shows the old add-on number (P2)",
              "- TID-431 Bundle SKU does not exist in billing (P1, blocks a bundled launch)",
              "- TID-455 Renewal quotes hand-built for Insights attach (P2)",
              "- TID-467 Usage metering for Insights is estimated, not measured (P3)",
            ].join("\n"),
            summary: "Searched Linear for open pricing issues",
            durationMs: 1_200,
          },
        ],
      },
      {
        kind: "say",
        text: [
          `I have put the memo together as **${documentTitle}**, drawing on the Q4 plan in`,
          "Drive, last week's pricing sync notes in Granola, and the four open pricing",
          "issues in Linear.",
          "",
          "The short version: the evidence points at bundling Insights into Growth at a",
          "$4k uplift rather than keeping it a $12k add-on. Sales say the separate line",
          "item — not the price — is what stalls deals, and two renewals this quarter",
          "have already asked for it to be included. The bundled case still reaches the",
          "Q4 revenue target, at 41 attached accounts instead of 18.",
          "",
          "The blocker is TID-431: there is no bundle SKU in billing, so a bundled launch",
          "cannot be quoted today. Finance's floor ($31k ARPA) survives the bundle, so",
          "that is not the constraint people assume it is.",
          "",
          `The full argument, including the case against bundling, is in ${documentTitle}.`,
        ].join("\n"),
      },
    ],
  };
}

/** Work stream B: a short recorded answer, so the pack has a middle in recency. */
function onboardingCopyFixture(): SpikeAssistantFixture {
  return {
    plugins: [],
    elicitationTargetUserId: null,
    turns: [{
      kind: "say",
      text: [
        "Here is a first pass at the three onboarding emails.",
        "",
        "**Day 0 — \"You're in\"**: one job, get them to connect a calendar. No feature",
        "tour, no video. One button.",
        "",
        "**Day 2 — \"Here's what we noticed\"**: the first real signal from their own",
        "data. This is the email that has to earn the next open, so it should contain",
        "something they did not know, not something we can do.",
        "",
        "**Day 7 — \"Bring someone\"**: the invite ask, framed around a thing they",
        "already did rather than around seats.",
        "",
        "I have kept all three under 120 words. Want me to draft the actual copy, or",
        "settle the sequence first?",
      ].join("\n"),
    }],
  };
}

/** Work stream C, opening run: one substantive assistant contribution. */
function renewalOpeningFixture(): SpikeAssistantFixture {
  return {
    plugins: [],
    elicitationTargetUserId: null,
    turns: [{
      kind: "say",
      text: [
        "From the contract: Northgate are on the 2024 Growth agreement, 140 seats, with",
        "a 6% uplift cap at renewal and a 60-day notice window that opens in eleven",
        "days. Insights was given to them at no charge during the pilot and was never",
        "added to the order form, so today we owe them nothing for it — but nothing",
        "stops them from reading twelve months of use as an entitlement either.",
      ].join("\n"),
    }],
  };
}

/** Work stream C, closing run: the blocking question addressed to the presenter. */
function renewalElicitationFixture(presenterUserId: string): SpikeAssistantFixture {
  return {
    plugins: [],
    elicitationTargetUserId: presenterUserId,
    turns: [{
      kind: "elicit",
      id: "spike-northgate-decision",
      prompt: [
        "Northgate's notice window opens in eleven days and the three of you disagree",
        "about what Insights costs them at renewal. Which position should I write the",
        "renewal proposal against?",
      ].join(" "),
      options: [
        "Include Insights at no uplift — protect the renewal",
        "Include Insights at the $4k Growth uplift",
        "Keep Insights as a separate $12k add-on and hold the line",
      ],
      allowFreeText: true,
    }],
  };
}

export interface SeededWorkstream {
  key: "A" | "B" | "C";
  workstreamId: string;
  title: string;
  occurredAt: number;
  turnIds: string[];
  harnessRunIds: string[];
  resourceId?: string;
  elicitationId?: string;
}

export interface SeedResult {
  packRunId: string;
  workspaceId: string;
  presenterUserId: string;
  personaUserIds: Record<string, string>;
  workstreams: SeededWorkstream[];
  notes: string[];
}

/** A connector-principal auth context: an active member, no session row. */
function personaAuth(env: Env, workspaceId: string, userId: string): AuthContext {
  return {
    // Correlation only under a connector principal; the object verifies
    // membership instead of looking this id up in `sessions`.
    sessionId: `spike-replay:${userId}`,
    userId: asUserId(userId),
    workspaceId: asWorkspaceId(workspaceId),
    region: env.AVALON_REGION,
    role: "member",
    principal: "connector",
  } as AuthContext;
}

async function ensurePersonas(
  env: Env,
  workspaceId: string,
): Promise<Record<string, string>> {
  const at = new Date().toISOString();
  const ids: Record<string, string> = {};
  for (const persona of TIDEPOINT_PERSONAS) {
    const subject = `persona:${persona.slug}`;
    const existing = await env.DB.prepare(
      `SELECT id FROM users WHERE google_subject = ?`,
    ).bind(subject).first<{ id: string }>();
    const id = existing?.id ?? newId();
    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).bind(id, subject, persona.email, persona.name, at, at).run();
    }
    await env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'member', 'active', ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'member', status = 'active'`,
    ).bind(workspaceId, id, at).run();
    ids[persona.slug] = id;
  }
  return ids;
}

/**
 * The propagation barrier.
 *
 * `flushEffectsToWorkstreamDO` and `flushWorkspaceDirectoryEffects` are already
 * public RPC methods — `WorkstreamObjectCreationService` calls both — so the
 * spike had to expose nothing to reach them. The third call is the probe the
 * creation service uses to refuse activation, and it is the only synchronous
 * proof available that the directory row exists.
 */
export async function drainToWorkspaceDirectory(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<{ substreamEffects: number; directoryEffects: number; directoryRow: boolean }> {
  const substream = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    substreamAgentName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId)),
  );
  const substreamEffects = await substream.flushEffectsToWorkstreamDO();
  const parent = await durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    workspaceId,
    workstreamDOName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId)),
  );
  const directoryEffects = await parent.flushWorkspaceDirectoryEffects();
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
  const directoryRow = await workspace.hasWorkstreamDirectory({ workspaceId, workstreamId });
  return { substreamEffects, directoryEffects, directoryRow };
}

/** Wait for a work stream's loop to stop executing, on real time. */
async function waitForSettled(
  env: Env,
  auth: AuthContext,
  workstreamId: string,
  budgetMs: number,
): Promise<string> {
  const client = new WorkstreamObjectClient(env, auth, workstreamId, "0");
  const deadline = Date.now() + budgetMs;
  let status = "unknown";
  while (Date.now() < deadline) {
    const detail = await client.get();
    status = detail.harnessStatus;
    if (!["running", "scheduled", "interrupting", "preparing_context", "waiting_capacity"]
      .includes(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return `timeout:${status}`;
}

function replay(
  packRunId: string,
  workspaceId: string,
  actionId: string,
  occurredAt: number,
  assistant?: SpikeAssistantFixture,
): ReplayContext {
  return {
    occurredAt,
    packRunId,
    actionId,
    workspaceId,
    ...(assistant ? { assistant } : {}),
  };
}

export async function seedTidepointPack(env: Env, input: {
  workspaceId: string;
  presenterUserId: string;
  presenterSessionId: string;
  documentTitle?: string | undefined;
  /** SPIKE — throwaway. Bisect switch: which of the three rooms to seed. */
  only?: readonly ("A" | "B" | "C")[] | undefined;
  /** SPIKE — throwaway. Bisect switch: skip C's closing elicitation run. */
  skipClosingRun?: boolean | undefined;
}): Promise<SeedResult> {
  const control = await readWorkstreamAuthorityControl(env);
  if (control.phase !== "durable_object_open") {
    throw new Error(`spike_authority_not_open:${control.phase}`);
  }
  const packRunId = newId();
  const notes: string[] = [];
  const now = Date.now();
  const workspaceId = input.workspaceId;
  const personas = await ensurePersonas(env, workspaceId);
  const documentTitle = input.documentTitle ?? "Insights pricing — decision memo";

  const priya = personaAuth(env, workspaceId, personas["priya-raman"]!);
  const marcus = personaAuth(env, workspaceId, personas["marcus-hale"]!);
  const dana = personaAuth(env, workspaceId, personas["dana-okafor"]!);
  const sam = personaAuth(env, workspaceId, personas["sam-lindqvist"]!);

  const seeded: SeededWorkstream[] = [];
  const wants = (key: "A" | "B" | "C") => !input.only || input.only.includes(key);

  // ---- A -----------------------------------------------------------------
  const aAt = now - 3 * HOUR;
  if (wants("A")) {
  const aCreate = await new WorkstreamObjectCreationService(env, priya).create({
    openingMessage: [
      "I need a decision memo on Insights pricing before the Northgate renewal.",
      "Pull the Q4 plan out of Drive, last week's pricing call notes from Granola,",
      "and whatever is still open in Linear under pricing. I want the argument for",
      "and against bundling, not a summary.",
    ].join(" "),
    clientMessageId: newId(),
    participantUserIds: [],
    attachmentIds: [],
    mentions: [],
    // Workspace-scoped, so the presenter can see it without being in it. A
    // personal work stream is listable only to its participants, and a demo
    // whose presenter cannot see two of its three rooms is not a demo. `scope`
    // is an internal creation-service argument, deliberately absent from
    // `CreateWorkstreamRequestSchema` — see SPIKE-REPORT.md.
    scope: "workspace",
  }, {
    reason: "opening_message",
    spikeReplay: replay(packRunId, workspaceId, "A:create", aAt, decisionMemoFixture(documentTitle)),
  });
  const aStatus = await waitForSettled(env, priya, aCreate.workstream.id, 120_000);
  notes.push(`A opening run settled as ${aStatus}`);

  // The document, through the real resource-creation path, then the real
  // attachment path. Both run as the presenter: an upload is a person's act and
  // there is no production path for one that is not.
  const memo = new File(
    [`# ${documentTitle}\n\nRecommendation: fold Insights into Growth at a $4k uplift.\n\n`
      + "## The case for bundling\n\nSales report the separate line item, not the price, "
      + "is what stalls deals. Two renewals this quarter asked for Insights to be included. "
      + "The bundled case reaches the Q4 revenue target at 41 attached accounts.\n\n"
      + "## The case against\n\nARPA floor is $31k and the bundle clears it by less than "
      + "$900. TID-431 means billing has no bundle SKU, so nothing can be quoted until "
      + "it exists.\n"],
    "insights-pricing-decision-memo.md",
    { type: "text/markdown" },
  );
  // Uploaded and attached as Priya, not as the presenter: `attach_resource`
  // authorizes against the work stream's own participant rows, and A is a
  // personal work stream the presenter is not in. That refusal is correct
  // product behaviour and it is what decides who can seed an attachment.
  const resource = await new ResourceService(env, priya).upload(memo, documentTitle, newId());
  await new WorkstreamObjectClient(env, priya, aCreate.workstream.id, "0")
    .attachResource(resource.id);
  notes.push("A: document created through ResourceService.upload and attached through attach_resource, both as the work stream's creator");

  await drainToWorkspaceDirectory(env, workspaceId, aCreate.workstream.id);
  seeded.push({
    key: "A",
    workstreamId: aCreate.workstream.id,
    title: aCreate.workstream.title,
    occurredAt: aAt,
    turnIds: [aCreate.turnId],
    harnessRunIds: [aCreate.harnessRunId],
    resourceId: resource.id,
  });
  }

  // ---- B -----------------------------------------------------------------
  const bAt = now - 90 * MINUTE;
  if (wants("B")) {
  const bCreate = await new WorkstreamObjectCreationService(env, sam).create({
    openingMessage: [
      "Draft the three onboarding emails for the self-serve trial. Day 0, day 2, day 7.",
      "Keep each under 120 words and tell me what each one is for before you write copy.",
    ].join(" "),
    clientMessageId: newId(),
    participantUserIds: [],
    attachmentIds: [],
    mentions: [],
    scope: "workspace",
  }, {
    reason: "opening_message",
    spikeReplay: replay(packRunId, workspaceId, "B:create", bAt, onboardingCopyFixture()),
  });
  const bStatus = await waitForSettled(env, sam, bCreate.workstream.id, 120_000);
  notes.push(`B opening run settled as ${bStatus}`);
  await drainToWorkspaceDirectory(env, workspaceId, bCreate.workstream.id);
  seeded.push({
    key: "B",
    workstreamId: bCreate.workstream.id,
    title: bCreate.workstream.title,
    occurredAt: bAt,
    turnIds: [bCreate.turnId],
    harnessRunIds: [bCreate.harnessRunId],
  });
  }

  // ---- C -----------------------------------------------------------------
  const cAt = now - 30 * MINUTE;
  if (wants("C")) {
  const cCreate = await new WorkstreamObjectCreationService(env, marcus).create({
    openingMessage: [
      "Northgate renewal is up. Before we quote it I want to know what we actually owe",
      "them on Insights — they have had it free for a year and it is not on the order form.",
    ].join(" "),
    clientMessageId: newId(),
    // Seated at creation on purpose: `create_message` forces a harness run
    // whenever the work stream has one participant, so a two-person
    // conversation cannot be seeded message-by-message into an empty room.
    participantUserIds: [dana.userId, priya.userId],
    attachmentIds: [],
    mentions: [],
  }, {
    reason: "opening_message",
    notifyParticipants: false,
    spikeReplay: replay(packRunId, workspaceId, "C:create", cAt, renewalOpeningFixture()),
  });
  const cId = cCreate.workstream.id;
  const cStatus = await waitForSettled(env, marcus, cId, 120_000);
  notes.push(`C opening run settled as ${cStatus}`);

  const presenterName = await env.DB.prepare(`SELECT name FROM users WHERE id = ?`)
    .bind(input.presenterUserId).first<{ name: string }>();
  const mentionLabel = `@${presenterName?.name ?? "Adam"}`;
  const mentionText = `${mentionLabel} you own the commercial call here — `
    + "we cannot answer this without you.";

  const conversation: Array<{
    auth: AuthContext;
    text: string;
    minutesBefore: number;
    mentionPresenter?: boolean;
    forceRun?: boolean;
    fixture?: SpikeAssistantFixture;
  }> = [
    { auth: dana, minutesBefore: 26, text:
      "Legally nothing. Practically, they have a year of usage and a champion who will "
      + "say it was always part of the deal." },
    { auth: priya, minutesBefore: 22, text:
      "Their usage is real — 40-odd weekly actives on Insights out of 140 seats. Pulling "
      + "it at renewal is the version of this that loses the account." },
    { auth: marcus, minutesBefore: 17, text:
      "I am not proposing we pull it. I am asking whether it goes on the order form at "
      + "$12k, at the $4k Growth uplift, or at zero." },
    { auth: dana, minutesBefore: 11, text:
      "Zero sets the precedent for every renewal behind them. I would rather lose the "
      + "6% uplift than the line item." },
    { auth: priya, minutesBefore: 6, mentionPresenter: true, text: mentionText },
    { auth: marcus, minutesBefore: 2, forceRun: !input.skipClosingRun,
      fixture: renewalElicitationFixture(input.presenterUserId), text:
      "We are going in circles and the notice window opens in eleven days. Rally, take "
      + "the three positions above and tell me which one to write the proposal against." },
  ];

  const cTurnIds = [cCreate.turnId];
  const cRunIds = [cCreate.harnessRunId];
  for (const [index, message] of conversation.entries()) {
    const at = now - message.minutesBefore * MINUTE;
    const client = new WorkstreamObjectClient(env, message.auth, cId, "0");
    const receipt = await client.createMessage({
      text: message.text,
      clientMessageId: newId(),
      mentions: message.mentionPresenter
        ? [{
            type: "person" as const,
            userId: asUserId(input.presenterUserId),
            connectorType: null,
            startOffset: 0,
            endOffset: mentionLabel.length,
          }]
        : [],
      confirmedParticipantUserIds: message.mentionPresenter ? [input.presenterUserId] : [],
      attachmentIds: [],
      ...(message.forceRun ? { forcedHarnessOrigin: "spike_replay_close" } : {}),
      spikeReplay: replay(
        packRunId,
        workspaceId,
        `C:message:${index}`,
        at,
        message.fixture,
      ),
    });
    cTurnIds.push(receipt.turn.turnId);
    if (message.forceRun) {
      const closing = await waitForSettled(env, message.auth, cId, 120_000);
      notes.push(`C closing run settled as ${closing}`);
    }
  }

  await drainToWorkspaceDirectory(env, workspaceId, cId);
  // Read as a persona, never as the presenter: `get` settles `first_opened_at`
  // for whoever asks, so a seeder that reads its own work back as the presenter
  // destroys the unseen state the pack is trying to leave behind.
  const cReader = new WorkstreamObjectClient(env, marcus, cId, "0");
  let elicitation = (await cReader.get()).openElicitations[0];
  for (let attempt = 0; attempt < 20 && !elicitation; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    elicitation = (await cReader.get()).openElicitations[0];
  }
  if (elicitation) cRunIds.push(asHarnessRunId(elicitation.harnessRunId));
  seeded.push({
    key: "C",
    workstreamId: cId,
    title: cCreate.workstream.title,
    occurredAt: cAt,
    turnIds: cTurnIds,
    harnessRunIds: cRunIds,
    ...(elicitation ? { elicitationId: elicitation.id } : {}),
  });
  }

  return {
    packRunId,
    workspaceId,
    presenterUserId: input.presenterUserId,
    personaUserIds: personas,
    workstreams: seeded,
    notes,
  };
}
