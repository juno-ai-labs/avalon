import { describe, expect, it, vi } from "vitest";
import { projectFields, providerJson, readResponseBytes, truncateTextWithMarker } from "./provider-utils";

describe("bounded provider responses", () => {
  it("stops a streaming response as soon as it exceeds the byte budget", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
        controller.enqueue(new TextEncoder().encode("789012"));
      },
      cancel: cancelled,
    }));

    await expect(readResponseBytes(response, 10)).rejects.toMatchObject({
      code: "payload_too_large",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("parses JSON only after reading it within the byte budget", async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }));

    await expect(providerJson(fetcher, "https://provider.example/data", {}, 64))
      .resolves.toEqual({ ok: true });
  });

  it("preserves a provider Retry-After delay on HTTP 429", async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"ratelimited"}', {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7" },
    }));

    await expect(providerJson(fetcher, "https://provider.example/data"))
      .rejects.toMatchObject({ details: { status: 429, retryAfterMs: 7_000 } });
  });
});

describe("declared rows", () => {
  it("merges paths that share a prefix instead of overwriting them", () => {
    // Every row in the tree names several fields of one nested object —
    // `head.ref` beside `head.sha`, `labels[].name` beside another element's.
    // A projection that rebuilt the prefix per path would keep only the last.
    expect(projectFields({
      head: { ref: "feature", sha: "9fceb02", repo: { id: 41 } },
      labels: [{ name: "bug", color: "d73a4a" }, { name: "p0", color: "000000" }],
    }, ["head.ref", "head.sha", "labels[].name", "labels[].color"])).toEqual({
      head: { ref: "feature", sha: "9fceb02" },
      labels: [{ name: "bug", color: "d73a4a" }, { name: "p0", color: "000000" }],
    });
  });

  it("keeps a declared null and omits a field the provider never sent", () => {
    // The two halves of one rule. `merged_at: null` is the answer to "was it
    // merged" and has to survive; a key the provider omitted must stay omitted,
    // because a synthesized `null` claims the provider answered a question
    // nobody asked it.
    expect(projectFields(
      { merged_at: null, milestone: null, state: "open" },
      // `constructor` is declared here for the third case hiding inside the
      // second: absence is decided with `Object.hasOwn`, so a field name that
      // happens to exist on `Object.prototype` is still absent.
      ["state", "merged_at", "milestone.title", "closed_at", "user.login", "constructor"],
    )).toEqual({ state: "open", merged_at: null, milestone: null });
  });

  it("attaches a container only when something declared was found beneath it", () => {
    // An empty object standing where a field was asked for reads as a value that
    // came back blank, which is a different answer from one that was never sent.
    // The projection used to return `{ user: {} }` here and `{ labels: [{}] }`
    // below, contradicting its own stated contract.
    expect(projectFields({ user: { id: 1 } }, ["user.login"])).toEqual({});
    expect(projectFields({ labels: [{ color: "d73a4a" }] }, ["labels[].name"])).toEqual({});
    expect(projectFields({ user: { id: 1, login: "octocat" } }, ["user.login"]))
      .toEqual({ user: { login: "octocat" } });
  });

  it("keeps an array's positions, and keeps a present empty one", () => {
    // The count and the order are part of the answer: dropping the element that
    // carries none of the declared fields would report two labels as one. An
    // array the provider sent empty is a complete answer rather than a missing
    // one, so it survives where an absent array does not.
    expect(projectFields(
      { labels: [{ name: "bug" }, { color: "000000" }], assignees: [], reviewers: [] },
      ["labels[].name", "assignees[].login"],
    )).toEqual({ labels: [{ name: "bug" }, {}], assignees: [] });
  });

  it("lets the narrower declaration win in either order", () => {
    // Declaring an ancestor and a descendant used to keep the whole provider
    // object, in *both* orders — the ancestor copied it by reference and the
    // descendant then wrote into that same copy. For a primitive whose contract
    // is that nothing undeclared survives, that is the failure that matters:
    // `head.repo` is exactly the embedded record this exists to remove.
    const source = { head: { ref: "feature", repo: { id: 41, archive_url: "big" } } };

    expect(projectFields(source, ["head", "head.ref"])).toEqual({ head: { ref: "feature" } });
    expect(projectFields(source, ["head.ref", "head"])).toEqual({ head: { ref: "feature" } });
  });

  it("ignores a declared path whose parent is not the shape it expects", () => {
    // A provider is free to change a shape under us. Dropping the path is the
    // only honest reading: there is no field there to report.
    expect(projectFields(
      { user: "octocat", labels: "none", head: { ref: "feature" } },
      ["user.login", "labels[].name", "head.ref"],
    )).toEqual({ head: { ref: "feature" } });
  });
});

describe("visible truncation", () => {
  it("spends the marker from the budget rather than adding it on top", () => {
    const marked = truncateTextWithMarker("x".repeat(5_000), 1_000);

    expect(marked).toHaveLength(1_000);
    expect(marked).toMatch(/^x+\n\[truncated: 5000 characters exceeds the 1000-character limit\]$/u);
  });

  it("returns a value inside the budget untouched", () => {
    expect(truncateTextWithMarker("x".repeat(1_000), 1_000)).toBe("x".repeat(1_000));
  });
});
