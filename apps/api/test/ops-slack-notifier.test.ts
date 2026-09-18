import "../../../tests/isolated-region";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { notifyOps, renderOpsNotification } from "../src/observability/ops-slack-notifier";
import { createTestEnv } from "./helpers/cloudflare-test";

// Not credential-shaped: Gitleaks' Slack token rules want digit groups.
const BOT_TOKEN = "xoxb-ops-test";
const CHANNEL_ID = "C0OPSTEST";
const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

const NOTICE = {
  event: "workspace_scheduled_alarm_stalled",
  summary: "An alarm target keeps coming back due at the same instant.",
  fields: { workspace_id: "00000000-0000-7000-8000-0000000000a1", attempt: 3 },
};

function notifierEnv(
  secrets: { token?: string; channel?: string } = { token: BOT_TOKEN, channel: CHANNEL_ID },
  appEnv: "production" | "staging" | "development" | "test" = "production",
) {
  return createTestEnv({
    APP_ENV: appEnv,
    AVALON_REGION: "global",
    LOG_LEVEL: "info",
    ...(secrets.token === undefined ? {} : { OPS_SLACK_BOT_TOKEN: secrets.token }),
    ...(secrets.channel === undefined ? {} : { OPS_SLACK_CHANNEL_ID: secrets.channel }),
  });
}

function slackAnswers(payload: unknown, status = 200): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status }));
}

function neverResolves(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
  }));
}

/** Everything the logger wrote, as one string, so a secret can be searched for. */
function loggedText(...spies: { mock: { calls: unknown[][] } }[]): string {
  return JSON.stringify(spies.map((spy) => spy.mock.calls));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ops Slack notifier", () => {
  it("skips without a request when either half of the destination is missing", async () => {
    const request = vi.fn<typeof fetch>();

    expect(await notifyOps(notifierEnv({}), NOTICE, request)).toBe("skipped");
    expect(await notifyOps(notifierEnv({ token: BOT_TOKEN }), NOTICE, request)).toBe("skipped");
    expect(await notifyOps(notifierEnv({ channel: CHANNEL_ID }), NOTICE, request)).toBe("skipped");
    expect(await notifyOps(notifierEnv({ token: "  ", channel: CHANNEL_ID }), NOTICE, request)).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
  });

  it("skips outside a deployed region even when configured", async () => {
    // The sandbox has full network access and a developer's `.dev.vars` can
    // carry the secrets; neither may page the operator channel.
    const request = slackAnswers({ ok: true });
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await notifyOps(notifierEnv(undefined, "development"), NOTICE, request)).toBe("skipped");
    expect(await notifyOps(notifierEnv(undefined, "test"), NOTICE, request)).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
    expect(await notifyOps(notifierEnv(undefined, "staging"), NOTICE, request)).toBe("sent");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("posts to the channel with the token in a header and the secret in no log row", async () => {
    const request = slackAnswers({ ok: true });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    expect(await notifyOps(notifierEnv(), NOTICE, request)).toBe("sent");

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    // The credential travels in a header: the platform's automatic tracing
    // records an outbound request's URL, never its headers.
    expect(String(url)).toBe(POST_MESSAGE_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${BOT_TOKEN}`);
    const body = JSON.parse(String(init?.body)) as { channel: string; text: string };
    expect(body.channel).toBe(CHANNEL_ID);
    expect(body.text.split("\n")).toEqual([
      ":rotating_light: *[global]* `workspace_scheduled_alarm_stalled`",
      "An alarm target keeps coming back due at the same instant.",
      "• workspace_id: 00000000-0000-7000-8000-0000000000a1",
      "• attempt: 3",
    ]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "ops_notification_sent",
      notice_event: NOTICE.event,
    }));
    expect(loggedText(info)).not.toContain(BOT_TOKEN);
  });

  it("reports Slack's own refusal by its code, without the token", async () => {
    const request = slackAnswers({ ok: false, error: "channel_not_found" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await notifyOps(notifierEnv(), NOTICE, request)).toBe("failed");

    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "ops_notification_failed",
      code: "channel_not_found",
      status: 200,
      notice_event: NOTICE.event,
    }));
    expect(loggedText(warning)).not.toContain(BOT_TOKEN);
  });

  it.each([
    [{ ok: false, error: "<script>not a code</script>" }, "slack_error"],
    [{ ok: "yes" }, "slack_error"],
  ])("maps a refusal that is not a code to a fixed one (%j)", async (payload, code) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await notifyOps(notifierEnv(), NOTICE, slackAnswers(payload))).toBe("failed");

    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "ops_notification_failed", code }));
    expect(loggedText(warning)).not.toContain("script");
  });

  it("reports a rejected post and an unparsable answer as failures, not throws", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await notifyOps(notifierEnv(), NOTICE, slackAnswers({ ok: false }, 429))).toBe("failed");
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "http_error", status: 429 }));

    const malformed = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 200 }));
    expect(await notifyOps(notifierEnv(), NOTICE, malformed)).toBe("failed");
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "response_malformed" }));

    const thrown = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    await expect(notifyOps(notifierEnv(), NOTICE, thrown)).resolves.toBe("failed");
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "request_failed" }));
    expect(loggedText(warning)).not.toContain(BOT_TOKEN);
  });

  it("reports an answer it cannot read or hold as a failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unreadable = vi.fn<typeof fetch>(async () => {
      const response = new Response("{}", { status: 200 });
      vi.spyOn(response, "text").mockRejectedValue(new TypeError("body stream broke"));
      return response;
    });
    expect(await notifyOps(notifierEnv(), NOTICE, unreadable)).toBe("failed");
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "response_unreadable", status: 200 }));

    const enormous = vi.fn<typeof fetch>(async () => new Response(`{"ok":true,"pad":"${"x".repeat(40_000)}"}`, { status: 200 }));
    expect(await notifyOps(notifierEnv(), NOTICE, enormous)).toBe("failed");
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ code: "response_too_large", status: 200 }));
  });

  it("gives up on a post that outlives the deadline, and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const pending = notifyOps(notifierEnv(), NOTICE, neverResolves());
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toBe("failed");
      expect(warning).toHaveBeenCalledWith(expect.objectContaining({
        event: "ops_notification_failed",
        code: "timeout",
      }));
      // A cleared deadline leaves nothing armed to hold an invocation open.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds every field and escapes Slack markup, so no value can ping or link", () => {
    const text = renderOpsNotification("enterprise", {
      event: "slack_ingress_job_exhausted",
      summary: "Given up <!channel>.",
      fields: { code: "x".repeat(1_000), detail: "<@U123> & <https://example.com|here>" },
    });

    expect(text).toContain(`• code: ${"x".repeat(200)}…`);
    expect(text).not.toContain("x".repeat(201));
    expect(text).toContain("Given up &lt;!channel&gt;.");
    expect(text).toContain("• detail: &lt;@U123&gt; &amp; &lt;https://example.com|here&gt;");
    expect(text).not.toMatch(/<[!@]/u);
    expect(text.startsWith(":rotating_light: *[enterprise]* `slack_ingress_job_exhausted`")).toBe(true);
  });

  it("keeps every value on its own line, whatever whitespace it carried", () => {
    const text = renderOpsNotification("global", {
      event: "workspace_scheduled_alarm_failed",
      summary: "Failed.",
      fields: { code: "first line\nsecond\tline   third", alarm_key: "k" },
    });

    expect(text.split("\n")).toEqual([
      ":rotating_light: *[global]* `workspace_scheduled_alarm_failed`",
      "Failed.",
      "• code: first line second line third",
      "• alarm_key: k",
    ]);
  });
});
