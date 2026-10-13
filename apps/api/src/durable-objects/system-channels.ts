import type { SpaceColorKey, SpaceIconKey } from "@rally/contracts";

import type { ChannelMessageDraft } from "./workspace-space-storage";

/**
 * The Channels Rally makes on its own, as data: what each is called, how it
 * looks, and what it opens with. Nothing here is a mechanism. Each is the same
 * Space reservation and the same Channel messages any Channel is made of, so
 * changing what a Channel opens with is a change to this file and nothing
 * else. See docs/spaces.md#channel-messages.
 */
export interface ChannelStart {
  name: string;
  iconKey: SpaceIconKey;
  colorKey: SpaceColorKey;
  messages: readonly ChannelMessageDraft[];
}

/** The Organization's General: every member's, and every thread's fallback home. */
export const GENERAL_CHANNEL: ChannelStart = {
  name: "General",
  iconKey: "building-2",
  colorKey: "blue",
  messages: [{
    author: { kind: "rally" },
    body: "Welcome to Rally, we’ve created a channel for you to get started with. Channels are places to organize "
      + "similar work. When you type a task or a project below we start a Thread to actually work with the Rally AI agent.",
  }],
};

/**
 * Each member's Personal Channel. Its owner may rename and recolour it like
 * any Space they edit; only its audience is fixed.
 */
export const PERSONAL_CHANNEL: ChannelStart = {
  name: "Your Personal Channel",
  iconKey: "user",
  colorKey: "violet",
  messages: [{
    author: { kind: "rally" },
    body: "Welcome to Rally! This is your personal Channel to try Rally out and do private work. Type a task or "
      + "project below and we’ll start a thread where you’ll work with the Rally AI agent.",
  }],
};
