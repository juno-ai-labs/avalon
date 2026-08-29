import assert from "node:assert/strict";
import test from "node:test";

import { check, collisions, workspaceIdLiterals } from "./check-durable-object-test-names.mjs";

test("finds the literal a file declares its own workspace with, and its line", () => {
  const found = workspaceIdLiterals(
    [
      "import { asWorkspaceId } from \"@rally/contracts\";",
      "",
      "const WORKSPACE_ID = asWorkspaceId(\"00000000-0000-7000-8000-0000000009a0\");",
    ].join("\n"),
  );

  assert.deepEqual(found, [{ line: 3, id: "00000000-0000-7000-8000-0000000009a0" }]);
});

test("finds an id passed inline as well as one bound to a constant", () => {
  // `durable-object-self-registration.test.ts` names its object inside the
  // `workspaceDOName` call rather than binding it first.
  const found = workspaceIdLiterals(
    "workspaceDOName(\"global\", asWorkspaceId(\"00000000-0000-7000-8000-0000000004b3\")),",
  );

  assert.deepEqual(found.map((declaration) => declaration.id), ["00000000-0000-7000-8000-0000000004b3"]);
});

test("ignores an id assembled at run time, which is nobody else's to collide with", () => {
  // `forced-migration.test.ts` and `migration-reporting.test.ts` build a fresh
  // name per test from a prefix and a seed.
  assert.deepEqual(workspaceIdLiterals("asWorkspaceId(`${WORKSPACE_PREFIX}${seed}`)"), []);
});

test("catches the damage that prompted this check", () => {
  // Verbatim from the suite on 2026-08-28: three files each carrying a comment
  // about addressing their own object, all naming the same one.
  const found = collisions({
    "project-authority.test.ts": ["00000000-0000-7000-8000-0000000009a0"],
    "resource-version-capture.test.ts": ["00000000-0000-7000-8000-0000000009a0"],
    "workspace-socket-message-length.test.ts": ["00000000-0000-7000-8000-0000000009a0"],
  });

  assert.equal(found.length, 1);
  assert.equal(found[0].id, "00000000-0000-7000-8000-0000000009a0");
  assert.deepEqual(found[0].files, [
    "project-authority.test.ts",
    "resource-version-capture.test.ts",
    "workspace-socket-message-length.test.ts",
  ]);
});

test("reports every shared name, not just the first", () => {
  const found = collisions({
    "a.test.ts": ["00000000-0000-7000-8000-0000000008a0", "00000000-0000-7000-8000-0000000009a0"],
    "b.test.ts": ["00000000-0000-7000-8000-0000000008a0"],
    "c.test.ts": ["00000000-0000-7000-8000-0000000009a0"],
  });

  assert.deepEqual(found.map((collision) => collision.id), [
    "00000000-0000-7000-8000-0000000008a0",
    "00000000-0000-7000-8000-0000000009a0",
  ]);
});

test("a file naming the same object twice is naming its own object twice", () => {
  assert.deepEqual(
    collisions({ "a.test.ts": ["00000000-0000-7000-8000-0000000008a0", "00000000-0000-7000-8000-0000000008a0"] }),
    [],
  );
});

test("distinct names collide with nothing", () => {
  assert.deepEqual(
    collisions({
      "a.test.ts": ["00000000-0000-7000-8000-0000000008a0"],
      "b.test.ts": ["00000000-0000-7000-8000-0000000008c0"],
    }),
    [],
  );
});

test("the repository's own workerd suite gives every file its own object", async () => {
  assert.deepEqual(await check(), []);
});
