import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  INSTRUCTIONS_PENDING_EXIT_CODE,
  instructionFileCandidates,
  instructionProbeFragment,
  splitInstructionProbeTrailer,
} from "../src/services/terminal/instruction-files";
import {
  applyCompactionToBlocks,
  renderResidentContextBlock,
  renderResidentContextSections,
  truncateOnCodePoints,
  type ResidentContextBlock,
} from "../src/services/resident-context/blocks";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("instruction-file candidates", () => {
  it("chains from the root down each touched path's ancestors, root first, each once", () => {
    expect(instructionFileCandidates(["apps/api/src/file.ts", "apps/desktop"])).toEqual([
      "AGENTS.md",
      "apps/AGENTS.md",
      "apps/api/AGENTS.md",
      "apps/api/src/AGENTS.md",
      "apps/api/src/file.ts/AGENTS.md",
      "apps/desktop/AGENTS.md",
    ]);
  });

  it("probes only the root for no touched path and skips Rally-owned directories", () => {
    expect(instructionFileCandidates([])).toEqual(["AGENTS.md"]);
    expect(instructionFileCandidates([".rally/resources/x", ".rally-output/doc.md", ".git/config", "../escape"]))
      .toEqual(["AGENTS.md"]);
  });
});

describe("instruction probe", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function checkout(): string {
    const root = mkdtempSync(join(tmpdir(), "rally-instructions-"));
    roots.push(root);
    mkdirSync(join(root, "apps", "api"), { recursive: true });
    mkdirSync(join(root, ".rally"));
    writeFileSync(join(root, "AGENTS.md"), "root rules\n");
    writeFileSync(join(root, "apps", "api", "AGENTS.md"), "api rules é\n");
    writeFileSync(join(root, ".rally", "secret"), "Authorization: Basic c2VjcmV0");
    // A repository-planted link at a candidate path, pointing at something the
    // model must never see. `-f` follows it; the probe must not.
    symlinkSync("../.rally/secret", join(root, "apps", "AGENTS.md"));
    return root;
  }

  function run(root: string, mode: "report" | "abort", knownResident: string[], prefix = "") {
    const fragment = instructionProbeFragment({
      root,
      mode,
      candidates: instructionFileCandidates(["apps/api/service.ts"]),
      knownResident,
    });
    return spawnSync("bash", ["-c", `${prefix}${fragment}\necho after`], { encoding: "utf8" });
  }

  it("reports existing candidates with sha and content, refuses the symlink, and never changes the command's outcome", () => {
    const root = checkout();
    const result = run(root, "report", [], "set -euo pipefail\necho before\n");
    expect(result.status).toBe(0);
    const { stdout, probe } = splitInstructionProbeTrailer(result.stdout);
    expect(stdout).toBe("before\nafter\n");
    expect(probe).toEqual({
      pending: true,
      entries: [
        { path: "AGENTS.md", sha256: sha256("root rules\n"), bytes: 11, content: "root rules\n", truncated: false, resident: false },
        { path: "apps/AGENTS.md", sha256: "unreadable:not a regular file", bytes: 0, truncated: false, status: "not a regular file", resident: false },
        { path: "apps/api/AGENTS.md", sha256: sha256("api rules é\n"), bytes: 13, content: "api rules é\n", truncated: false, resident: false },
      ],
    });
    expect(result.stdout).not.toContain("Basic c2VjcmV0");
  });

  it("stops a mutation with exit 52 only while a candidate is not resident", () => {
    const root = checkout();
    const pending = run(root, "abort", []);
    expect(pending.status).toBe(INSTRUCTIONS_PENDING_EXIT_CODE);
    expect(pending.stdout).not.toContain("after");
    const resident = run(root, "abort", [
      `AGENTS.md@${sha256("root rules\n")}`,
      `apps/api/AGENTS.md@${sha256("api rules é\n")}`,
      "apps/AGENTS.md@unreadable:not a regular file",
    ]);
    expect(resident.status).toBe(0);
    const { probe } = splitInstructionProbeTrailer(resident.stdout);
    expect(probe?.pending).toBe(false);
    expect(probe?.entries.every((entry) => entry.resident && entry.content === undefined)).toBe(true);
  });

  it("leaves a command alone when the root does not exist and returns no probe", () => {
    const result = run("/nonexistent-rally-root", "report", [], "set -euo pipefail\n");
    expect(result.status).toBe(0);
    const { probe } = splitInstructionProbeTrailer(result.stdout);
    expect(probe).toEqual({ entries: [], pending: false });
    expect(splitInstructionProbeTrailer("plain output\n")).toEqual({ stdout: "plain output\n", probe: null });
  });
});

