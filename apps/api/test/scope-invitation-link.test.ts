import { expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import { sealPayload } from "../src/lib/crypto";
import { openScopeInvitationCredential, scopeInvitationLinkUrl, sealScopeInvitationLink } from "../src/services/scope-invitation-link";
import { createTestEnv } from "./helpers/cloudflare-test";

const address = {
  workspaceId: asWorkspaceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  parentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  invitationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  token: "invitation-proof",
};
const bindings = (key = "invitation-link-test-key") =>
  createTestEnv({ AVALON_REGION: "global", OAUTH_STATE_ENCRYPTION_KEY: key, LOG_LEVEL: "error" });

it("reads back only what this deployment sealed, and only as an invitation", async () => {
  const env = bindings();
  const sealed = await sealScopeInvitationLink(env, address);
  expect(await openScopeInvitationCredential(env, { link: sealed })).toEqual(address);
  // Another deployment holds another key; its recipients are not ours.
  expect(await openScopeInvitationCredential(bindings("a-different-deployments-key"), { link: sealed })).toBeNull();
  expect(await openScopeInvitationCredential(env, { link: `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}` })).toBeNull();
  // The same key sealing the same fields for another kind of link is not an
  // invitation credential, so no future link can be replayed as one.
  const elsewhere = await sealPayload(address, env.OAUTH_STATE_ENCRYPTION_KEY, "some-other-link");
  expect(await openScopeInvitationCredential(env, { link: elsewhere })).toBeNull();
});

it("names the field when its own payload no longer matches the shape it seals", async () => {
  const env = bindings();
  const drifted = await sealPayload({ ...address, token: 7 }, env.OAUTH_STATE_ENCRYPTION_KEY, "scope-invitation-link");
  // Decryption proves we minted it, so this is a deploy that stopped honouring
  // every link already in an inbox — not one more unavailable invitation.
  await expect(openScopeInvitationCredential(env, { link: drifted }))
    .rejects.toThrow("scope_invitation_link_invalid:token:invalid_type");
});

it("puts the credential in the fragment, where a link's own request cannot carry it", async () => {
  const link = scopeInvitationLinkUrl(new URL("https://app.example.test"), "sealed-credential");
  expect(link.toString()).toBe("https://app.example.test/invite#sealed-credential");
  expect(link.search).toBe("");
});

it("passes an addressed credential through for links sent before sealing", async () => {
  expect(await openScopeInvitationCredential(bindings(), address)).toEqual(address);
});
