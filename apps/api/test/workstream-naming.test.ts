import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWorkstreamNameMessages } from "@rally/agent-harness";

import type { Env } from "../src/env";
import {
  chooseWorkstreamIcon,
  nameWorkstream,
  normalizeGeneratedTitle,
  provisionalWorkstreamTitle,
  refreshWorkstreamName,
  summarizeExistingDescription,
} from "../src/services/workstream-naming-service";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  seedCanonicalConversationTurn,
  seedWorkstreamObjectRoot,
  testIdentityOperationStub,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  applyWorkstreamObjectRootFields,
  workstreamObjectRootRow,
} from "./helpers/durable-authority";

const workspaceId = "00000000-0000-7000-8000-0000000000b0";
const userId = "user-owner";
const workstreamId = "00000000-0000-7000-8000-0000000000a1";
const at = "2026-08-11T09:00:00.000Z";
const provisionalTitle = "Create an email **draft** to Danny from Mucker that shares the avalon download link";
const objective = `${provisionalTitle} and asks him to add Alex and Katherine to the recurring Tuesday call.`;

const databases: DatabaseSync[] = [];

/**
 * The work stream's own object database, by the regional database it was
 * seeded next to. Since migration 0090 the transcript and the product
 * `workstreams` row live only in the object; the naming service reaches them
 * through the routed environment, and the tests reach them through this map.
 */
const objectStores = new WeakMap<DatabaseSync, DatabaseSync>();

