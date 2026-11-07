/**
 * The one ceiling on text a person composes, and the sentence they get above it.
 *
 * On 2026-08-24 a pasted meeting-agenda template opened a work stream that never
 * existed. `CreateWorkstreamRequestSchema` took an opening message of 50,000
 * characters; the description derived from it inside the AgentLoopDO was
 * bounded at 4,000; and a message between the two passed the route, reserved an
 * email address, wrote its D1 rows, and then failed the object's own schema with
 * `invalid_product_request` — which the Worker translated for the person as "The
 * work stream could not be loaded", a sentence about reading a work stream, on a
 * request that was creating one.
 *
 * Two boundaries disagreeing is the defect. These tests hold them together: one
 * constant bounds opening and socket message contracts, the description is
 * derived rather than inherited, and the refusal above the ceiling is the
 * person's to act on rather than the object's to describe.
 */
import {
  CreateMessageRequestSchema,
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  WORKSTREAM_DESCRIPTION_MAX_CHARACTERS,
} from "@rally/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { InitializeWorkstreamObjectInputSchema } from "../src/durable-objects/workstream-object-product";
import { errorHandler } from "../src/middleware/errors";
import { conversationRoutes } from "../src/routes/conversations";
import { provisionalWorkstreamDescription } from "../src/services/workstream-description-service";
import { provisionalWorkstreamTitle } from "../src/services/workstream-naming-service";
import { createTestEnv } from "./helpers/cloudflare-test";

/**
 * The routes under their own app, with no authentication in front of them.
 *
 * The length guard is the first middleware on each route, so it answers before
 * anything reads a session — which is the point of testing it here: a refusal
 * that needed a session would already have cost the round trip it exists to
 * save. A request the guard passes falls through to the real handler and fails
 * there for want of auth, which is what the boundary assertions read as "not
 * refused for length".
 */
function routedApp() {
  const app = new Hono<HonoAppEnv>();
  app.route("/conversations", conversationRoutes);
  app.onError(errorHandler);
  return app;
}

async function post(path: string, body: unknown): Promise<{ status: number; code: unknown; message: unknown }> {
  const response = await routedApp().request(
    `https://api.example.com${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error" }),
  );
  const payload = await response.json().catch(() => null) as
    { error?: { code?: unknown; message?: unknown } } | null;
  return { status: response.status, code: payload?.error?.code, message: payload?.error?.message };
}

const workstreamId = "00000000-0000-7000-8000-0000000000c1";
const messagesPath = `/conversations/${workstreamId}/substreams/0/messages`;

function messageBody(text: string) {
  return { text, clientMessageId: "client-1" };
}

describe("the message ceiling", () => {
  it("names the ceiling and the remedy, in the words the composer uses", () => {
    // The composer shows this string without a round trip and the API returns
    // it with one. A person who meets both must not be told two things, so the
    // sentence itself is the contract rather than each surface's wording of it.
    expect(MESSAGE_TOO_LONG_MESSAGE).toBe("This message is over 100,000 characters, please shorten it.");
    expect(MESSAGE_MAX_CHARACTERS).toBe(100_000);
  });

  it("refuses a message over the ceiling before the conversation is touched", async () => {
    const refused = await post(messagesPath, messageBody("x".repeat(MESSAGE_MAX_CHARACTERS + 1)));

    expect(refused.status).toBe(400);
    expect(refused.code).toBe("message_too_long");
    expect(refused.message).toBe(MESSAGE_TOO_LONG_MESSAGE);
  });

  it("lets a message at exactly the ceiling through the guard, and leaves the body readable behind it", async () => {
    // Two assertions in one request, and the second is the load-bearing one.
    //
    // `authentication_required` rather than merely "not message_too_long":
    // reaching the handler at all proves `zValidator` parsed this body *after*
    // the guard had already read it. The guard's safety rests on Hono caching
    // the parsed body, which is a property of Hono rather than of this code —
    // if that ever stopped holding, the validator would meet a drained stream
    // and answer `invalid_request`, and asserting only the absence of
    // `message_too_long` would sail straight past it.
    //
    // The first assertion is the off-by-one: a person told to shorten a message
    // that was never too long.
    const create = await post(messagesPath, messageBody("x".repeat(MESSAGE_MAX_CHARACTERS)));

    // Reaching the session check proves the handler ran, so the body was still
    // there to be parsed after the guard read it.
    expect(create.code).toBe("authentication_required");
  });

  it("leaves a body it cannot read to the validator", async () => {
    // The guard answers for one bound and claims nothing else. A body that is
    // not JSON, or that carries no message where one belongs, is a malformed
    // request rather than a long one, and saying "shorten it" to either would
    // send the caller after the wrong thing.
    const notJson = await post(messagesPath, "{not json");
    const noMessage = await post(messagesPath, { clientMessageId: "client-1" });

    // Both pass the guard and reach the session check, which the validator
    // sits behind.
    expect(notJson.code).toBe("authentication_required");
    expect(noMessage.code).toBe("authentication_required");
  });

  it("bounds every schema the message travels through at the same number", () => {
    const atCeiling = "x".repeat(MESSAGE_MAX_CHARACTERS);
    const overCeiling = "x".repeat(MESSAGE_MAX_CHARACTERS + 1);

    expect(CreateMessageRequestSchema.safeParse(messageBody(atCeiling)).success).toBe(true);
    expect(CreateMessageRequestSchema.safeParse(messageBody(overCeiling)).success).toBe(false);
  });
});

describe("the description a long message opens with", () => {
  it("is the opening line, not the opening message", () => {
    const message = [
      "Create an agenda for the pricing meeting today. Use the format below.",
      "",
      "# Decision Meeting: [Decision name]",
      "**Date:**",
    ].join("\n");

    expect(provisionalWorkstreamDescription(message, "Review the attached files"))
      .toBe("Create an agenda for the pricing meeting today. Use the format below.");
  });

  it("stays inside the description ceiling for a message at the message ceiling", () => {
    // The incident in one assertion: a one-line message of the largest size the
    // composer now accepts, and the description derived from it. Before this
    // change the derivation was the message itself, and everything below was
    // the 4,000-character bound it had already broken.
    const description = provisionalWorkstreamDescription("x".repeat(MESSAGE_MAX_CHARACTERS), "Review the attached files");

    expect(description.length).toBe(WORKSTREAM_DESCRIPTION_MAX_CHARACTERS);
    expect(InitializeWorkstreamObjectInputSchema.safeParse({
      workspaceId: "00000000-0000-7000-8000-0000000000b0",
      workstreamId,
      generation: 1,
      title: provisionalWorkstreamTitle(description, "New work stream"),
      objective: description,
      descriptionSource: "derived",
      titleStatus: "naming",
      emailAddress: "route@automation.with-avalon.com",
      creatorUserId: "00000000-0000-7000-8000-0000000000a1",
      openingMessage: "x".repeat(MESSAGE_MAX_CHARACTERS),
      openingStructuredContent: null,
      clientMessageId: "client-1",
      participantUserIds: [],
      attachmentIds: [],
      originResourceIds: [],
      modelOverride: null,
      systemKind: null,
      createdFromOpportunityId: null,
      opportunityVersion: null,
      opportunityDisplayPromptHash: null,
      opportunityExecutionPromptHash: null,
      executionPrincipal: { type: "user", userId: "00000000-0000-7000-8000-0000000000a1" },
      reason: "opening_message",
    }).success).toBe(true);
  });

  it("falls back rather than describing a work stream with nothing", () => {
    expect(provisionalWorkstreamDescription("   \n\n  ", "Review the attached files"))
      .toBe("Review the attached files");
  });
});
