import { expect, it } from "vitest";
import { ScopeGrantTargetSchema } from "@rally/contracts/scope-grants";
import { invitationFromFragment, invitationTargetPath } from "../src/invitation";

const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const child = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

it("carries an opaque token whole and names no deployment of its own", () => {
  const token = "inv_Nf3Qpx8Kd1ZrLm7Ty2Vb4Hs6Wg0Jc9Ae5Ru1Ok3Xi2";
  expect(invitationFromFragment(token)).toEqual({ region: null, credential: { link: token } });
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
