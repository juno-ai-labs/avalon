import { expect, it } from "vitest";
import { ScopeGrantTargetSchema } from "@rally/contracts/scope-grants";
import { invitationFromFragment, invitationTargetPath } from "../src/invitation";

const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const child = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

it("validates invitation routing without treating its fragment as authentication", () => {
  const fragment = new URLSearchParams({ region: "global", workspace, workstream: parent, invitation: child, token: "invitation-proof" });
  expect(invitationFromFragment(fragment)).toEqual({ region: "global", request: {
    workspaceId: workspace, parentId: parent, invitationId: child, token: "invitation-proof",
  } });
  fragment.set("region", "unknown");
  expect(invitationFromFragment(fragment)).toBeNull();
  fragment.set("region", "global"); fragment.delete("token");
  expect(invitationFromFragment(fragment)).toBeNull();
});

it("opens a child-only share directly and represents Main through the canonical root path", () => {
  const base = { kind: "conversation", workspaceId: workspace, parentId: parent };
  expect(invitationTargetPath("https://browser.example.test", "global", ScopeGrantTargetSchema.parse({ ...base, substreamId: child })))
    .toBe(`/app/workspaces/global/${workspace}/workstreams/${parent}/substreams/${child}`);
  expect(invitationTargetPath("https://browser.example.test", "global", ScopeGrantTargetSchema.parse({ ...base, substreamId: "0" })))
    .toBe(`/app/workspaces/global/${workspace}/workstreams/${parent}`);
});
