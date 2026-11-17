import type { HarnessEvent } from "@rally/agent-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSequencedStreamDeltaBatcher } from "../src/services/integrations";

type StreamDelta = Extract<HarnessEvent, { type: "stream_delta" }>;

function delta(text: string, streamSeq: number, overrides: Partial<StreamDelta> = {}): StreamDelta {
  return { type: "stream_delta", delta: text, turnId: "turn-1", epoch: 0, streamSeq, reset: false, ...overrides };
}

describe("createSequencedStreamDeltaBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends held text within the batch window when no later delta arrives", async () => {
    const published: string[] = [];
    vi.setSystemTime(0);
    const batcher = createSequencedStreamDeltaBatcher(async (event) => {
      published.push(event.delta);
    });

    vi.setSystemTime(1_000);
    await batcher.push(delta("I", 1));
    vi.setSystemTime(1_020);
    await batcher.push(delta("'ll check the repository.", 2));
    expect(published).toEqual(["I"]);

    // The model is now streaming a tool call's input: no text, no flush.
    await vi.advanceTimersByTimeAsync(100);
    expect(published).toEqual(["I", "'ll check the repository."]);
  });

  it("sends one frame per window across a timer flush", async () => {
    const published: string[] = [];
    vi.setSystemTime(0);
    const batcher = createSequencedStreamDeltaBatcher(async (event) => {
      published.push(event.delta);
    });

    vi.setSystemTime(1_000);
    await batcher.push(delta("a", 1));
    await batcher.push(delta("b", 2));
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(1_150);
    await batcher.push(delta("c", 3));
    await vi.advanceTimersByTimeAsync(100);
    await batcher.flush();

    expect(published).toEqual(["a", "b", "c"]);
  });

  it("holds a caller's flush until a timer publish in flight has landed", async () => {
    const landed: string[] = [];
    let release: () => void = () => undefined;
    vi.setSystemTime(0);
    const batcher = createSequencedStreamDeltaBatcher(async (event) => {
      if (event.delta === "b") await new Promise<void>((resolve) => { release = resolve; });
      landed.push(event.delta);
    });

    vi.setSystemTime(1_000);
    await batcher.push(delta("a", 1));
    vi.setSystemTime(1_020);
    await batcher.push(delta("b", 2));
    // The timer starts publishing "b", which has not landed yet.
    await vi.advanceTimersByTimeAsync(100);
    // As emit() does before a tool event: flush, then publish the event.
    const toolEvent = batcher.flush().then(() => { landed.push("tool_started"); });
    await Promise.resolve();
    release();
    await toolEvent;

    expect(landed).toEqual(["a", "b", "tool_started"]);
  });

  it("sends nothing more after an explicit flush empties the batch", async () => {
    const published: string[] = [];
    vi.setSystemTime(0);
    const batcher = createSequencedStreamDeltaBatcher(async (event) => {
      published.push(event.delta);
    });

    vi.setSystemTime(1_000);
    await batcher.push(delta("a", 1));
    await batcher.push(delta("b", 2));
    await batcher.flush();
    await vi.advanceTimersByTimeAsync(500);

    expect(published).toEqual(["a", "b"]);
  });
});
