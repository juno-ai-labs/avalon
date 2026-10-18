import { describe, expect, it, vi } from "vitest";
import {
  normalizePastedTextName,
  preparePastedTextWithClient,
} from "../src/services/pasted-text-service";
import { createTestEnv } from "./helpers/cloudflare-test";

const env = createTestEnv({});

function request(text: string) {
  return {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000003",
    file: new File([text], "Pasted text 2026-08-11 at 09.04.05.txt", { type: "text/plain" }),
  };
}

describe("pasted text", () => {
  it("stores a paste under its detected type and a name drawn from its content", async () => {
    const infer = vi.fn(async () => "Q3 launch plan");

    const file = await preparePastedTextWithClient(env, infer, request("# Q3 launch\n\nShip it."));

    expect(file.name).toBe("Pasted - Q3 launch plan.md");
    expect(file.type).toBe("text/markdown");
    expect(await file.text()).toBe("# Q3 launch\n\nShip it.");
  });

  it("keeps the stand-in name under the detected extension when the model fails", async () => {
    const infer = vi.fn(async () => { throw new Error("provider down"); });

    const file = await preparePastedTextWithClient(env, infer, request('{"region": "EU"}'));

    expect(file.name).toBe("Pasted text 2026-08-11 at 09.04.05.json");
    expect(file.type).toBe("application/json");
  });

  it("makes a model answer safe to use as a file name", () => {
    expect(normalizePastedTextName(" Q3: launch/plan?.md ", "md")).toBe("Q3 launch plan");
    expect(normalizePastedTextName("...", "md")).toBeNull();
    expect(normalizePastedTextName(`${"word ".repeat(20)}`, "md")).toBe("word word word word word word word word word word word word");
  });
});
