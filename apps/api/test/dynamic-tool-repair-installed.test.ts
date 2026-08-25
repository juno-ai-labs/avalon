import { describe, expect, it, vi } from "vitest";

import type * as AgentHarness from "@rally/agent-harness";

/**
 * That the host-side repair is still wired into `validateDynamicConnectorTools`.
 *
 * Its sibling in `tool-schema-sanitization.test.ts` asserts the outcome — that
 * nothing a remote server serves reaches the wire with an unreadable root branch
 * — which is the right property to assert, but under bind 13 the sanitizer
 * supplies it unaided. Deleting the repair from `integrations.ts` entirely left
 * that file green, so nothing pinned the layer's existence.
 *
 * Stubbing `repairRootUnionForProviders` itself is what closes that: it proves
 * the gate is called for every discovered definition and that its return value
 * is the one carried forward, independently of what any bind version does with
 * the schema. The rule the real implementation applies is covered in the harness
 * package; this is about the wiring only.
 */
const repairSpy = vi.hoisted(() => vi.fn(
  (schema: Record<string, unknown>) => ({ ...schema, "x-repaired": true }),
));

vi.mock("@rally/agent-harness", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentHarness>()),
  repairRootUnionForProviders: repairSpy,
}));

const { __integrationTesting } = await import("../src/services/integrations");
const { createTestEnv } = await import("./helpers/cloudflare-test");
const { createTestConnectorRegistry } = await import("./helpers/connector-registry");

describe("the dynamic-tool repair is installed", () => {
  it("routes every discovered schema through the repair and carries its result", () => {
    repairSpy.mockClear();
    const registry = createTestConnectorRegistry();
    const adapter = registry.get("notion");
    const capability = adapter.dynamicAgentTools?.capabilities[0];
    if (!capability) throw new Error("expected Notion to declare a dynamic capability");

    const remoteSchema = {
      type: "object",
      properties: { pageId: { type: "string" }, discussionId: { type: "string" } },
      oneOf: [{ required: ["pageId"] }, { required: ["discussionId"] }],
    };

    const [definition] = __integrationTesting.validateDynamicConnectorTools(
      createTestEnv({}),
      adapter,
      "personal",
      [capability],
      "notion",
      [{
        name: "remote_tool",
        description: "A tool served by a third-party MCP server.",
        capability,
        mode: "write",
        idempotency: "record_before_execute",
        inputSchema: remoteSchema,
      }],
    );

    expect(repairSpy).toHaveBeenCalledWith(remoteSchema);
    expect((definition!.inputSchema as Record<string, unknown>)["x-repaired"]).toBe(true);
  });
});
