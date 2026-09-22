import { describe, expect, it } from "vitest";

import { ARTIFACT_HOST_SCHEMA_MIGRATIONS } from "../src/durable-objects/artifact-host-do";
import { durableObjectMigrationHash } from "../src/durable-objects/sqlite-migrations";

describe("ArtifactHostDO migrations", () => {
  it("keeps every published migration byte-for-byte compatible", () => {
    expect(ARTIFACT_HOST_SCHEMA_MIGRATIONS.map(durableObjectMigrationHash)).toEqual([
      "fnv1a64:cab8ce812eccd531",
      "fnv1a64:0a80fa5e6713180a",
    ]);
  });
});
