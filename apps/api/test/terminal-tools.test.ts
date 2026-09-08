import { asUserId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { TERMINAL_TOOL_DEFINITIONS } from "../src/services/terminal/contract";
import {
  createTerminalToolExecutors,
  sanitizeTerminalOutput,
  TerminalToolError,
  type TerminalRuntime,
} from "../src/services/terminal/tools";

const context: HarnessToolContext = {
  workspaceId: "workspace-1",
  workstreamId: "workstream-1",
  harnessRunId: "run-1",
  toolCallId: "call-1",
  executionPrincipal: { type: "user", userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904") },
  signal: new AbortController().signal,
};

function runtime(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, content]) => [path, new TextEncoder().encode(content)]),
  );
  const value: TerminalRuntime = {
    async readFile(_context, path) { return files.get(path) ?? null; },
    async readFilePage(_context, path, offset, limit) {
      const bytes = files.get(path);
      if (!bytes) return null;
      const text = new TextDecoder().decode(bytes);
      const lines = text ? text.split("\n") : [];
      if (lines.at(-1) === "") lines.pop();
      const selected: string[] = [];
      let selectedBytes = 0;
      for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
        const encoded = new TextEncoder().encode(`${selected.length ? "\n" : ""}${line}`);
        if (selectedBytes + encoded.byteLength > 256 * 1_024) break;
        selected.push(line);
        selectedBytes += encoded.byteLength;
      }
      const endLine = selected.length ? offset + selected.length - 1 : Math.min(offset - 1, lines.length);
      const truncated = endLine < lines.length;
      return {
        content: selected.join("\n"), startLine: offset, endLine, totalLines: lines.length, truncated,
        ...(truncated ? { nextOffset: endLine + 1 } : {}),
      };
    },
    async writeFile(_context, path, bytes, options) {
      const previous = files.get(path);
      const previousText = options?.previousText
        ?? (previous ? new TextDecoder().decode(previous) : "");
      const previousLines = previousText
        ? previousText.split("\n").length - Number(previousText.endsWith("\n"))
        : 0;
      files.set(path, bytes);
      return { created: previous === undefined, previousLines };
    },
    async applyPatch() { return { files: [], additions: 0, deletions: 0 }; },
    async runCommand(_context, input) {
      return {
        state: input.command === "false" ? "failed" : "completed",
        terminationReason: "exited",
        exitCode: input.command === "false" ? 1 : 0,
        stdout: input.command === "false" ? "" : "ok\n",
        stderr: input.command === "false" ? "failed\n" : "",
        startedAt: "2026-08-13T00:00:00.000Z",
        completedAt: "2026-08-13T00:00:00.010Z",
        acquisitionDurationMs: 7,
        totalDurationMs: 17,
      };
    },
    async checkoutRepository(_context, input) {
      return {
        repository: input.repositoryFullName,
        repositoryId: 41,
        connectionId: "connection-1",
        connectionName: "GitHub",
        baseRef: "main",
        baseSha: "a".repeat(40),
        headRef: "avalon/workstream-1",
        remoteAccess: input.requiredRemoteAccess,
        localEditsAllowed: true,
        remoteWritesAllowed: input.requiredRemoteAccess === "full_access",
        outcome: "selected",
        backup: null,
      };
    },
    async importResource(_context, input) {
      return { resourceId: input.resourceId, filePath: ".rally/resources/item", outcome: "created", mimeType: "text/plain", sizeBytes: 4, sourceSha256: "a".repeat(64) };
    },
    async publishResource() {
      return {
        resourceId: "resource-published",
        title: "Chart",
        publishKind: "file", resourceType: "generated_file",
        provider: "avalon_generated",
        mimeType: "image/png",
        sizeBytes: 42,
        sourceSha256: "b".repeat(64),
        attachmentKind: "image",
        contentMode: "view",
        derivativeStatus: "ready",
        createdAt: "2026-08-13T00:00:00.000Z",
      };
    },
    async publishBranchAndPr() {
      return {
        repository: "avalon/repo",
        baseRef: "main",
        headRef: "avalon/workstream-1",
        commitSha: "c".repeat(40),
        publishedSha: "c".repeat(40),
        outcome: "created",
        pullRequest: { number: 17, url: "https://github.com/avalon/repo/pull/17", title: "Ship", state: "open" },
      };
    },
  };
  return { value, files };
}

function toolDefinition(name: string) {
  const definition = TERMINAL_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) throw new Error(`no terminal tool named ${name}`);
  return definition;
}

