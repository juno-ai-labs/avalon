const baseUrl = process.env.AVALON_SMOKE_BASE_URL ?? "http://127.0.0.1:8787";
// A hosted Worker serves its Flagship flag, not the checked-in default, so name
// the model it should serve when that flag differs.
const expectedModel = process.env.AVALON_SMOKE_EXPECTED_MODEL?.trim() || "openai/gpt-6.1-sol";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

let accessToken = process.env.AVALON_SMOKE_ACCESS_TOKEN?.trim();
if (!accessToken) {
  const session = await request("/auth/dev/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceName: "Rally model smoke" }),
  });
  assert(session.response.status === 201 && session.body?.accessToken, "Development sign-in failed");
  accessToken = session.body.accessToken;
}
const headers = {
  authorization: `Bearer ${accessToken}`,
  "content-type": "application/json",
};

// A Canvas under an id this check minted, and one message in its Chat.
const canvasId = crypto.randomUUID();
const created = await request("/canvases", {
  method: "POST",
  headers,
  body: JSON.stringify({ canvasId, title: "Primary model smoke test" }),
});
assert(
  created.response.status === 201 && created.body?.canvasId === canvasId,
  `Canvas creation failed (${created.response.status})`,
);
const sent = await request(`/conversations/${canvasId}/substreams/0/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    text: "Reply with exactly RALLY_MODEL_SMOKE_OK. Do not call any tools.",
    clientMessageId: `model-smoke-${canvasId}`,
  }),
});
assert(sent.response.status === 201, `The Canvas Chat refused the message (${sent.response.status})`);

const deadline = Date.now() + 90_000;
let detail;
let assistant;
while (Date.now() < deadline) {
  detail = await request(`/conversations/${canvasId}`, { headers });
  const status = detail.body?.latestHarnessRun?.status;
  const transcript = detail.body?.transcript;
  // The snapshot's ranges can overlap, so a turn is keyed by its sequence.
  const bySequence = new Map();
  for (const turn of [
    ...(transcript?.ranges ?? []).flatMap((range) => range.turns ?? []),
    ...(transcript?.activeTurns ?? []),
  ]) bySequence.set(turn.transcriptSequence, turn);
  const turns = [...bySequence.values()]
    .sort((left, right) => left.transcriptSequence - right.transcriptSequence);
  assistant = turns.filter((turn) => turn.actor === "assistant")
    .map((turn) => (turn.blocks ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""))
    .findLast((text) => text.length > 0);
  if ((status === "completed" || status === "needs_input" || status === "failed" || status === "stopped") && assistant) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

assert(detail?.response.ok, "Could not read the completed model run");
const run = detail.body?.latestHarnessRun;
assert(run?.status === "completed", `The model run ended in ${run?.status ?? "an unknown state"}`);
assert(run?.model === expectedModel, `Expected ${expectedModel}, received ${run?.model ?? "no model"}`);
assert(assistant?.includes("RALLY_MODEL_SMOKE_OK"), "The primary model returned an unexpected smoke response");

console.log(JSON.stringify({
  canvasId,
  status: run.status,
  model: run.model,
  response: "verified",
}));
