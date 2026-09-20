import "../../../tests/isolated-region";
import {
  asArtifactId,
  asAutomationId,
  asSpaceId,
  asSubstreamId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
// A separate subpath, like the reporter that consumes it.
import { isOpaqueDurableObjectName } from "@rally/contracts/durable-object-migrations";
import { describe, expect, it } from "vitest";

import {
  artifactHostDOName,
  automationDOName,
  conversationObjectName,
  spaceDOName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";

const WORKSPACE = asWorkspaceId("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
const WORKSTREAM = asWorkstreamId("3f2504e0-4f89-41d3-9a0c-0305e82c3302");
const SUBSTREAM = asSubstreamId("3f2504e0-4f89-41d3-9a0c-0305e82c3303");
const AUTOMATION = asAutomationId("3f2504e0-4f89-41d3-9a0c-0305e82c3305");
const ARTIFACT = asArtifactId("3f2504e0-4f89-41d3-9a0c-0305e82c3306");
const SPACE = asSpaceId("3f2504e0-4f89-41d3-9a0c-0305e82c3307");

/**
 * Every name this repository mints, so the allowlist below is checked against
 * the producers rather than against memory. A name added here without its role
 * word added to `FIXED_SEGMENTS` fails this test instead of silently arriving
 * at the migration tracker with `objectName: null`, which is how `automation`
 * went unnoticed for the life of that name.
 */
const EVERY_MINTED_NAME = (["global", "enterprise"] as const).flatMap((region) => [
  workspaceDOName(region, WORKSPACE),
  workstreamDOName(region, WORKSPACE, WORKSTREAM),
  conversationObjectName(region, WORKSPACE, WORKSTREAM),
  conversationObjectName(region, WORKSPACE, WORKSTREAM, SUBSTREAM),
  automationDOName(region, WORKSPACE, AUTOMATION),
  artifactHostDOName(region, ARTIFACT),
  spaceDOName(region, WORKSPACE, SPACE),
  conversationObjectName(region, WORKSPACE, SPACE),
]);

describe("durable object names", () => {
  it("mints only names the migration reporter can carry", () => {
    for (const name of EVERY_MINTED_NAME) {
      expect(isOpaqueDurableObjectName(name), name).toBe(true);
    }
  });

  it("names an artifact object from its region and id, with no workspace segment", () => {
    // The serving Worker holds no D1 and sees only a Host header, so every
    // segment of this name has to be derivable from the hostname alone.
    expect(artifactHostDOName("global", ARTIFACT)).toBe(`global:artifact:${ARTIFACT}`);
    expect(artifactHostDOName("enterprise", ARTIFACT)).toBe(`enterprise:artifact:${ARTIFACT}`);
    expect(artifactHostDOName("global", ARTIFACT)).not.toContain(WORKSPACE);
  });

  it("separates the two regions, so one name never addresses both objects", () => {
    expect(artifactHostDOName("global", ARTIFACT)).not.toBe(artifactHostDOName("enterprise", ARTIFACT));
  });

  it("names a Space object so an operator can tell it from a work stream", () => {
    // Both are `<region>:<workspace>:<uuid>` otherwise, and both ids come out
    // of the same generator. Without the role word a migration report naming a
    // stuck object would not say which class it belonged to.
    expect(spaceDOName("global", WORKSPACE, SPACE)).toBe(`global:${WORKSPACE}:space:${SPACE}`);
    expect(spaceDOName("global", WORKSPACE, SPACE))
      .not.toBe(workstreamDOName("global", WORKSPACE, WORKSTREAM));
    // A Space's hidden main conversation is named by the Space id under the
    // conversation-object scheme, exactly as a Channel's is by its own id.
    expect(conversationObjectName("global", WORKSPACE, SPACE)).toBe(`global:${WORKSPACE}:${SPACE}`);
  });

  it("keeps an artifact name distinct from every other object's", () => {
    const artifact = artifactHostDOName("global", ARTIFACT);
    const others = EVERY_MINTED_NAME.filter((name) => name !== artifact
      && name !== artifactHostDOName("enterprise", ARTIFACT));
    expect(others).not.toContain(artifact);
  });
});
