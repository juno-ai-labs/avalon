import { expect, it } from "vitest";

import { SOURCE_DECISION_LINK_MISSING, sourceDecisionAsk, sourceDecisionFailure, sourceDecisionWords } from "../src/source-decision-words";
import { BrowserApiError } from "../src/transport";

const FRAGMENT = "#region=global&workspace=00000000-0000-7000-8000-0000000d2c01&sidekick=00000000-0000-7000-8000-0000000d2c02"
  + "&request=00000000-0000-7000-8000-0000000d2c03&person=00000000-0000-7000-8000-0000000d2c04&decision=decline&token=signed-by-rally";

const asked = { sidekickName: "Deals", requestedByName: "Avery", connectorName: "Gmail", eventLabels: ["Email received"],
  condition: "it is about a pre-seed round" };

it("reads the deployment and the signed decision out of an emailed link's fragment", () => {
  expect(sourceDecisionAsk(FRAGMENT)).toEqual({ region: "global", link: {
    workspaceId: "00000000-0000-7000-8000-0000000d2c01", sidekickId: "00000000-0000-7000-8000-0000000d2c02",
    requestId: "00000000-0000-7000-8000-0000000d2c03", userId: "00000000-0000-7000-8000-0000000d2c04", decision: "decline",
    token: "signed-by-rally",
  } });
});

it("reads no decision from an address without one, a region it does not know, or a link cut short", () => {
  expect(sourceDecisionAsk("")).toBeNull();
  expect(sourceDecisionAsk(FRAGMENT.replace("region=global", "region=nowhere"))).toBeNull();
  expect(sourceDecisionAsk(FRAGMENT.replace("&token=signed-by-rally", ""))).toBeNull();
  expect(sourceDecisionAsk(FRAGMENT.replace("decision=decline", "decision=maybe"))).toBeNull();
  expect(SOURCE_DECISION_LINK_MISSING.title).toBe("Open the link from your email");
});

it("says what an answer that was recorded did, with what was asked under an approval", () => {
  expect(sourceDecisionWords({ ...asked, state: "approved", applied: true })).toEqual({
    title: "Approved", message: "Events from your Gmail can now start Deals.",
    detail: "Events: Email received. Only when: it is about a pre-seed round",
  });
  expect(sourceDecisionWords({ ...asked, state: "declined", applied: true })).toEqual({
    title: "Declined", message: "Events from your Gmail will not start Deals.", detail: "",
  });
});

it("says how the request stands when the link changed nothing", () => {
  expect(sourceDecisionWords({ ...asked, state: "approved", applied: false })).toMatchObject({
    title: "Already approved", message: "You already approved this request, so this link changed nothing. Events from your Gmail can start Deals." });
  expect(sourceDecisionWords({ ...asked, state: "declined", applied: false })).toMatchObject({
    title: "Already declined", message: "You already declined this request, so this link changed nothing. Avery can ask you again." });
  expect(sourceDecisionWords({ ...asked, state: "cancelled", applied: false })).toMatchObject({
    title: "This request was replaced",
    message: "Avery asked again after this email was sent, so this link changed nothing. Use the newest email from Rally, or answer in Rally under Activity." });
});

it("shows Rally's own sentence for a refusal, and a connection failure apart from it", () => {
  expect(sourceDecisionFailure(new BrowserApiError(409, "Connect that account first. There is nothing to allow until it is connected.", "sidekick_source_connection_missing")))
    .toEqual({ title: "Not answered", message: "Connect that account first. There is nothing to allow until it is connected." });
  expect(sourceDecisionFailure(new BrowserApiError(401, "This link is not valid. Open the request in Rally to answer it.", "sidekick_source_link_invalid")))
    .toEqual({ title: "This link is not valid", message: "This link is not valid. Open the request in Rally to answer it." });
  expect(sourceDecisionFailure(new TypeError("Failed to fetch")))
    .toEqual({ title: "Can't reach Rally", message: "Check your connection, then open the link from your email again." });
});
