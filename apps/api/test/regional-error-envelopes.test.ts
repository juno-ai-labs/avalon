import { describe, expect, it } from "vitest";
import { ConnectorError } from "@rally/connectors";

import { ApiError } from "../src/lib/api-error";
import { serializeAshbyRpcResult } from "../src/services/ashby-routing-service";
import { serializeGitHubRegionalRpcResult } from "../src/services/github-routing-service";
import { serializeLinearRpcResult } from "../src/services/linear-routing-service";
import { serializeNotionRpcResult } from "../src/services/notion-routing-service";
import { serializeResendRegionalRpcResult } from "../src/services/resend-inbound-email-service";
import { serializeSlackRpcResult } from "../src/services/slack-routing-service";

// Every regional bridge runs the work-stream fence, and every one rebuilds the
// refusal on the Global side from its envelope. An envelope that drops
// `diagnosticCode` turns a D1 failure behind the fence back into a bare
// `workstream_maintenance` on the Global `request_failed` row.
const serializers = {
  ashby: serializeAshbyRpcResult,
  github: serializeGitHubRegionalRpcResult,
  linear: serializeLinearRpcResult,
  notion: serializeNotionRpcResult,
  resend: serializeResendRegionalRpcResult,
  slack: serializeSlackRpcResult,
};

describe("regional RPC error envelopes", () => {
  it.each(Object.entries(serializers))("%s carries an ApiError's diagnostic code across the hop", async (_name, serialize) => {
    const result = await serialize(async () => {
      throw new ApiError(
        503,
        "workstream_maintenance",
        "Work-stream maintenance is in progress",
        undefined,
        "authority_control_read_failed:d1_overloaded",
      );
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "workstream_maintenance", diagnosticCode: "authority_control_read_failed:d1_overloaded" },
    });
  });

  it.each([
    ["ashby", serializeAshbyRpcResult],
    ["linear", serializeLinearRpcResult],
    ["notion", serializeNotionRpcResult],
  ] as const)("%s names the provider's status behind a connector failure", async (_name, serialize) => {
    const result = await serialize(async () => {
      throw new ConnectorError("provider_error", "Not Found", { status: 404 });
    });
    expect(result).toMatchObject({ ok: false, error: { diagnosticCode: "provider_error:http_404" } });
  });
});