function objectStoreOf(database: DatabaseSync): DatabaseSync {
  const store = objectStores.get(database);
  if (!store) throw new Error("seededDatabase() did not create this database");
  return store;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

describe("work-stream naming", () => {
  it("replaces the provisional title and tells the open work stream about it", async () => {
    const database = seededDatabase();
    const requests: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Avalon download link email to Danny");
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
      userId,
    });

    // The model answered past the cap; what is written and published is the
    // name cut back to the last whole word that fits — which is a whole word
    // and not a whole thought, as this one ending on `to` shows.
    expect(workstreamRow(database)).toMatchObject({
      title: "Avalon download link email to",
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Avalon download link email to",
      titleStatus: "automatic",
      icon: "megaphone",
    }]);
    // The icon lands on the same write as the name and reaches the header on
    // the same event: the directory projection that also carries it is two
    // Durable Object alarms and two Queue hops behind, and a glyph that changed
    // seconds after the name it was chosen with is the lag the picker's own
    // receipt already exists to close. The colour stays unchosen, which is what
    // keeps the id-derived one in force.
    expect(appearance(database)).toEqual({ icon: "megaphone", color: null });
  });

  it("names a private child with the same pass, and stores what it chose", async () => {
    const database = seededDatabase();
    const requests: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    // The same answer the test above gets, including the icon: the pass is the
    // work stream's own, and one call answers both halves for either.
    stubOpenRouter(requests, "Retry budget failures");
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      substreamId: "00000000-0000-7000-8000-0000000000d1",
      objective,
      openingMessage: objective,
      provisionalTitle,
      userId,
    });

    // Written and published exactly as it is for a work stream, icon included:
    // there is a row to store it in, so it is stored. What keeps a substream
    // looking like a substream is the surface, not the absence of a value —
    // the sidebar's child rows draw the branch line, and the directory payload
    // behind them carries no appearance at all
    // (`workstream-sidebar.test.tsx` holds both).
    expect(workstreamRow(database)).toMatchObject({
      title: "Retry budget failures",
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Retry budget failures",
      titleStatus: "automatic",
      icon: "megaphone",
    }]);
    expect(appearance(database)).toEqual({ icon: "megaphone", color: null });
  });

  it("asks the naming agent's own model for a name, with reasoning switched off", async () => {
    const database = seededDatabase();
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Tuesday call invites");
    const env = environment(database, []);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({
      model: "google/gemini-2.5-flash-lite",
      // Not `{ effort: "low" }`: on a model that does no thinking by default,
      // asking for the lowest effort turns thinking on. `none` is the official
      // OpenRouter SDK representation of the disabled state.
      reasoning: { effort: "none" },
      response_format: { json_schema: { name: "workstream_name", strict: true } },
    });
    // The advertised bound is the parse ceiling, not the thirty the prompt asks
    // for, and the two must not be tidied into one number. This schema goes out
    // `strict: true`, so a provider that enforces `maxLength` stops generating
    // at exactly that character — a name cut there arrives inside the target and
    // the whole-word cut cannot tell it was ever truncated.
    const schema = (request?.response_format as {
      json_schema: {
        schema: {
          properties: { title: { maxLength: number }; icon: Record<string, unknown> };
          required: string[];
        };
      };
    }).json_schema.schema;
    expect(schema.properties.title.maxLength).toBe(80);
    // The icon is a required plain string. Not an enum of the catalog: Gemini
    // refuses a 253-value enum outright, and the parse already drops an answer
    // off the catalog. A `required` a provider honours is what stops it
    // answering with a name and no icon at all.
    expect(schema.properties.icon).toEqual({ type: "string" });
    expect(schema.required).toEqual(["title", "icon"]);
    // The request is what is being named, and it is data: it reaches the model
    // as user-role content and never as part of the naming policy.
    const messages = request?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).not.toContain("Danny");
    expect(messages.at(-1)).toMatchObject({ role: "user" });
    expect(messages.at(-1)?.content).toContain("Danny");
  });

  it("keeps a title a person set while the naming call was in flight", async () => {
    const database = seededDatabase();
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter([], "Avalon download link email to Danny", () => {
      // The rename lands between the model answering and the title being
      // written — exactly the window the conditional update exists to lose.
      // Naming a work stream settles it, which is what makes it untouchable.
      applyWorkstreamObjectRootFields(
      objectStoreOf(database),
      { title: "Mucker intro thread", titleStatus: "settled" },
    );
    });
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(title(database)).toBe("Mucker intro thread");
    expect(published).toEqual([]);
    // The fence has to run before the icon is computed, not beside it. A
    // `rename` that worked out the icon first and only then checked
    // `title_status` would leave this work stream carrying a mark from a pass
    // whose name it refused, and every assertion above would still hold.
    expect(appearance(database)).toBeNull();
  });

  it("leaves the provisional title standing when the model cannot be reached", async () => {
    const database = seededDatabase();
    const published: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));
    const env = environment(database, published);

    await expect(nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    })).resolves.toBeUndefined();

    // The provisional title stands, but the work stream stops waiting: a
    // skeleton that never resolves is worse than a title taken from the
    // request, and the same event carries that to whoever is looking at it.
    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: provisionalTitle,
      titleStatus: "automatic",
    }]);
    // The event settles the skeleton and carries no icon, because none was
    // written: a pass with no name to give has no icon to give either.
    expect(appearance(database)).toBeNull();
  });

  it("leaves the provisional title standing when the answer is past the parse ceiling", async () => {
    const database = seededDatabase();
    const published: Array<Record<string, unknown>> = [];
    // Past `WORKSTREAM_NAME_RESULT_MAX_LENGTH`, which is a model that answered
    // the request instead of naming it. That fails the parse rather than being
    // trimmed, and the work stream keeps the title it had — the reason the
    // ceiling sits far above the target rather than tracking it.
    stubOpenRouter([], "x".repeat(81));
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
  });

  it("spends no icon on a pass whose name normalized away to nothing", async () => {
    const database = seededDatabase();
    const published: Array<Record<string, unknown>> = [];
    // A bare Markdown heading reduces to an empty title, so this pass produced
    // nothing usable however confidently it answered. The icon is tied to the
    // name rather than written on its own: the one icon a work stream gets must
    // not be spent by the pass that failed to name it.
    stubOpenRouter([], "###", undefined, "coins");
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(appearance(database)).toBeNull();
    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: provisionalTitle,
      titleStatus: "automatic",
    }]);
  });

  it("writes the icon into a colour somebody already chose without disturbing it", async () => {
    const database = seededDatabase();
    // The half of the appearance a naming pass never chooses. Every other test
    // reaches the write from an empty appearance, so a regression that replaced
    // the row instead of merging into it would ship green.
    applyWorkstreamObjectRootFields(
      objectStoreOf(database),
      { appearance: { icon: null, color: "teal" } },
    );
    stubOpenRouter([], "Avalon download link");
    const env = environment(database, []);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(appearance(database)).toEqual({ icon: "megaphone", color: "teal" });
  });

  it("keeps an icon a person chose, and keeps naming past it", async () => {
    const database = seededDatabase();
    // The fence that protects the title cannot protect the icon: choosing one
    // from the header settles nothing, so the row a naming pass is still
    // entitled to rename is exactly the row whose icon a person may have just
    // picked. What protects it is that a generated icon is only ever written
    // where none is stored.
    applyWorkstreamObjectRootFields(
      objectStoreOf(database),
      { appearance: { icon: "rocket", color: "teal" } },
    );
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter([], "Avalon download link");
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(appearance(database)).toEqual({ icon: "rocket", color: "teal" });
    // The name still lands, and the event says only what changed — publishing
    // the refused icon would tell every open client to paint over the choice
    // the object had just declined to overwrite.
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Avalon download link",
      titleStatus: "automatic",
    }]);
  });

  it("keeps the name when the model answers with an icon that is not one of ours", async () => {
    const database = seededDatabase();
    const published: Array<Record<string, unknown>> = [];
    // A provider that ignored the enum, or a catalog key that has since been
    // renamed. The name is the half a person is watching a skeleton for, so an
    // unusable icon degrades to no icon rather than failing the parse and
    // costing the work stream its name as well.
    stubOpenRouter([], "Avalon download link", undefined, "unicorn");
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(workstreamRow(database)).toMatchObject({
      title: "Avalon download link",
      title_status: "automatic",
    });
    expect(appearance(database)).toBeNull();
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Avalon download link",
      titleStatus: "automatic",
    }]);
  });

  it("still renames when the icon is a catalog key this object cannot read", async () => {
    const database = seededDatabase();
    // Dispatched at the storage operation rather than through the service,
    // because that is the only place this value exists: the service's own parse
    // degrades an off-catalog icon to `null` long before the write. The args
    // cross the object's RPC boundary as JSON, so during a rollout a Worker one
    // deploy ahead sends a key the resident object's enum does not know.
    //
    // The icon is the soft half. A throw here rolls back the title and the
    // status advance in the same transaction and leaves a skeleton that only
    // the second pass can clear, and only past five said messages — the exact
    // failure the module's "advance the status even when it produced no name"
    // invariant exists to prevent.
    const answer = testIdentityOperationStub(objectStoreOf(database))({
      operation: "rename",
      args: [{
        title: "Avalon download link",
        icon: "satellite-dish",
        from: "naming",
        to: "automatic",
        now: Date.now(),
      }],
    });

    expect(JSON.parse(answer.bodyJson)).toEqual({
      ok: true,
      value: { outcome: "renamed", icon: null },
    });
    expect(workstreamRow(database)).toMatchObject({
      title: "Avalon download link",
      title_status: "automatic",
    });
    expect(appearance(database)).toBeNull();
  });

  it("names the work stream past an appearance it cannot read, and leaves it alone", async () => {
    const database = seededDatabase();
    // `json_valid` accepts this and the appearance schema does not, so it is
    // durable state the object can read from the column and not into a value.
    objectStoreOf(database)
      .prepare("UPDATE workstream SET appearance_json = 'null' WHERE id = 1").run();
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter([], "Avalon download link");
    const env = environment(database, published);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    // The name lands. The appearance is left exactly as it was rather than
    // replaced with a generated icon: malformed shared identity fails visibly
    // rather than quietly becoming something else, and a naming pass is the
    // last writer that should overrule that.
    expect(workstreamRow(database)).toMatchObject({
      title: "Avalon download link",
      title_status: "automatic",
    });
    expect(workstreamRow(database).appearance_json).toBe("null");
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Avalon download link",
      titleStatus: "automatic",
    }]);
  });

  it("gives an imported Channel an icon from its history, and keeps its name", async () => {
    const database = seededDatabase();
    // An import is created with the name the importer typed, settled.
    applyWorkstreamObjectRootFields(objectStoreOf(database), {
      title: "Danny's onboarding chat",
      titleStatus: "settled",
    });
    seedMessages(database, 2);
    const requests: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Avalon download link");
    const env = environment(database, published);

    await chooseWorkstreamIcon(env, {
      workspaceId,
      workstreamId,
      objective: "Danny's onboarding chat",
      userId,
    });

    expect(workstreamRow(database)).toMatchObject({
      title: "Danny's onboarding chat",
      title_status: "settled",
    });
    // The colour stays unchosen, so the id-derived one stays in force.
    expect(appearance(database)).toEqual({ icon: "megaphone", color: null });
    // No room event: one carrying a title could undo a rename that landed
    // after this pass read the row. The directory projection carries the icon.
    expect(published).toEqual([]);
    // The imported history is what the model reads. The client appends the
    // expected JSON Schema to the last message, so the rendered payload is the
    // part before it.
    const [rendered] = (requests[0]?.messages as Array<{ content: string }>)[1]!.content.split("\n\n");
    expect((JSON.parse(String(rendered)) as { conversation: unknown[] }).conversation).toHaveLength(2);
  });

  it("keeps an import's icon when the name it came with normalizes away", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(objectStoreOf(database), { titleStatus: "settled" });
    // A bare heading marker is a name the normalizer reduces to nothing. The
    // icon pass throws the name away regardless, so the icon still stands.
    stubOpenRouter([], "##");
    const env = environment(database, []);

    await chooseWorkstreamIcon(env, {
      workspaceId,
      workstreamId,
      objective,
    });

    expect(appearance(database)).toEqual({ icon: "megaphone", color: null });
    expect(workstreamRow(database)).toMatchObject({ title: provisionalTitle, title_status: "settled" });
  });

  it("keeps the icon a person chose for an import", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(objectStoreOf(database), {
      titleStatus: "settled",
      appearance: { icon: "rocket", color: null },
    });
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter([], "Avalon download link");
    const env = environment(database, published);

    await chooseWorkstreamIcon(env, {
      workspaceId,
      workstreamId,
      objective,
    });

    expect(appearance(database)).toEqual({ icon: "rocket", color: null });
    expect(published).toEqual([]);
  });

  it("never names a work stream without an OpenRouter key", async () => {
    const database = seededDatabase();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = createTestEnv({ ...environment(database, []), OPENROUTER_API_KEY: "" });

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
  });

  it("names the work stream again from the conversation once it has five messages", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(
      objectStoreOf(database),
      { title: "Draft email to Danny", titleStatus: "automatic" },
    );
    seedMessages(database, 5);
    const requests: Array<Record<string, unknown>> = [];
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Mucker link Danny");
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId, userId });

    // The detail that names this work stream — the address the first attempt
    // bounced off — only exists in the replies, which is the whole reason for
    // a second pass.
    // The client appends the expected JSON Schema to the last message, so the
    // rendered payload is the part before it.
    const [rendered] = (requests[0]?.messages as Array<{ content: string }>)[1]!.content.split("\n\n");
    const payload = JSON.parse(String(rendered)) as {
      conversation: Array<{ author: string; text: string }>;
    };
    expect(payload.conversation).toHaveLength(5);
    expect(payload.conversation[1]).toMatchObject({ author: "avalon" });
    expect(workstreamRow(database)).toMatchObject({
      title: "Mucker link Danny",
      title_status: "settled",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: "Mucker link Danny",
      titleStatus: "settled",
      icon: "megaphone",
    }]);
    expect(appearance(database)).toEqual({ icon: "megaphone", color: null });
  });

  it("repairs a work stream whose first naming pass never finished", async () => {
    // The isolate went away between creating the work stream and settling its
    // title, so the row is still `naming` — and the client is still showing a
    // skeleton — long after anything was going to name it.
    const database = seededDatabase();
    seedMessages(database, 6);
    const published: Array<Record<string, unknown>> = [];
    stubOpenRouter([], "Mucker link Danny");
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(workstreamRow(database)).toMatchObject({
      title: "Mucker link Danny",
      title_status: "settled",
    });
    expect(published).toHaveLength(1);
  });

  it("keeps its one retry when the model cannot be reached at the five-message mark", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(
      objectStoreOf(database),
      { title: "Invoice export totals", titleStatus: "automatic" },
    );
    seedMessages(database, 5);
    const published: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    // Nothing is waiting on this pass — `automatic` and `settled` render the
    // same — so a model that happened to be unreachable must not spend the one
    // second look this work stream gets, or publish a rename of nothing.
    expect(workstreamRow(database)).toMatchObject({
      title: "Invoice export totals",
      title_status: "automatic",
    });
    expect(published).toEqual([]);

    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Invoice INV-2291 VAT");
    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(workstreamRow(database)).toMatchObject({
      title: "Invoice INV-2291 VAT",
      title_status: "settled",
    });
  });

  it("still resolves a stalled first pass when the model cannot be reached", async () => {
    const database = seededDatabase();
    seedMessages(database, 5);
    const published: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection reset"); }));
    const env = environment(database, published);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    // The exception to the rule above: this row is a first pass that never
    // finished, and something on screen is waiting for it to end.
    expect(workstreamRow(database)).toMatchObject({
      title: provisionalTitle,
      title_status: "automatic",
    });
    expect(published).toEqual([{
      type: "workstream_renamed",
      title: provisionalTitle,
      titleStatus: "automatic",
    }]);
  });

  it("counts what the work stream said, not what the harness wrote down", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(objectStoreOf(database), { titleStatus: "automatic" });
    // An opening request, one reply, and three tool calls. A run ends where
    // tool rows accumulate, and that is one of the two places the second pass
    // is called from — counting them would name this from what the first pass
    // already saw.
    seedMessages(database, 2);
    for (const [index, kind] of (["tool", "tool", "tool"] as const).entries()) {
      const turnId = `00000000-0000-7000-8000-00000000d0${String(index).padStart(2, "0")}`;
      seedCanonicalConversationTurn(objectStoreOf(database), {
        turnId,
        clientMessageId: `tool-${index}`,
        actor: "assistant",
        authorSnapshot: null,
        messageType: kind,
        text: "",
        structuredContentJson: JSON.stringify({
          invocation: { toolName: "run_command", status: "completed" },
        }),
        transcriptSequence: 20 + index,
        createdAt: at,
      });
    }
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = environment(database, []);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(fetcher).not.toHaveBeenCalled();
    expect(workstreamRow(database)).toMatchObject({ title_status: "automatic" });
  });

  it("names a work stream again only once, however often the transcript grows", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(objectStoreOf(database), { titleStatus: "automatic" });
    seedMessages(database, 9);
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Mucker link Danny");
    const env = environment(database, []);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });
    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(requests).toHaveLength(1);
  });

  it("leaves a short work stream and a title a person chose alone", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(objectStoreOf(database), { titleStatus: "automatic" });
    seedMessages(database, 4);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = environment(database, []);

    await refreshWorkstreamName(env, { workspaceId, workstreamId });
    expect(fetcher).not.toHaveBeenCalled();

    seedMessages(database, 6);
    applyWorkstreamObjectRootFields(
      objectStoreOf(database),
      { title: "Mucker intro thread", titleStatus: "settled" },
    );

    await refreshWorkstreamName(env, { workspaceId, workstreamId });

    expect(fetcher).not.toHaveBeenCalled();
    expect(title(database)).toBe("Mucker intro thread");
  });

  it("never fails the creation or the run it was called from", async () => {
    const database = seededDatabase();
    stubOpenRouter([], "Avalon download link email to Danny");
    // Both passes write; a database that refuses the write is the failure the
    // callers cannot absorb — one awaits naming having already created the work
    // stream and launched its run, and the other is a durable workflow step
    // that would retry the model call and then fail a committed run.
    const failing = createTestEnv({
      ...environment(database, []),
      DB: {
        prepare: () => { throw new Error("D1_ERROR: network"); },
      },
    });

    await expect(nameWorkstream(failing, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
    })).resolves.toBeUndefined();
    await expect(refreshWorkstreamName(failing, { workspaceId, workstreamId }))
      .resolves.toBeUndefined();
  });

  it("reads no more of a transcript than it takes to know the work stream is due", async () => {
    const database = seededDatabase();
    applyWorkstreamObjectRootFields(objectStoreOf(database), { titleStatus: "settled" });
    seedMessages(database, 40);
    const counted: string[] = [];
    const transcriptOperations: string[] = [];
    const identityOperations: string[] = [];
    const env = environment(database, [], transcriptOperations, identityOperations);
    const settled = createTestEnv({
      ...env,
      DB: {
        ...env.DB,
        prepare: (sql: string) => {
          counted.push(sql);
          return env.DB.prepare(sql);
        },
      },
    });

    await refreshWorkstreamName(settled, { workspaceId, workstreamId });

    // A settled work stream is the overwhelmingly common case, and this runs
    // after every message and every run: it has to decide from the work
    // stream's own row and stop. The title status used to be a `WHERE` clause
    // and the message count a subquery beside it in the same statement; both
    // are separate operations now, which is what makes the cheap path provable
    // rather than merely intended — one identity read, no transcript at all,
    // and nothing about this work stream asked of regional D1.
    expect(identityOperations).toEqual(["identity"]);
    expect(transcriptOperations).toEqual([]);
    expect(counted.filter((sql) => /workstreams/u.test(sql))).toEqual([]);
  });

  it("writes a name a person would read rather than whatever the model returned", () => {
    expect(normalizeGeneratedTitle('"Danny download email."')).toBe("Danny download email");
    expect(normalizeGeneratedTitle("## Mucker\n  intro  thread")).toBe("Mucker intro thread");
    // The title is stored, so a model's TeX is repaired here — once, at the
    // write — rather than by every surface that shows the sidebar row.
    expect(normalizeGeneratedTitle("Billing $\\rightarrow$ Stripe")).toBe("Billing → Stripe");
    expect(normalizeGeneratedTitle("Renew the $50 plan")).toBe("Renew the $50 plan");
    expect(normalizeGeneratedTitle("   ")).toBeNull();
    // A name that starts mid-sentence is capitalized; one that starts on
    // something that spells itself is not, and an identifier keeps its case.
    expect(normalizeGeneratedTitle("invoice INV-2291 totals")).toBe("Invoice INV-2291 totals");
    // The capital is taken by code point: `slice(0, 1)` on a letter outside the
    // Basic Multilingual Plane is half a surrogate pair and uppercases to
    // itself, leaving a name the guard just accepted as lowercase.
    expect(normalizeGeneratedTitle("\u{10428}eseret opening")).toBe("\u{10400}eseret opening");
    expect(normalizeGeneratedTitle("iPhone build fails")).toBe("iPhone build fails");
    expect(normalizeGeneratedTitle("danny@mucker.com")).toBe("danny@mucker.com");
    // An apostrophe inside the opening word does not make it a spelling to
    // leave alone the way a capital does.
    expect(normalizeGeneratedTitle("danny's invoice")).toBe("Danny's invoice");
    // The cut is a backstop at thirty — four answers in the 89 replayed — but
    // where it lands still matters for those four: the last whole word that
    // fits, and not the comma a cut between two listed things leaves behind.
    expect(normalizeGeneratedTitle("Rust, OCaml, C++ comparison essay"))
      .toBe("Rust, OCaml, C++ comparison");
    expect(normalizeGeneratedTitle("Pumpkin pie, Slack, Gmail, Drive"))
      .toBe("Pumpkin pie, Slack, Gmail");
    // A cut that would leave only the opening word takes the mid-word cut
    // instead. `Fix` is the framing word the prompt tells the model to drop,
    // and every name whose second token is long would be called it.
    expect(normalizeGeneratedTitle("Fix supercalifragilisticexpialidocious build"))
      .toBe("Fix supercalifragilisticexpial");
    expect(normalizeGeneratedTitle("Debug https://rally.example.com/onboarding page"))
      .toBe("Debug https://rally.example.co");
    // The boundary itself: the last word that fits ends exactly on the cap, and
    // the one after it is dropped rather than the one before.
    expect(normalizeGeneratedTitle("Slack and Gmail pumpkin search extra"))
      .toBe("Slack and Gmail pumpkin search");
    // A single word past the cap has no boundary to cut at, and a cut inside a
    // surrogate pair would leave a half that renders as a replacement
    // character in the sidebar.
    expect(normalizeGeneratedTitle("n".repeat(200))).toHaveLength(30);
    expect(normalizeGeneratedTitle(`${"n".repeat(29)}\u{1D41A}`)).toBe(`N${"n".repeat(28)}`);
    // Capitalizing can lengthen: `ß` uppercases to `SS`. The cap therefore has
    // to be applied after the capital, or a 30-character name leaves here 31
    // characters long.
    expect(normalizeGeneratedTitle(`ß${"a".repeat(29)}`)).toBe(`SS${"a".repeat(28)}`);
  });

  it("asks the model for the same cap the normalizer enforces", () => {
    // The number lives twice and in two packages: spelled as a word in the
    // prompt, and as `GENERATED_TITLE_MAX_LENGTH` here. Nothing links them, and
    // the pair before this change had already drifted — the prompt said sixty
    // while the service cut at eighty. This is the tripwire: move one without
    // the other and it fails here rather than in a sidebar.
    const enforced = normalizeGeneratedTitle("n".repeat(200));
    const policy = renderWorkstreamNameMessages({ objective: "o" })[0]!.content;

    expect(enforced).toHaveLength(30);
    expect(policy).toContain("thirty characters or less");
  });

  it("derives the provisional title from the first line that has anything in it", () => {
    expect(provisionalWorkstreamTitle("\n\n  Draft the release note  \nand send it", "New work stream"))
      .toBe("Draft the release note");
    expect(provisionalWorkstreamTitle("   \n \n", "New work stream")).toBe("New work stream");
    expect(provisionalWorkstreamTitle("", "Slack task")).toBe("Slack task");
    expect(provisionalWorkstreamTitle("x".repeat(400), "New work stream")).toHaveLength(180);
  });

  it("titles a mention by the name its author saw, not its link", () => {
    expect(provisionalWorkstreamTitle(
      "Ask [@Weekly \\[changelog\\]](sidekick://00000000-0000-7000-8000-000000000012) and [@Adam](person://00000000-0000-7000-8000-000000000001)",
      "New thread",
    )).toBe("Ask @Weekly [changelog] and @Adam");
  });
});

