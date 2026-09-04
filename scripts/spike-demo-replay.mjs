#!/usr/bin/env node
/**
 * SPIKE — throwaway, `spike/demo-workspace-replay` only.
 *
 * Drives the whole demo-workspace reset experiment against a running
 * `pnpm dev:api:local`, and prints one JSON blob of evidence.
 *
 *   node scripts/spike-demo-replay.mjs > /tmp/spike-run.json
 *
 * Everything it reads back, it reads through ordinary product routes:
 * `GET /workstreams` (the directory), `GET /workstreams/:id` (detail plus the
 * canonical transcript snapshot), `GET /workspace/attention` (the home-screen
 * attention payload). It never reads SQLite.
 */
const BASE = process.env.SPIKE_API ?? "http://127.0.0.1:8787";
const out = { steps: [] };

function decodeJwtPayload(token) {
  const part = token.split(".")[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

async function call(method, path, { token, body, raw } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!response.ok && !raw) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 900)}`);
  }
  return { status: response.status, body: parsed };
}

function step(name, value) {
  out.steps.push({ name, value });
  process.stderr.write(`· ${name}\n`);
  return value;
}

async function createWorkspace(identityToken, name) {
  // Warm the regional binding first. A cold `POST /onboarding/workspace`
  // answers 503 `regional_onboarding_unavailable`, and that failure is not
  // free: it leaves a `pending` row in `platform_workspace_bindings`, which
  // `reserve` refuses to write past and nothing reclaims automatically — so one
  // cold 503 makes every later workspace create answer 409
  // `workspace_binding_conflict` until an operator clears the row by hand.
  for (let warm = 0; warm < 8; warm += 1) {
    await call("GET", "/onboarding", { token: identityToken, raw: true });
    await new Promise((r) => setTimeout(r, 1500));
  }
  const created = await call("POST", "/onboarding/workspace", {
    token: identityToken,
    body: { name, region: "global" },
    raw: true,
  });
  if (created.status !== 201) {
    throw new Error(`workspace create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const session = created.body;
  return {
    token: session.accessToken,
    workspaceId: session.workspace.id,
    userId: session.user.id,
    sessionId: decodeJwtPayload(session.accessToken).sid,
  };
}

async function verify(workspace, label) {
  const directory = await call("GET", "/workstreams?limit=50", { token: workspace.token });
  const attention = await call("GET", "/workspace/attention", { token: workspace.token });
  const details = [];
  for (const item of directory.body.items) {
    // Read as the presenter, which is a real product read and therefore settles
    // `first_opened_at`. Every "unseen" claim below is read from the *directory*
    // page above, which is fetched before any detail read.
    const detail = await call("GET", `/workstreams/${item.id}`, { token: workspace.token });
    const turns = detail.body.transcript.ranges.flatMap((range) => range.turns);
    const seen = new Map();
    for (const turn of turns) seen.set(turn.transcriptSequence ?? turn.id, turn);
    details.push({
      id: item.id,
      title: detail.body.title.slice(0, 60),
      scope: detail.body.scope,
      lastActivityAt: item.lastActivityAt,
      harnessStatus: detail.body.harnessStatus,
      directoryRow: {
        unreadCount: item.unreadCount ?? null,
        youAreMentioned: item.youAreMentioned ?? null,
        unseen: item.unseen ?? null,
        isParticipant: item.isParticipant ?? null,
      },
      participants: detail.body.participants.map((p) => p.user?.name ?? p.user?.id),
      resources: detail.body.resources.map((r) => ({
        title: r.title ?? r.resource?.title ?? r.id,
        relationship: r.relationshipType ?? null,
      })),
      openElicitations: detail.body.openElicitations.map((e) => ({
        id: e.id, status: e.status, targetUserId: e.targetUserId,
        responseType: e.responseType, optionCount: e.options.length,
      })),
      pluginRuns: (detail.body.transcript.pluginRuns ?? []).map((run) => ({
        pluginId: run.pluginId, displayName: run.displayName, state: run.state,
        durationMs: run.durationMs, toolCalls: run.toolCallIds.length,
        timingAccuracy: run.timingAccuracy,
      })),
      activityScopes: (detail.body.transcript.activities ?? []).map((a) => ({
        scope: a.scope, label: a.label, parent: a.parentActivityId ? "yes" : null,
        state: a.state,
      })),
      turns: [...seen.values()].map((turn) => ({
        actor: turn.actor,
        author: turn.authorSnapshot?.displayName ?? turn.authorUserId ?? null,
        createdAt: turn.createdAtUtc ?? turn.createdAt,
        sequence: turn.transcriptSequence ?? turn.sequenceNumber,
        blocks: (turn.blocks ?? []).map((b) => b.toolName ?? b.kind ?? b.type ?? "?"),
        text: ((turn.blocks ?? []).map((b) => b.text ?? b.markdown ?? "").join(" ")).slice(0, 140),
      })),
    });
  }
  return step(`verify:${label}`, {
    directoryOrder: directory.body.items.map((item) => ({
      id: item.id, title: item.title, lastActivityAt: item.lastActivityAt,
    })),
    attention: attention.body,
    details,
  });
}

