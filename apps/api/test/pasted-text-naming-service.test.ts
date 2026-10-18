import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  namePastedTextWithClient,
  normalizePastedTextName,
} from "../src/services/pasted-text-naming-service";

const env = createTestEnv({});

function request(text: string) {
  return {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000003",
    fileName: "Pasted text 2026-08-11 at 09.04.05.md",
    text,
  };
}

describe("pasted text naming", () => {
  it("names the file from its content and keeps the client's extension", async () => {
    const infer = vi.fn(async () => "Q3 launch plan");

    await expect(namePastedTextWithClient(env, infer, request("# Q3 launch\n..."))).resolves.toBe("Q3 launch plan.md");
  });

  it("keeps the stand-in name when the model fails", async () => {
    const infer = vi.fn(async () => { throw new Error("provider down"); });

    await expect(namePastedTextWithClient(env, infer, request("text"))).resolves.toBeNull();
  });

  it("makes a model answer safe to use as a file name", () => {
    expect(normalizePastedTextName(" Q3: launch/plan?.md ", "md")).toBe("Q3 launch plan");
    expect(normalizePastedTextName("...", "md")).toBeNull();
    expect(normalizePastedTextName(`${"word ".repeat(20)}`, "md")).toBe("word word word word word word word word word word word word");
  });
});