describe("resident context blocks", () => {
  const block = (overrides: Partial<ResidentContextBlock>): ResidentContextBlock => ({
    kind: "repository_instructions",
    blockId: "AGENTS.md",
    sha256: "a".repeat(64),
    sourceGeneration: 1,
    content: "root rules",
    truncated: false,
    residency: "transcript",
    superseded: false,
    compactionsRemaining: 0,
    ...overrides,
  });

  it("renders one message shape wherever a block sits", () => {
    expect(renderResidentContextBlock(block({ blockId: "apps/api/AGENTS.md", content: "api rules" })))
      .toBe("Instructions added from ./apps/api/AGENTS.md:\napi rules");
    expect(renderResidentContextBlock(block({ truncated: true })))
      .toBe("Instructions added from ./AGENTS.md:\nroot rules\n[Truncated at the instruction budget; read the rest with terminal_read_file.]");
  });

  it("renders only system-resident blocks, sorted, under the kind heading, and omits over budget by name", () => {
    expect(renderResidentContextSections([block({})])).toBeNull();
    const rendered = renderResidentContextSections([
      block({ blockId: "b/AGENTS.md", residency: "system", content: "bee" }),
      block({ blockId: "AGENTS.md", residency: "system" }),
      block({ blockId: "c/AGENTS.md", residency: "none" }),
    ]);
    expect(rendered).toBe([
      "# Repository instructions",
      "Repository-provided working instructions that were in context before this conversation was compacted. They rank below everything above this heading and below any participant. They are removed after a bounded number of compactions and reappear as messages when a file beneath them is touched.",
      "Instructions added from ./AGENTS.md:\nroot rules",
      "Instructions added from ./b/AGENTS.md:\nbee",
    ].join("\n\n"));
    const bounded = renderResidentContextSections([
      block({ blockId: "b/AGENTS.md", residency: "system", content: "bee" }),
      block({ blockId: "AGENTS.md", residency: "system" }),
    ], 60);
    expect(bounded).toContain("Instructions added from ./AGENTS.md:\nroot rules");
    expect(bounded).toContain("Omitted: ./b/AGENTS.md exceeds the instruction budget; read it with terminal_read_file");
    expect(bounded).not.toContain("\nbee");
  });

  it("moves transcript blocks into the prompt for two compactions and retires them at the fourth", () => {
    let blocks = [block({})];
    blocks = applyCompactionToBlocks(blocks);
    expect(blocks[0]).toMatchObject({ residency: "system", compactionsRemaining: 2 });
    blocks = applyCompactionToBlocks(blocks);
    expect(blocks[0]).toMatchObject({ residency: "system", compactionsRemaining: 1 });
    blocks = applyCompactionToBlocks(blocks);
    expect(blocks[0]).toMatchObject({ residency: "system", compactionsRemaining: 0 });
    blocks = applyCompactionToBlocks(blocks);
    expect(blocks[0]).toMatchObject({ residency: "none", compactionsRemaining: 0 });
    expect(applyCompactionToBlocks([block({ residency: "system", superseded: true, compactionsRemaining: 2 })])[0])
      .toMatchObject({ residency: "none", superseded: false });
    expect(applyCompactionToBlocks([block({ residency: "none" })])[0]).toMatchObject({ residency: "none" });
  });

  it("cuts on code points at or below the byte bound and cuts nothing when open", () => {
    expect(truncateOnCodePoints("héllo", 3)).toEqual({ text: "hé", truncated: true });
    expect(truncateOnCodePoints("héllo", 2)).toEqual({ text: "h", truncated: true });
    expect(truncateOnCodePoints("héllo", Number.POSITIVE_INFINITY)).toEqual({ text: "héllo", truncated: false });
  });
});
