import { expect, it } from "vitest";
import { ScopeGrantTargetSchema } from "@rally/contracts/scope-grants";
import { invitationFromFragment, invitationTargetPath } from "../src/invitation";

const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const child = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

it("carries a sealed link whole and names no deployment of its own", () => {
  const sealed = "Y2xhaW1lZC1pdg.c2VhbGVkLWludml0YXRpb24tcGF5bG9hZA";
  expect(invitationFromFragment(sealed)).toEqual({ region: null, credential: { link: sealed } });
  expect(invitationFromFragment("")).toBeNull();
});

it("validates an addressed fragment without treating it as authentication", () => {
  const fragment = new URLSearchParams({ region: "global", workspace, workstream: parent, invitation: child, token: "invitation-proof" });
  expect(invitationFromFragment(fragment.toString())).toEqual({ region: "global", credential: {
    workspaceId: workspace, parentId: parent, invitationId: child, token: "invitation-proof",
  } });
  fragment.set("region", "unknown");
  expect(invitationFromFragment(fragment.toString())).toBeNull();
  fragment.set("region", "global"); fragment.delete("token");
  expect(invitationFromFragment(fragment.toString())).toBeNull();
});

it("opens a child-only share directly and represents Main through the canonical root path", () => {
  const base = { kind: "conversation", workspaceId: workspace, parentId: parent };
  expect(invitationTargetPath("https://browser.example.test", "global", ScopeGrantTargetSchema.parse({ ...base, substreamId: child })))
    .toBe(`/app/workspaces/global/${workspace}/workstreams/${parent}/substreams/${child}`);
  expect(invitationTargetPath("https://browser.example.test", "global", ScopeGrantTargetSchema.parse({ ...base, substreamId: "0" })))
    .toBe(`/app/workspaces/global/${workspace}/workstreams/${parent}`);
});
