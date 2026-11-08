/**
 * Which kinds a person's notification record holds and which choice a push
 * reads: Settings offers only kinds a producer records, the Thread-era kinds
 * stay only where a person stored them, and every pushed kind reads one
 * offered kind.
 */
import { describe, expect, it } from "vitest";

import { notificationAllows, storedMemberPreferences } from "../src/durable-objects/member-preferences";

const row = (notify: Record<string, unknown>, push: Record<string, unknown> = {}) => ({
  show_agent_work: 1, push_json: JSON.stringify(push), notify_json: JSON.stringify(notify),
});

describe("member notification kinds", () => {
  it("defaults the offered kinds, access requests among them, and leaves the Thread-era kinds out", () => {
    expect(storedMemberPreferences(row({})).notify).toEqual({
      mentions: ["push", "slack_agent_dm"], newMessages: ["push"], added: ["push", "slack_agent_dm"], runFinished: ["push"],
      artifactUpdates: ["push"], accessRequests: ["push"],
    });
  });

  it("keeps a Thread-era kind a person stored, without consulting it", () => {
    const notify = storedMemberPreferences(row({ newThreads: ["email"], merges: [] })).notify;
    expect(notify).toMatchObject({ newThreads: ["email"], merges: [] });
    expect(notify.newBreakouts).toBeUndefined();
    expect(notificationAllows(notify, "thread_started", "email")).toBe(false);
  });

  it("reads each pushed kind's own choice: a request its Access requests, a grant its Being added", () => {
    const notify = storedMemberPreferences(row({ accessRequests: [], added: ["push"] })).notify;
    expect(notificationAllows(notify, "access_request", "push")).toBe(false);
    expect(notificationAllows(notify, "access_granted", "push")).toBe(true);
    expect(notificationAllows(notify, "new_message", "push")).toBe(true);
    expect(notificationAllows(notify, "artifact_updated", "push")).toBe(true);
  });
});
