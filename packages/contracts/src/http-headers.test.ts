import { describe, expect, it } from "vitest";
import {
  LEGACY_RALLY_HEADER_PREFIXES,
  RALLY_HEADERS,
  RALLY_HEADER_PREFIX,
  rallyHeaderAliases,
  readRallyHeader,
} from "./http-headers";

describe("rally http headers", () => {
  it("mints every header on the current prefix", () => {
    for (const name of Object.values(RALLY_HEADERS)) {
      expect(name.startsWith(RALLY_HEADER_PREFIX)).toBe(true);
    }
  });

  it("pairs each canonical name with every superseded spelling", () => {
    expect(rallyHeaderAliases(RALLY_HEADERS.OPERATION_ID)).toEqual([
      "x-rally-operation-id",
      "x-avalon-operation-id",
    ]);
  });

  it("leaves a name outside the product prefix alone", () => {
    expect(rallyHeaderAliases("idempotency-key")).toEqual(["idempotency-key"]);
  });

  it("reads the canonical name from a Headers source", () => {
    const headers = new Headers({ [RALLY_HEADERS.REGION]: "eu" });
    expect(readRallyHeader(headers, RALLY_HEADERS.REGION)).toBe("eu");
  });

  it("reads the superseded name a shipped client still sends", () => {
    const headers = new Headers({ "x-avalon-region": "global" });
    expect(readRallyHeader(headers, RALLY_HEADERS.REGION)).toBe("global");
  });

  it("prefers the canonical name when a request carries both", () => {
    const headers = new Headers({
      "x-rally-operation-id": "current",
      "x-avalon-operation-id": "superseded",
    });
    expect(readRallyHeader(headers, RALLY_HEADERS.OPERATION_ID)).toBe("current");
  });

  it("falls through an empty canonical value to the superseded one", () => {
    const headers = new Headers({
      "x-rally-draft-id": "",
      "x-avalon-draft-id": "draft-1",
    });
    expect(readRallyHeader(headers, RALLY_HEADERS.DRAFT_ID)).toBe("draft-1");
  });

  it("reads through a header accessor function", () => {
    const values: Record<string, string> = { "x-avalon-user-id": "user-1" };
    expect(readRallyHeader((name) => values[name], RALLY_HEADERS.USER_ID)).toBe("user-1");
  });

  it("reports an absent header as undefined rather than null", () => {
    expect(readRallyHeader(new Headers(), RALLY_HEADERS.SESSION_ID)).toBeUndefined();
  });

  it("keeps the superseded prefix list non-empty while shipped builds send it", () => {
    expect(LEGACY_RALLY_HEADER_PREFIXES).toContain("x-avalon-");
  });
});
