import { describe, expect, it } from "vitest";

import { agentProfileFor } from "../src/services/agent-profiles";

describe("agent profiles", () => {
  it("names an ordinary conversation null and refuses a profile this Worker does not have", () => {
    expect(agentProfileFor(null)).toBeNull();
    expect(agentProfileFor(undefined)).toBeNull();
    // A conversation stored with the retired import profile must be refused,
    // never run with the ordinary tool surface.
    expect(() => agentProfileFor("session_import")).toThrow(expect.objectContaining({ code: "agent_profile_unknown" }));
    expect(() => agentProfileFor("retired_profile")).toThrow(expect.objectContaining({ code: "agent_profile_unknown" }));
  });
});