/** Replaces the transcript with `count` alternating messages. */
describe("first-pass summary", () => {
  const summary = "An email to Danny at Mucker with the Avalon download link, asking him to add Alex and Katherine to the Tuesday call.";

  it("asks for a summary beside the name and puts it in place of the derived description", async () => {
    const database = seededDatabase();
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Danny download link", undefined, "megaphone", summary);
    const env = environment(database, []);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
      provisionalDescription: objective,
      userId,
    });

    expect(requests).toHaveLength(1);
    const schema = (requests[0]?.response_format as { json_schema: { schema: { required: string[] } } }).json_schema.schema;
    expect(schema.required).toEqual(["title", "icon", "summary"]);
    expect(description(database)).toBe(summary);
    expect(title(database)).toBe("Danny download link");
  });

  it("leaves a description somebody replaced while the model was answering", async () => {
    const database = seededDatabase();
    stubOpenRouter([], "Danny download link", () => {
      objectStoreOf(database).prepare("UPDATE workstream SET description = ? WHERE id = 1").run("Intro Danny to the Tuesday call.");
    }, "megaphone", summary);
    const env = environment(database, []);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
      provisionalDescription: objective,
      userId,
    });

    expect(description(database)).toBe("Intro Danny to the Tuesday call.");
  });

  it("asks for no summary and keeps the description where a person wrote it", async () => {
    const database = seededDatabase();
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Danny download link", undefined, "megaphone", summary);
    const env = environment(database, []);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
      userId,
    });

    const schema = (requests[0]?.response_format as { json_schema: { schema: { required: string[] } } }).json_schema.schema;
    expect(schema.required).toEqual(["title", "icon"]);
    expect(description(database)).toBe(objective);
  });

  it("keeps the derived description when the summary is too long to stand in for it", async () => {
    const database = seededDatabase();
    stubOpenRouter([], "Danny download link", undefined, "megaphone", "word ".repeat(80));
    const env = environment(database, []);

    await nameWorkstream(env, {
      workspaceId,
      workstreamId,
      objective,
      openingMessage: objective,
      provisionalTitle,
      provisionalDescription: objective,
      userId,
    });

    expect(description(database)).toBe(objective);
    expect(title(database)).toBe("Danny download link");
  });
});

