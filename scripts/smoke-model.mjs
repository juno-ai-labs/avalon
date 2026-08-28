const baseUrl = process.env.AVALON_SMOKE_BASE_URL ?? "http://127.0.0.1:8787";
const expectedModel = process.env.AVALON_SMOKE_MODEL ?? "google/gemini-3.7-flash";

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
    body: JSON.stringify({ workspaceName: "Avalon model smoke" }),
  });
  assert(session.response.status === 201 && session.body?.accessToken, "Development sign-in failed");
  accessToken = session.body.accessToken;
}
const headers = {
  authorization: `Bearer ${accessToken}`,
  "content-type": "application/json",
};

const created = await request("/workstreams", {
  method: "POST",
  headers,
  body: JSON.stringify({
    title: "Primary model smoke test",
    objective: "Verify that Avalon's configured primary model completes a real request.",
    participantUserIds: [],
    openingMessage: "Reply with exactly AVALON_MODEL_SMOKE_OK. Do not call any tools.",
    clientMessageId: `model-smoke-${crypto.randomUUID()}`,
  }),
});
assert(created.response.status === 201, `Work-stream creation failed (${created.response.status})`);
const workstreamId = created.body?.workstream?.id;
assert(workstreamId, "The model smoke work stream has no ID");

const deadline = Date.now() + 90_000;
let detail;
let messages;
while (Date.now() < deadline) {
  [detail, messages] = await Promise.all([
    request(`/workstreams/${workstreamId}`, { headers }),
    request(`/workstreams/${workstreamId}/messages?limit=50`, { headers }),
  ]);
  const status = detail.body?.latestHarnessRun?.status;
  const assistant = messages.body?.items?.find((message) => message.author?.type === "agent" && message.textContent);
  if ((status === "completed" || status === "needs_input" || status === "failed" || status === "stopped") && assistant) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

assert(detail?.response.ok && messages?.response.ok, "Could not read the completed model run");
const run = detail.body?.latestHarnessRun;
const assistant = messages.body?.items?.find((message) => message.author?.type === "agent" && message.textContent);
assert(run?.status === "completed", `The model run ended in ${run?.status ?? "an unknown state"}`);
assert(run?.model === expectedModel, `Expected ${expectedModel}, received ${run?.model ?? "no model"}`);
assert(assistant?.textContent?.includes("AVALON_MODEL_SMOKE_OK"), "The primary model returned an unexpected smoke response");

console.log(JSON.stringify({
  workstreamId,
  status: run.status,
  model: run.model,
  response: "verified",
}));
