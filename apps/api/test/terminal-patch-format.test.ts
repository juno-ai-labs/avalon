import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APPLY_PATCH_SCRIPT,
  APPLY_PATCH_SCRIPT_SHA256,
  detectPatchFormat,
  parsePatch,
} from "../src/services/terminal/patch-format";

const envelope = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("apply_patch formats", () => {
  it("vendors OpenAI's reference applier unmodified and imports it as text", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("../src/services/terminal/vendor/apply_patch.py", import.meta.url)), "utf8");
    expect(APPLY_PATCH_SCRIPT).toBe(onDisk);
    expect(createHash("sha256").update(APPLY_PATCH_SCRIPT).digest("hex")).toBe(APPLY_PATCH_SCRIPT_SHA256);
    // The contract the runtime relies on, pinned here so a re-vendored script
    // that changes it is noticed at the hash and confirmed at the text.
    expect(APPLY_PATCH_SCRIPT).toContain("patch_text = sys.stdin.read()");
    expect(APPLY_PATCH_SCRIPT).toContain('return "Done!"');
    expect(APPLY_PATCH_SCRIPT).toContain("from pydantic import BaseModel, Field");
  });

  it("tells the envelope from a unified diff by the first non-blank line", () => {
    expect(detectPatchFormat("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBe("unified");
    expect(detectPatchFormat("\n\n*** Begin Patch\n*** End Patch\n")).toBe("openai");
    expect(detectPatchFormat("*** Begin Patch  \n*** End Patch")).toBe("openai");
    // A context diff also opens with `***`, but names a file there.
    expect(detectPatchFormat("*** x.txt\t2026-09-19\n--- x.txt\t2026-09-19\n")).toBe("unified");
    expect(detectPatchFormat(" *** Begin Patch\n")).toBe("unified");
  });

  it("reads sections, moves and counts from the envelope", () => {
    const { format, output } = parsePatch(envelope(
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@ export function a() {",
      " context",
      "-old",
      "+new",
      "+newer",
      "",
      "*** End of File",
      "*** Add File: docs/new.md",
      "+# Title",
      "+",
      "*** Delete File: old.txt",
    ));
    expect(format).toBe("openai");
    expect(output).toEqual({
      files: [
        { path: "src/b.ts", previousPath: "src/a.ts", operation: "renamed", additions: 2, deletions: 1 },
        { path: "docs/new.md", operation: "created", additions: 2, deletions: 0 },
        { path: "old.txt", operation: "deleted", additions: 0, deletions: 0 },
      ],
      additions: 4,
      deletions: 1,
    });
  });

  it("refuses an unclosed envelope, an escaping path, and lines outside a section", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Add File: x\n+y\n")).toThrow(expect.objectContaining({ code: "patch_invalid" }));
    expect(() => parsePatch(envelope("*** Add File: ../x", "+y"))).toThrow(expect.objectContaining({ code: "path_outside_root" }));
    expect(() => parsePatch(envelope("*** Update File: a", "*** Move to: /etc/x", "-y"))).toThrow(expect.objectContaining({ code: "path_outside_root" }));
    expect(() => parsePatch(envelope("+stray", "*** Add File: x", "+y"))).toThrow(expect.objectContaining({
      code: "patch_invalid",
      message: "Line 2 of the patch precedes the first file section. Regenerate the patch and retry.",
    }));
    expect(() => parsePatch(envelope("*** Add File: x", " context"))).toThrow(expect.objectContaining({ code: "patch_invalid" }));
    expect(() => parsePatch(envelope("*** Delete File: x", "-y"))).toThrow(expect.objectContaining({ code: "patch_invalid" }));
    expect(() => parsePatch(envelope("*** Add File: x", "+y", "*** Add File: x", "+z"))).toThrow(expect.objectContaining({ code: "patch_invalid" }));
    expect(() => parsePatch(envelope())).toThrow(expect.objectContaining({ code: "patch_invalid" }));
  });

  it("still reads a unified diff, and names both formats when it finds neither", () => {
    expect(parsePatch("--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n")).toEqual({
      format: "unified",
      output: { files: [{ path: "x.txt", operation: "edited", additions: 1, deletions: 1 }], additions: 1, deletions: 1 },
    });
    expect(() => parsePatch("just text\n")).toThrow(expect.objectContaining({
      code: "patch_invalid",
      message: "No file changes were found. Send a unified diff with --- and +++ headers, or a patch that opens with *** Begin Patch, and retry.",
    }));
  });
});
