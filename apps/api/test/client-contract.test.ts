import { CLIENT_CONTRACT_VERSION } from "@rally/contracts/http-headers";
import { describe, expect, it } from "vitest";

import { ApiError } from "../src/lib/api-error";
import {
  clientOpensGuestWorkspaces,
  clientReadsIndividualSpaces,
  clientReadsNewMessages,
  clientReadsResolutionSuggestions,
  requireCurrentClientContract,
  type ClientRequestHeaders,
} from "../src/lib/client-contract";

/**
 * Which builds the cutover still answers.
 *
 * The rule is small and the reason it is shaped this way is not: a browser
 * context is the desktop renderer, whose payload schemas are strict and which
 * therefore drops a sidebar carrying fields it has never heard of. A native
 * client decodes with `Codable` and ignores them, so refusing it would break a
 * working client to protect it from a problem it does not have.
 */
function request(headers: Record<string, string>): ClientRequestHeaders {
  return (name) => headers[name.toLowerCase()];
}

function refusal(headers: Record<string, string>): ApiError | null {
  try {
    requireCurrentClientContract(request(headers));
    return null;
  } catch (error) {
    return error instanceof ApiError ? error : null;
  }
}

describe("the client contract gate", () => {
  it("given a browser build that declares nothing, when it asks, then it is told to update", () => {
    const error = refusal({ origin: "app://rallywithai" });
    expect(error?.status).toBe(426);
    expect(error?.code).toBe("client_update_required");
  });

  it("given a browser build older than the served contract, when it asks, then it is told to update", () => {
    expect(refusal({
      origin: "app://rallywithai",
      "x-rally-client-contract": "0",
    })?.code).toBe("client_update_required");
    // A value that is not a number is not a contract, and reading it as zero
    // would admit whatever sent it.
    expect(refusal({ origin: "app://rallywithai", "x-rally-client-contract": "latest" })?.code)
      .toBe("client_update_required");
    expect(refusal({ origin: "app://rallywithai", "x-rally-client-contract": "1junk" })?.code)
      .toBe("client_update_required");
    expect(refusal({ origin: "app://rallywithai", "x-rally-client-contract": "1.5" })?.code)
      .toBe("client_update_required");
  });

  it("given the current build, when it asks, then nothing is refused", () => {
    expect(refusal({
      origin: "app://rallywithai",
      "x-rally-client-contract": String(CLIENT_CONTRACT_VERSION),
    })).toBeNull();
    // The superseded prefix, admitted because `readRallyHeader` tries every
    // alias of a product header for free. No claim is made about which builds
    // send it.
    expect(refusal({
      origin: "app://rallywithai",
      "x-avalon-client-contract": String(CLIENT_CONTRACT_VERSION),
    })).toBeNull();
  });

  it("keeps the hierarchy readable for contract 1 desktops", () => {
    expect(refusal({ origin: "app://rallywithai", "x-rally-client-contract": "1" })).toBeNull();
  });

  it("given a native client, when it declares no contract, then it is admitted", () => {
    // iOS and the desktop main process send no `Origin` and decode with
    // schemas that ignore unknown keys. The new payload costs them nothing.
    expect(refusal({})).toBeNull();
  });
});

describe("whether a client opens a guest relationship", () => {
  it("is false for a build that declares nothing or an older contract, and true from the guest contract on", () => {
    expect([undefined, "1", "2", "3", "4", "5", "three"].map((declared) =>
      clientOpensGuestWorkspaces(request(declared === undefined ? {} : { "x-rally-client-contract": declared }))))
      .toEqual([false, false, false, false, true, true, false]);
  });
});

describe("who is shown a Space scoped individual", () => {
  it("is a browser build at contract 5 or later, or a native client that declares nothing", () => {
    expect(clientReadsIndividualSpaces(request({ origin: "app://rallywithai", "x-rally-client-contract": "5" }))).toBe(true);
    expect(clientReadsIndividualSpaces(request({}))).toBe(true);
  });

  it("is not a browser build before it, or one that declares nothing or something unreadable", () => {
    expect(clientReadsIndividualSpaces(request({ origin: "app://rallywithai", "x-rally-client-contract": "4" }))).toBe(false);
    expect(clientReadsIndividualSpaces(request({ origin: "app://rallywithai" }))).toBe(false);
    expect(clientReadsIndividualSpaces(request({ origin: "app://rallywithai", "x-rally-client-contract": "5junk" }))).toBe(false);
  });
});


describe("human reply compatibility after resolution suggestions", () => {
  it("withholds reply rows from resolution-only builds while admitting both in the new build", () => {
    const resolutionBuild = request({ origin: "app://rallywithai", "x-rally-client-contract": "10" });
    expect(clientReadsResolutionSuggestions(resolutionBuild)).toBe(true);
    expect(clientReadsNewMessages(resolutionBuild)).toBe(false);
    const replyBuild = request({ origin: "app://rallywithai", "x-rally-client-contract": "11" });
    expect(clientReadsResolutionSuggestions(replyBuild)).toBe(true);
    expect(clientReadsNewMessages(replyBuild)).toBe(true);
  });
});
