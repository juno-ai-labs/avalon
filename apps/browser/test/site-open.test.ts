import { expect, it } from "vitest";

import { siteOpenFailure, siteOpenTarget } from "../src/site-open-decisions";
import { BrowserApiError } from "../src/transport";

it("keeps the code in the fragment and the return path in the query", () => {
  const target = new URL(siteOpenTarget("https://calm-river-g.rallyusercontent.test/__rally/open#code123", "/journal?day=3"));
  expect(target.hash).toBe("#code123");
  expect(target.searchParams.get("return")).toBe("/journal?day=3");
  expect(target.pathname).toBe("/__rally/open");
});

it("tells a missing site from one the account cannot open", () => {
  expect(siteOpenFailure(new BrowserApiError(404, "x", "site_not_found"), "global"))
    .toMatchObject({ title: "Site not found", retry: false });
  expect(siteOpenFailure(new BrowserApiError(403, "x", "site_access_denied"), "global"))
    .toMatchObject({ title: "No access to this site", retry: false });
});

it("explains the first visit to another region, and nowhere else", () => {
  expect(siteOpenFailure(new BrowserApiError(401, "x"), "eu")).toMatchObject({ title: "Open your organization first" });
  expect(siteOpenFailure(new BrowserApiError(401, "Your session ended."), "global"))
    .toEqual({ title: "Can't open this site", message: "Your session ended.", retry: true });
});

it("offers to try again when Rally could not be reached", () => {
  expect(siteOpenFailure(new TypeError("Failed to fetch"), "global"))
    .toEqual({ title: "Can't reach Rally", message: "Check your connection and try again.", retry: true });
});
