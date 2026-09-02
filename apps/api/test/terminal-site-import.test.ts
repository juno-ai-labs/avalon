import { describe, expect, it } from "vitest";

import { importTreeFailure, materializeTreeCommand } from "../src/services/terminal/site-import";

const DESTINATION = "/workspace/.rally-output/offsite-rsvp";
const STAGING = "/workspace/.rally/tmp/tree-1";

function command(overwrite: boolean): string {
  return materializeTreeCommand({ destination: DESTINATION, staging: STAGING, overwrite });
}

describe("writing a materialized site tree", () => {
  it("refuses a non-empty destination when no overwrite was asked for", () => {
    expect(command(false)).toContain("exit 44");
    expect(command(false)).toContain('ls -A "$destination"');
  });

  it("replaces the whole tree rather than merging into it", () => {
    // Merging is the dangerous default this rules out: it would leave behind
    // files a later version deleted, and the next publish would ship them back.
    expect(command(true)).toContain('rm -rf -- "$destination"');
    expect(command(true)).not.toContain("exit 44");
  });

  it("stages beside the destination and moves into place", () => {
    // A failure partway leaves the previous tree intact rather than a
    // half-replaced one.
    const staged = command(true);
    expect(staged.indexOf('mv -- "$staging" "$destination"'))
      .toBeGreaterThan(staged.indexOf('rm -rf -- "$destination"'));
  });

  it("refuses a destination that is not a directory, in both modes", () => {
    for (const overwrite of [true, false]) {
      expect(command(overwrite), String(overwrite)).toContain("exit 45");
    }
  });

  it("quotes paths so a name with a quote cannot break out of the command", () => {
    const injected = materializeTreeCommand({
      destination: "/workspace/a'; rm -rf /; echo '",
      staging: STAGING,
      overwrite: true,
    });
    expect(injected).toContain(`'"'"'`);
    expect(injected).not.toMatch(/^destination='\/workspace\/a'; rm/mu);
  });
});

describe("what an import failure tells the model to do", () => {
  it("says nothing succeeded quietly", () => {
    expect(importTreeFailure(0)).toBeNull();
  });

  it("names the two repairs for an occupied destination", () => {
    const failure = importTreeFailure(44);
    expect(failure?.code).toBe("destination_exists");
    expect(failure?.message).toContain("another destinationPath");
    // The word that stops a model expecting a merge.
    expect(failure?.message).toContain("replaces the whole tree");
  });

  it("distinguishes a destination it cannot replace from one that is occupied", () => {
    expect(importTreeFailure(45)?.code).toBe("destination_not_regular");
    expect(importTreeFailure(46)?.code).toBe("resource_import_failed");
  });

  it("carries a repair in every failure it produces", () => {
    for (const code of [44, 45, 46, 99]) {
      expect(importTreeFailure(code)?.details?.reason, String(code)).toBeTruthy();
    }
  });
});