describe("backfilling an existing thread's summary", () => {
  const summary = "An email to Danny at Mucker with the Avalon download link, asking him to add Alex and Katherine to the Tuesday call.";
  const target = { workspaceId, workstreamId };

  it("summarizes a description that is still the opening line, and leaves it alone the second time", async () => {
    const database = seededDatabase();
    seedMessages(database, 1);
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Danny download link", undefined, "megaphone", summary);
    const env = environment(database, []);

    expect(await summarizeExistingDescription(env, target)).toBe("summarized");
    expect(description(database)).toBe(summary);
    // The title is the first pass's, and a backfill does not rename anything.
    expect(title(database)).toBe(provisionalTitle);

    expect(await summarizeExistingDescription(env, target)).toBe("not_the_opening_line");
    expect(requests).toHaveLength(1);
  });

  it("writes a description where there is none, as a Breakout opened without a message has", async () => {
    const database = seededDatabase();
    seedMessages(database, 1);
    objectStoreOf(database).prepare("UPDATE workstream SET description = '' WHERE id = 1").run();
    stubOpenRouter([], "Danny download link", undefined, "megaphone", summary);

    expect(await summarizeExistingDescription(environment(database, []), target)).toBe("summarized");
    expect(description(database)).toBe(summary);
  });

  it("asks nothing at run settlement once there is a description, even the opening line", async () => {
    const database = seededDatabase();
    seedMessages(database, 1);
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Danny download link", undefined, "megaphone", summary);

    expect(await summarizeExistingDescription(environment(database, []), { ...target, onlyWhenEmpty: true }))
      .toBe("has_description");
    expect(requests).toHaveLength(0);
    expect(description(database)).toBe(objective);
  });

  it("keeps the summary when the name beside it is unusable", async () => {
    const database = seededDatabase();
    seedMessages(database, 1);
    stubOpenRouter([], ".", undefined, "megaphone", summary);

    expect(await summarizeExistingDescription(environment(database, []), target)).toBe("summarized");
    expect(description(database)).toBe(summary);
  });

  it("asks nothing where a person wrote the description", async () => {
    const database = seededDatabase();
    seedMessages(database, 1);
    objectStoreOf(database).prepare("UPDATE workstream SET description_source = 'authored' WHERE id = 1").run();
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Danny download link", undefined, "megaphone", summary);

    expect(await summarizeExistingDescription(environment(database, []), target)).toBe("authored");
    expect(requests).toHaveLength(0);
    expect(description(database)).toBe(objective);
  });

  it("settles a conversation whose object never became authoritative, asking nothing", async () => {
    const database = seededDatabase();
    seedMessages(database, 1);
    // The placeholder a conversation object is born with, which only its
    // initialization or an import replaces: production had a listed thread
    // whose object stayed this way, and every attempt threw on the first read.
    objectStoreOf(database).prepare(
      "UPDATE workstream SET authority_mode = 'preparing', authority_generation = 0 WHERE id = 1",
    ).run();
    const requests: Array<Record<string, unknown>> = [];
    stubOpenRouter(requests, "Danny download link", undefined, "megaphone", summary);

    expect(await summarizeExistingDescription(environment(database, []), target)).toBe("not_authoritative");
    expect(requests).toHaveLength(0);
  });

  it("fails rather than settling when the model call fails, so the backfill retries it", async () => {
    const database = seededDatabase();
    seedMessages(database, 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(summarizeExistingDescription(environment(database, []), target))
      .rejects.toThrow("description_summary_model_failed");
    expect(description(database)).toBe(objective);
  });
});

function seedMessages(database: DatabaseSync, count: number): void {
  const objectStore = objectStoreOf(database);
  objectStore.prepare("DELETE FROM participant_transcript_turns WHERE entry_kind = 'conversation'").run();
  objectStore.prepare("UPDATE transcript_counters SET next_transcript_sequence = 1 WHERE id = 1").run();
  const texts = [
    objective,
    "Danny bounced — the address on file is his old Mucker one.",
    "Use danny@mucker.com.",
    "Sent. Do you want the Tuesday call mentioned?",
    "Yes, and include the download link for Mucker.",
  ];
  for (let index = 0; index < count; index += 1) {
    seedCanonicalConversationTurn(objectStore, {
      turnId: `00000000-0000-7000-8000-00000000c0${String(index).padStart(2, "0")}`,
      clientMessageId: `seed-${index}`,
      actor: index % 2 === 0 ? "human" : "assistant",
      authorUserId: index % 2 === 0 ? userId : null,
      authorSnapshot: index % 2 === 0
        ? { displayName: "Test user at posting time", avatarUrl: null }
        : null,
      text: texts[index % texts.length] ?? `Message ${index}`,
      transcriptSequence: index + 1,
      createdAt: at,
    });
  }
}

function description(database: DatabaseSync): string {
  return workstreamObjectRootRow<{ description: string }>(objectStoreOf(database), "description").description;
}

function workstreamRow(
  database: DatabaseSync,
): { title: string; title_status: string; appearance_json: string | null } {
  return workstreamObjectRootRow<{
    title: string;
    title_status: string;
    appearance_json: string | null;
  }>(objectStoreOf(database), "title, title_status, appearance_json");
}

/** The stored appearance, or `null` where the work stream has none. */
function appearance(database: DatabaseSync): unknown {
  const stored = workstreamRow(database).appearance_json;
  return stored === null ? null : JSON.parse(stored);
}

function title(database: DatabaseSync): string {
  return workstreamRow(database).title;
}

/**
 * Answers one OpenRouter structured request, recording what was asked.
 *
 * The icon defaults to one the fixture never stores, so a test that does not
 * care about the icon still proves the pass wrote whatever the model chose
 * rather than a constant.
 */
function stubOpenRouter(
  requests: Array<Record<string, unknown>>,
  generatedTitle: string,
  beforeResponding?: () => void,
  generatedIcon: unknown = "megaphone",
  generatedSummary?: string,
): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    beforeResponding?.();
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: generatedTitle,
        icon: generatedIcon,
        ...(generatedSummary === undefined ? {} : { summary: generatedSummary }),
      }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

