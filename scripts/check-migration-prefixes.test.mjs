import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWN_COLLISIONS,
  describe,
  findCollisions,
  readCheckoutMigrations,
} from "./check-migration-prefixes.mjs";

test("a sequence with one file per prefix passes", () => {
  const result = findCollisions(["0001_initial.sql", "0002_next.sql", "0010_later.sql"], {});
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(result.unnumbered, []);
});

test("two branches taking the same number collide", () => {
  const result = findCollisions(["0052_existing.sql", "0053_slack.sql", "0053_email.sql"], {});
  assert.deepEqual(result.collisions, [
    { prefix: "0053", files: ["0053_email.sql", "0053_slack.sql"] },
  ]);
});

test("a name present on both the base branch and the checkout is one migration, not a collision", () => {
  // The union of two refs repeats every unchanged file; only distinct names count.
  const result = findCollisions(["0052_existing.sql", "0052_existing.sql"], {});
  assert.deepEqual(result.collisions, []);
});

test("collisions are reported for every affected prefix, in order", () => {
  const result = findCollisions(
    ["0060_b.sql", "0060_a.sql", "0059_a.sql", "0059_b.sql", "0058_only.sql"],
    {},
  );
  assert.deepEqual(
    result.collisions.map((collision) => collision.prefix),
    ["0059", "0060"],
  );
});

test("the recorded historical collisions are excused", () => {
  const result = findCollisions(Object.values(KNOWN_COLLISIONS).flat());
  assert.deepEqual(result.collisions, []);
});

test("a third file taking a historically duplicated number still fails", () => {
  const result = findCollisions([...KNOWN_COLLISIONS["0046"], "0046_new_work.sql"]);
  assert.deepEqual(result.collisions, [
    {
      prefix: "0046",
      files: ["0046_new_work.sql", "0046_slack_workspace_tools.sql", "0046_x_workspace_only.sql"],
    },
  ]);
});

test("a record only excuses the exact pair of names it lists", () => {
  const result = findCollisions(["0046_slack_workspace_tools.sql", "0046_something_else.sql"]);
  assert.equal(result.collisions.length, 1);
});

test("a file that is not a numbered migration is reported rather than skipped", () => {
  const result = findCollisions(["0001_initial.sql", "notes.sql", "0002.sql"], {});
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(result.unnumbered, ["0002.sql", "notes.sql"]);
});

test("the failure names the files a person has to renumber", () => {
  const message = describe(findCollisions(["0053_slack.sql", "0053_email.sql"], {}));
  assert.match(message, /Prefix 0053 is claimed by 2 migrations/u);
  assert.match(message, /packages\/db\/migrations\/0053_email\.sql/u);
  assert.match(message, /packages\/db\/migrations\/0053_slack\.sql/u);
});

test("the checked-in migrations satisfy the check", async () => {
  const result = findCollisions(await readCheckoutMigrations());
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(result.unnumbered, []);
});