describe("what the publish tool advertises to the model", () => {
  it("names the directory case, because the standing policy tells the model to use it", () => {
    // The policy says "Publish the directory, not a file inside it" on every
    // turn. While this description still said "one stable non-empty regular
    // file", the only surface the model reads to build the call contradicted
    // it, and the whole directory capability was undiscoverable from the tool.
    const { description } = toolDefinition("publish_resource");
    expect(description).toContain("directory");
    expect(description).toContain("publishKind");
    expect(description).not.toContain("Publish one stable non-empty regular file beneath");
  });

  it("tells the model that importing a site materializes a tree, not a file", () => {
    // `overwrite` means something different for a site — whole-tree
    // replacement, never a merge — and a model that reads the old wording
    // would overwrite a directory believing it was replacing one file.
    const schema = JSON.stringify(toolDefinition("import_resource").inputSchema);
    expect(schema).toContain("directory root");
    expect(schema).not.toContain("Replace an existing regular file only when intentional.");
  });
});

describe("Terminal file and command tools", () => {
  it("freezes exact success envelopes for all nine model-facing tools", async () => {
    const { value } = runtime({ "notes.txt": "old\n" });
    const tools = createTerminalToolExecutors(value);
    const calls = [
      ["read_file", { filePath: "notes.txt" }, {
        output: { filePath: "notes.txt", content: "old", startLine: 1, endLine: 1, totalLines: 1, truncated: false },
        summary: "Read notes.txt lines 1–1",
      }],
      ["edit_file", { filePath: "notes.txt", oldString: "old", newString: "new" }, {
        output: { filePath: "notes.txt", replacements: 1, additions: 1, deletions: 1 }, summary: "Edited notes.txt",
      }],
      ["write_file", { filePath: "created.txt", content: "hello\n" }, {
        output: { filePath: "created.txt", created: true, bytes: 6, additions: 1, deletions: 0 }, summary: "Created created.txt",
      }],
      ["apply_patch", { patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-new\n+newer\n" }, {
        output: { files: [], additions: 0, deletions: 0 }, summary: "Patched 0 files",
      }],
      ["run_command", { command: "printf ok" }, {
        output: {
          state: "completed", terminationReason: "exited", exitCode: 0, stdout: "ok\n", stderr: "",
          startedAt: "2026-08-13T00:00:00.000Z", completedAt: "2026-08-13T00:00:00.010Z",
          acquisitionDurationMs: 7, totalDurationMs: 17,
          stdoutTruncated: false, stderrTruncated: false, durationMs: 10,
        },
        summary: "Completed printf ok",
      }],
      ["checkout_repository", { repositoryFullName: "avalon/repo", requiredRemoteAccess: "read_only" }, {
        output: {
          repository: "avalon/repo", repositoryId: 41, connectionId: "connection-1", connectionName: "GitHub",
          baseRef: "main", baseSha: "a".repeat(40), headRef: "avalon/workstream-1",
          remoteAccess: "read_only", localEditsAllowed: true, remoteWritesAllowed: false,
          outcome: "selected", backup: null,
        },
        summary: "Checked out avalon/repo with read-only remote access; local edits remain allowed",
      }],
      ["import_resource", { resourceId: "00000000-0000-4000-8000-000000000001" }, {
        output: {
          resourceId: "00000000-0000-4000-8000-000000000001", filePath: ".rally/resources/item",
          outcome: "created", mimeType: "text/plain", sizeBytes: 4, sourceSha256: "a".repeat(64),
        },
        summary: "Imported resource 00000000-0000-4000-8000-000000000001",
      }],
      ["publish_resource", { filePath: "chart.png" }, {
        output: {
          resourceId: "resource-published", title: "Chart", publishKind: "file", resourceType: "generated_file",
          provider: "avalon_generated", mimeType: "image/png", sizeBytes: 42, sourceSha256: "b".repeat(64),
          attachmentKind: "image", contentMode: "view", derivativeStatus: "ready",
          createdAt: "2026-08-13T00:00:00.000Z",
        },
        summary: "Published Chart",
      }],
      ["publish_branch_and_pr", { title: "Ship", body: "Why" }, {
        output: {
          repository: "avalon/repo", baseRef: "main", headRef: "avalon/workstream-1",
          commitSha: "c".repeat(40), publishedSha: "c".repeat(40), outcome: "created",
          pullRequest: { number: 17, url: "https://github.com/avalon/repo/pull/17", title: "Ship", state: "open" },
        },
        summary: "Published pull request 17",
      }],
    ] as const;

    for (const [name, input, expected] of calls) {
      await expect(tools[name](input, context), name).resolves.toEqual(expected);
    }
  });

  it("scrubs every common GitHub token prefix from provider output", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      expect(sanitizeTerminalOutput(`${prefix}_${"a".repeat(40)}`)).toBe("[REDACTED]");
    }
    expect(sanitizeTerminalOutput(`sk-${"a".repeat(40)}`)).toBe("[REDACTED]");
  });

  it("reads exact raw pages and reports the next one without line-number pollution", async () => {
    const { value } = runtime({ "notes.txt": "one\ntwo\nthree\nfour" });
    const tools = createTerminalToolExecutors(value);

    await expect(tools.read_file({ filePath: "notes.txt", offset: 2, limit: 2 }, context)).resolves.toEqual({
      output: {
        filePath: "notes.txt",
        content: "two\nthree",
        startLine: 2,
        endLine: 3,
        totalLines: 4,
        truncated: true,
        nextOffset: 4,
      },
      summary: "Read notes.txt lines 2–3",
    });
  });

  it("self-heals exact edits and performs deliberate complete writes", async () => {
    const { value, files } = runtime({ "src/app.ts": "const old = 1;\nconst old = 1;\n" });
    const tools = createTerminalToolExecutors(value);

    await expect(tools.edit_file({
      filePath: "src/app.ts",
      oldString: "const old = 1;",
      newString: "const current = 1;",
    }, context)).rejects.toMatchObject({
      code: "match_not_unique",
      details: { reason: expect.stringContaining("2") },
    });
    await expect(tools.edit_file({
      filePath: "src/app.ts",
      oldString: "const old = 1;",
      newString: "const current = 1;",
      replaceAll: true,
    }, context)).resolves.toMatchObject({
      output: { replacements: 2, additions: 2, deletions: 2 },
    });
    await expect(tools.write_file({ filePath: "report.md", content: "# Report\n" }, context)).resolves.toMatchObject({
      output: { filePath: "report.md", created: true, bytes: 9, additions: 1, deletions: 0 },
    });
    expect(new TextDecoder().decode(files.get("src/app.ts"))).toBe("const current = 1;\nconst current = 1;\n");
  });

  it("does not download a file before a complete replacement", async () => {
    const { value } = runtime();
    const readFile = vi.spyOn(value, "readFile");

    await createTerminalToolExecutors(value).write_file({
      filePath: "report.md",
      content: "# Report\n",
    }, context);

    expect(readFile).not.toHaveBeenCalled();
  });

  it("reuses the file an exact edit already read when it writes the replacement", async () => {
    const { value } = runtime({ "report.md": "before\n" });
    const writeFile = vi.spyOn(value, "writeFile");

    await createTerminalToolExecutors(value).edit_file({
      filePath: "report.md",
      oldString: "before",
      newString: "after",
    }, context);

    expect(writeFile).toHaveBeenCalledWith(
      context,
      "report.md",
      expect.any(Uint8Array),
      { previousText: "before\n" },
    );
  });

  it.each(["../escape", "/absolute", "dir\\windows", "./../escape"])("rejects a path outside the root: %s", async (filePath) => {
    const { value } = runtime();
    await expect(createTerminalToolExecutors(value).read_file({ filePath }, context)).rejects.toMatchObject({
      code: "path_outside_root",
      // The refused value is echoed so the model can see what was wrong.
      message: expect.stringContaining(filePath),
    });
  });

  it.each([".", "./", "./.", ""])("accepts the workspace root as a working directory: %s", async (cwd) => {
    // `.` normalizes to nothing, and nothing used to read as an escape. The root
    // is inside the root: a recorded run spent four turns being refused for
    // naming it, then guessed directory names until stderr leaked the real one.
    const { value } = runtime();
    const runCommand = vi.spyOn(value, "runCommand");
    await expect(createTerminalToolExecutors(value).run_command({ command: "pwd", cwd }, context)).resolves.toMatchObject({
      output: { state: "completed" },
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]![1]).not.toHaveProperty("cwd");
  });

  it("forwards a real working directory to the runtime", async () => {
    // The inverse of the root case: if every cwd normalized to nothing, every
    // command would silently run in the root and the root tests would stay green.
    const { value } = runtime();
    const runCommand = vi.spyOn(value, "runCommand");
    await createTerminalToolExecutors(value).run_command({ command: "pwd", cwd: "out/app" }, context);
    expect(runCommand.mock.calls[0]![1]).toMatchObject({ cwd: "out/app" });
  });

  it("refuses a working directory outside the root, echoes it, and says to omit cwd", async () => {
    const { value } = runtime();
    await expect(createTerminalToolExecutors(value).run_command({ command: "pwd", cwd: "../escape" }, context)).rejects.toMatchObject({
      code: "path_outside_root",
      message: expect.stringContaining("`cwd` must stay inside the workspace root"),
    });
    await expect(createTerminalToolExecutors(value).run_command({ command: "pwd", cwd: "../escape" }, context)).rejects.toMatchObject({
      message: expect.stringMatching(/`\.\.\/escape`.*Omit `cwd` to run in the workspace root/su),
    });
  });

  it("strips terminal controls from the echoed value", async () => {
    // The echo reaches the transcript like every other Terminal string, so it
    // takes the same sanitizer; a path carrying an ANSI escape is model output.
    const { value } = runtime();
    await expect(createTerminalToolExecutors(value).read_file({ filePath: "../\u001b[31mx" }, context)).rejects.toMatchObject({
      code: "path_outside_root",
      message: expect.stringMatching(/`\.\.\/x`/u),
    });
    await expect(createTerminalToolExecutors(value).read_file({ filePath: "../\u001b[31mx" }, context)).rejects.toMatchObject({
      message: expect.not.stringContaining("\u001b"),
    });
  });

  it("names the output directory, not the workspace root, when a publish path is refused", async () => {
    // publish_resource is the one tool resolved against $AVALON_RESOURCE_DIR; a
    // refusal that pointed at the workspace root would steer the model into the
    // not_found it gets for a file written there.
    const { value } = runtime();
    await expect(createTerminalToolExecutors(value).publish_resource({ filePath: "/workspace/.rally-output/report.md" }, context)).rejects.toMatchObject({
      code: "path_outside_root",
      message: expect.stringContaining("the output directory, `$AVALON_RESOURCE_DIR` (`/workspace/.rally-output`)"),
    });
    await expect(createTerminalToolExecutors(value).publish_resource({ filePath: "/workspace/.rally-output/report.md" }, context)).rejects.toMatchObject({
      message: expect.not.stringContaining("workspace root ("),
    });
  });

  it("names the parameter a tool actually has when it refuses a path", async () => {
    const { value } = runtime();
    await expect(createTerminalToolExecutors(value).import_resource({
      resourceId: "00000000-0000-4000-8000-000000000099",
      destinationPath: "/abs/out",
    }, context)).rejects.toMatchObject({
      code: "path_outside_root",
      message: expect.stringContaining("`destinationPath` must stay inside"),
    });
    await expect(createTerminalToolExecutors(value).apply_patch({
      patch: "--- /dev/null\n+++ /abs/new.txt\n@@ -0,0 +1 @@\n+hello\n",
    }, context)).rejects.toMatchObject({
      code: "path_outside_root",
      message: expect.stringContaining("A path in the patch, `/abs/new.txt`, leaves the workspace root"),
    });
  });

  it("refuses the workspace root as a file path with its own code", async () => {
    const { value } = runtime();
    const refused = createTerminalToolExecutors(value).read_file({ filePath: "." }, context);
    await expect(refused).rejects.toBeInstanceOf(TerminalToolError);
    await expect(refused).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("`filePath` names the workspace root (`/workspace`) itself. Pass a path beneath it"),
    });
  });

  it("refuses the root as a publish path or an import destination with the right root and parameter", async () => {
    // Both accept directories, so the repair is "a path beneath the root", and
    // for publication the root is the output directory, not the workspace.
    const { value } = runtime();
    await expect(createTerminalToolExecutors(value).publish_resource({ filePath: "." }, context)).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("`filePath` names the output directory, `$AVALON_RESOURCE_DIR` (`/workspace/.rally-output`) itself. Pass a path beneath it, such as `report.md` or `site`."),
    });
    await expect(createTerminalToolExecutors(value).import_resource({
      resourceId: "00000000-0000-4000-8000-000000000099",
      destinationPath: "./",
    }, context)).rejects.toMatchObject({
      code: "invalid_path",
      message: expect.stringContaining("`destinationPath` names the workspace root (`/workspace`) itself. Pass a path beneath it"),
    });
  });

  it("returns nonzero exits as final results and lets repository policy govern standard GitHub CLI writes", async () => {
    const { value } = runtime();
    const tools = createTerminalToolExecutors(value);
    await expect(tools.run_command({ command: "false" }, context)).resolves.toMatchObject({
      output: { state: "failed", terminationReason: "exited", exitCode: 1, stderr: "failed\n" },
    });
    await expect(tools.run_command({ command: "git push origin HEAD" }, context)).resolves.toMatchObject({
      output: { state: "completed", exitCode: 0 },
    });
    await expect(tools.run_command({ command: "gh pr create --title ship" }, context)).resolves.toMatchObject({
      output: { state: "completed", exitCode: 0 },
    });
  });
});
