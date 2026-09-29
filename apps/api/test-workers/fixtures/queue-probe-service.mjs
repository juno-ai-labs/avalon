import { WorkerEntrypoint } from "cloudflare:workers";

// Every body the probe queue delivered, as the Queue delivered it. An RPC
// return is a structured clone, so what the test reads back is what a real
// consumer would have been handed.
const received = [];

export default class QueueProbeService extends WorkerEntrypoint {
  async queue(batch) {
    for (const message of batch.messages) {
      received.push(message.body);
      message.ack();
    }
  }

  received() {
    return received;
  }
}