function environment(
  database: DatabaseSync,
  published: Array<Record<string, unknown>>,
  transcriptOperations: string[] = [],
  identityOperations: string[] = [],
): Env {
  const objectStore = objectStoreOf(database);
  // The naming service reads its transcript through the message port, which
  // dispatches `executeMessageOperation` on this binding. The helper answers it
  // against the same object store the fixture seeds, so the read under test is
  // the real storage class rather than a stub of it.
  const rooms = testSubstreamAgentsBinding(objectStore, {
    extra: {
      publishEvent: async (input: { event: Record<string, unknown> }) => {
        published.push(input.event);
        return { status: 202, bodyJson: "null" };
      },
    },
  });
  // Records which transcript operations the service actually dispatches, so a
  // test can assert that a settled work stream reads no transcript at all.
  const recorded = new Proxy(rooms, {
    get(namespaceTarget, namespaceProperty, namespaceReceiver) {
      if (namespaceProperty !== "get") {
        return Reflect.get(namespaceTarget, namespaceProperty, namespaceReceiver);
      }
      return (id: DurableObjectId) => new Proxy(namespaceTarget.get(id), {
        get(target, property, receiver) {
          const recorder = property === "executeMessageOperation" ? transcriptOperations
            : property === "executeIdentityOperation" ? identityOperations
              : null;
          if (!recorder) return Reflect.get(target, property, receiver);
          const dispatch = Reflect.get(target, property, receiver) as
            (input: { operation: string }) => unknown;
          return (input: { operation: string }) => {
            recorder.push(input.operation);
            return dispatch.call(target, input);
          };
        },
      });
    },
  });
  return createTestEnv({
      DB: sqliteD1(database),
      APP_ENV: "test",
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
      OPENROUTER_FALLBACK_MODELS: "",
      PUBLIC_API_BASE_URL: "https://api.test.with-avalon.com",
      SUBSTREAM_AGENTS: recorded,
    });
}

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'google-owner', 'owner@example.com', 'Owner', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Avalon', 'avalon', 'global', '${userId}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '${at}');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
    VALUES ('${workstreamId}', '${workspaceId}', 'directory copy', 'directory copy', 'ad_hoc',
            '${userId}', 'running', 2, '${at}', '${at}', '${at}');
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  objectStores.set(database, objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId,
    workspaceId,
    title: provisionalTitle,
    titleStatus: "naming",
    description: objective,
    emailAddress: "calm-bright-gentle-otter@automation.with-avalon.com",
    emailRouteStatus: "active",
    originType: "ad_hoc",
    createdByUserId: userId,
    exactState: "running",
    nextSequenceNumber: 2,
  }, Date.parse(at));
  return database;
}
