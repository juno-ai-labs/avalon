import { describe, expect, it } from "vitest";

import {
  MESSAGE_OPERATIONS,
  type MessageObjectPort,
  type MessageOperation,
} from "../src/durable-objects/workstream-message-protocol";
import type { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
import {
  SCHEDULING_OPERATIONS,
  type SchedulingObjectPort,
  type SchedulingOperation,
} from "../src/durable-objects/workstream-scheduling-protocol";
import type { createObjectPort } from "../src/runtime/object-port";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left] ? true : false
  : false;
type Expect<Value extends true> = Value;

type MessagePortHasExactlyDispatchedKeys = Expect<Equal<
  keyof MessageObjectPort,
  MessageOperation
>>;
type SchedulingPortHasExactlyDispatchedKeys = Expect<Equal<
  keyof SchedulingObjectPort,
  SchedulingOperation
>>;
type DirectFactoryHasExactlyDispatchedKeys = Expect<Equal<
  keyof ReturnType<typeof createObjectPort<WorkstreamMessageStorage, MessageOperation>>,
  MessageOperation
>>;
const messagePortKeysAreExact: MessagePortHasExactlyDispatchedKeys = true;
const schedulingPortKeysAreExact: SchedulingPortHasExactlyDispatchedKeys = true;
const directFactoryKeysAreExact: DirectFactoryHasExactlyDispatchedKeys = true;
void messagePortKeysAreExact;
void schedulingPortKeysAreExact;
void directFactoryKeysAreExact;

describe("object port protocol surfaces", () => {
  it("lists no resident-only message or scheduling commit phases", () => {
    expect(MESSAGE_OPERATIONS).not.toContain("prepareMessage");
    expect(MESSAGE_OPERATIONS).not.toContain("appendPreparedMessage");
    expect(SCHEDULING_OPERATIONS).not.toContain("prepareOpenElicitationMessage");
    expect(SCHEDULING_OPERATIONS).not.toContain("openPreparedElicitation");
    expect(SCHEDULING_OPERATIONS).not.toContain("prepareExternalElicitationAnswerMessage");
    expect(SCHEDULING_OPERATIONS).not.toContain("answerPreparedElicitationExternally");
  });
});