async function main() {
  const identity = await call("POST", "/auth/dev/identity");
  const identityToken = identity.body.accessToken;
  step("identity", { userId: identity.body.user.id });

  // ---- W1 --------------------------------------------------------------
  const w1 = await createWorkspace(identityToken, "Tidepoint");
  step("w1.created", { workspaceId: w1.workspaceId, presenter: w1.userId });
  const seed1 = await call("POST", "/dev/spike/seed", {
    body: {
      workspaceId: w1.workspaceId,
      presenterUserId: w1.userId,
      presenterSessionId: w1.sessionId,
    },
  });
  step("w1.seed", seed1.body);
  await verify(w1, "w1");

  // Answer C's elicitation through the real API, as the presenter.
  const c = seed1.body.workstreams.find((w) => w.key === "C");
  const cDetail = await call("GET", `/workstreams/${c.workstreamId}`, { token: w1.token });
  const elicitation = cDetail.body.openElicitations[0];
  step("w1.elicitation", elicitation ? {
    id: elicitation.id, targetUserId: elicitation.targetUserId,
    responseType: elicitation.responseType,
    options: elicitation.options.map((o) => o.value),
  } : null);
  if (elicitation) {
    const answered = await call("POST", "/dev/spike/answer-elicitation", {
      raw: true,
      body: {
        workspaceId: w1.workspaceId,
        workstreamId: c.workstreamId,
        elicitationId: elicitation.id,
        userId: w1.userId,
        sessionId: w1.sessionId,
        // No `customResponse`: for a selection question it has to *be* one of
        // the answer values (`invalid_custom_elicitation_answer` otherwise), so
        // free text alongside a chosen option is not a shape the API accepts.
        answer: elicitation.options[1].value,
      },
    });
    step("w1.elicitation.answer", answered);
    await new Promise((r) => setTimeout(r, 8000));
    const after = await call("GET", `/workstreams/${c.workstreamId}`, { token: w1.token });
    step("w1.elicitation.after", {
      harnessStatus: after.body.harnessStatus,
      openElicitations: after.body.openElicitations.length,
      lastTurns: after.body.transcript.ranges.flatMap((r) => r.turns).slice(-4).map((t) => ({
        id: t.id, actor: t.actor,
        text: ((t.blocks ?? []).map((b) => b.text ?? "").join(" ")).slice(0, 200),
      })),
    });
  } else {
    step("w1.elicitation.answer", { skipped: "no open elicitation" });
  }

  // ---- arm a straggler, then retire W1 ---------------------------------
  // One more real message into C, deliberately *not* drained. Its directory and
  // activity effects sit in the substream's outbox when the retirement lands,
  // so there is something for the WorkspaceDO fence to refuse afterwards. A run
  // where nothing arrives proves the fence was never exercised.
  const straggler = await call("POST", "/dev/spike/probe-write", {
    body: {
      workspaceId: w1.workspaceId,
      workstreamId: c.workstreamId,
      userId: seed1.body.personaUserIds["dana-okafor"],
      text: "One last thing before we close this out.",
    },
  });
  step("w1.straggler_message", straggler.body);
  const beforeRetire = await call(
    "GET",
    `/dev/spike/retirement-state?workspaceId=${w1.workspaceId}`,
  );
  step("w1.directory_before_retire", beforeRetire.body.workspace.directoryLastActivity);

  const retired = await call("POST", "/dev/spike/retire", {
    body: { workspaceId: w1.workspaceId, reason: "spike_demo_reset" },
  });
  step("w1.retire", retired.body);

  // Now push the straggler at the retired WorkspaceDO, by hand, through the
  // same RPCs the Queue consumer uses.
  const forced = await call("POST", "/dev/spike/force-drain", {
    body: { workspaceId: w1.workspaceId, workstreamId: c.workstreamId },
  });
  step("w1.forced_drain_after_retire", forced.body);
  const afterRetire = await call(
    "GET",
    `/dev/spike/retirement-state?workspaceId=${w1.workspaceId}`,
  );
  step("w1.after_forced_drain", {
    droppedEffects: afterRetire.body.workspace.droppedEffects,
    directoryLastActivity: afterRetire.body.workspace.directoryLastActivity,
  });

  const probe = await call("POST", "/dev/spike/probe-write", {
    body: {
      workspaceId: w1.workspaceId,
      workstreamId: c.workstreamId,
      userId: seed1.body.personaUserIds["dana-okafor"],
      text: "Does a retired workspace still take writes?",
    },
  });
  step("w1.probe_write_after_retire", probe.body);

  const w1AuthAfter = await call("GET", "/workstreams?limit=5", { token: w1.token, raw: true });
  step("w1.session_after_retire", { status: w1AuthAfter.status, body: w1AuthAfter.body });

  // ---- W2 --------------------------------------------------------------
  // The regional binding needs warming again after W1's retirement closed the
  // presenter's session; the same cold-start 503 otherwise strands a `pending`
  // platform binding, which then refuses every later create with 409.
  await new Promise((r) => setTimeout(r, 3000));
  const w2 = await createWorkspace(identityToken, "Tidepoint");
  step("w2.created", { workspaceId: w2.workspaceId, presenter: w2.userId });
  const seed2 = await call("POST", "/dev/spike/seed", {
    body: {
      workspaceId: w2.workspaceId,
      presenterUserId: w2.userId,
      presenterSessionId: w2.sessionId,
    },
  });
  step("w2.seed", seed2.body);
  await verify(w2, "w2");

  // ---- prove the reset held --------------------------------------------
  const waitSeconds = Number(process.env.SPIKE_STRAGGLER_WAIT_S ?? 90);
  process.stderr.write(`· waiting ${waitSeconds}s for stragglers\n`);
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));

  step("w1.retirement_state", (await call(
    "GET",
    `/dev/spike/retirement-state?workspaceId=${w1.workspaceId}`
      + `&workstreamIds=${seed1.body.workstreams.map((w) => w.workstreamId).join(",")}`,
  )).body);
  await verify(w2, "w2.after_wait");
  step("w2.retirement_state", (await call(
    "GET",
    `/dev/spike/retirement-state?workspaceId=${w2.workspaceId}`
      + `&workstreamIds=${seed2.body.workstreams.map((w) => w.workstreamId).join(",")}`,
  )).body);

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error) => {
  out.error = { message: error.message, stack: error.stack };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(1);
});
