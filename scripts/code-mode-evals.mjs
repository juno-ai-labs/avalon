// Prompt evaluations for Code Mode and Sidekick custom tools, against the local
// API (`pnpm dev:api:local`) and the real models it routes to. Not a test: it
// spends model calls and takes minutes, so it is run by hand when a prompt or
// a tool contract changes. docs/code-mode.md#testing records what each round
// changed.
//
// usage: node scripts/code-mode-evals.mjs --suite code|wizard|final|prod|all
//        [--models sol,terra] [--only E1,M1] [--concurrency 2] [--timeout 600] [--out round.json]
//
// `code` runs work-stream conversations (Sol is the primary model, Terra is
// pinned per conversation); `wizard` and `final` author Sidekicks in the wizard
// and then run them on the primary model. Graders read the transcript and the
// saved definition, and every expected number is computed for 2026-10-31.
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, part, i, all) => {
  if (part.startsWith("--")) acc.push([part.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return acc;
}, []));
// Sol is the primary model locally and not an override the API accepts; Terra is pinned per conversation.
const MODELS = { sol: null, terra: "openai/gpt-5.6-terra" };
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const healthy = async () => { try { return (await fetch(new URL("/health", baseUrl))).ok; } catch { return false; } };
const request = async (path, options = {}) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(new URL(path, baseUrl), options);
      const body = await response.json().catch(() => null);
      return { response, body };
    } catch (error) {
      // The local Worker restarts under load; wait for it rather than failing the scenario.
      if (attempt >= 20) throw error;
      let waited = 0;
      while (!(await healthy()) && waited < 180_000) { await new Promise((r) => setTimeout(r, 5000)); waited += 5000; }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};
const session = await request("/auth/dev/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
if (session.response.status !== 201) throw new Error(`dev session ${session.response.status} ${JSON.stringify(session.body)}`);
const headers = { authorization: `Bearer ${session.body.accessToken}`, "content-type": "application/json" };

/** The transcript as a grader reads it: tool calls in order, and the agent's text. */
function summarize(detail) {
  const transcript = detail.body?.transcript;
  const bySequence = new Map();
  for (const turn of [...(transcript?.ranges ?? []).flatMap((r) => r.turns ?? []), ...(transcript?.activeTurns ?? [])]) bySequence.set(turn.transcriptSequence, turn);
  const turns = [...bySequence.values()].sort((a, b) => a.transcriptSequence - b.transcriptSequence);
  const tools = []; const texts = [];
  for (const turn of turns) for (const b of turn.blocks ?? []) {
    if (b.type === "tool") tools.push({ name: b.toolName, status: b.status, input: b.participantSafeInput ?? null, result: b.participantSafeResult ?? null, error: b.error ?? null });
    else if (b.type === "text" && turn.actor !== "user") texts.push(b.text);
  }
  return { status: detail.body?.latestHarnessRun?.status, model: detail.body?.latestHarnessRun?.model, tools, texts, finalText: texts.at(-1) ?? "" };
}
async function waitFor(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs; let detail;
  while (Date.now() < deadline) {
    detail = await request(path, { headers });
    if (["completed", "needs_input", "failed", "stopped"].includes(detail.body?.latestHarnessRun?.status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return detail;
}
async function runWorkstream(message, model, timeoutMs) {
  const created = await request("/workstreams", { method: "POST", headers, body: JSON.stringify({
    title: `Eval ${Date.now()}`, objective: "Evaluation of program composition.", participantUserIds: [],
    openingMessage: message, clientMessageId: `eval-${crypto.randomUUID()}`, ...(model ? { modelOverride: model } : {}),
  }) });
  if (created.response.status !== 201) throw new Error(`create ${created.response.status} ${JSON.stringify(created.body)}`);
  const id = created.body.workstream.id;
  return { id, ...summarize(await waitFor(`/conversations/${id}`, timeoutMs)) };
}
async function sendToWizard(sidekickId, message, timeoutMs) {
  const sent = await request(`/conversations/${sidekickId}/substreams/0/messages`, { method: "POST", headers, body: JSON.stringify({
    text: message, clientMessageId: `eval-${crypto.randomUUID()}`, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
  }) });
  if (sent.response.status !== 201) throw new Error(`send ${sent.response.status} ${JSON.stringify(sent.body)}`);
  return summarize(await waitFor(`/conversations/${sidekickId}`, timeoutMs));
}
async function readSidekick(sidekickId) {
  const sidekick = await request(`/sidekicks/${sidekickId}`, { headers });
  return { lifecycle: sidekick.body?.lifecycle, definition: sidekick.body?.currentDefinition ?? null };
}
async function runSidekick(sidekickId, timeoutMs) {
  const started = await request(`/sidekicks/${sidekickId}/run`, { method: "POST", headers: { ...headers, "idempotency-key": `eval-${crypto.randomUUID()}` } });
  if (started.response.status !== 202) throw new Error(`run ${started.response.status} ${JSON.stringify(started.body)}`);
  return { runId: started.body.runId, ...summarize(await waitFor(`/conversations/${sidekickId}/substreams/${started.body.runId}`, timeoutMs)) };
}

const has = (text, ...needles) => needles.every((n) => text.replace(/,/g, "").includes(String(n).replace(/,/g, "")));
const called = (s, name) => s.tools.filter((t) => t.name === name || t.name.endsWith(`_${name}`));
const failedTools = (s) => s.tools.filter((t) => t.status === "failed");
const programs = (s) => called(s, "code_execute");
const customCalls = (s) => s.tools.filter((t) => t.name.startsWith("custom_"));

const CODE = [
  { id: "E1", level: "easy", message: "What's 23.5% of 48,920, and what ISO week number are we in right now? Give exact numbers.",
    grade: (s) => ({ pass: s.status === "completed" && has(s.finalText, "11496.2") && has(s.finalText, "44") && failedTools(s).length === 0,
      notes: `programs=${programs(s).length} failed=${failedTools(s).length}` }) },
  { id: "E2", level: "easy", message: "What time is it in Tokyo right now?",
    grade: (s) => ({ pass: s.status === "completed" && programs(s).length === 0 && failedTools(s).length === 0, notes: `programs=${programs(s).length} (a single call should be direct)` }) },
  { id: "M1", level: "medium", message: "Create a memory table called weekday_countdown with columns date (text), weekday (text) and days_to_christmas (integer). Fill it with the 7 weekdays (Mon to Fri only) starting Monday 2026-11-02, where days_to_christmas counts the days until 2026-12-25. Then tell me the sum of days_to_christmas across all rows.",
    grade: (s) => ({ pass: s.status === "completed" && has(s.finalText, "346") && failedTools(s).length === 0, notes: `programs=${programs(s).length} tools=${s.tools.map((t) => t.name).join(",")}` }) },
  { id: "M2", level: "medium", message: "For these dates, give me only the ones that fall in an even-numbered ISO week: 2026-01-05, 2026-02-14, 2026-03-31, 2026-07-04, 2026-11-20, 2026-12-25. Compute it exactly, don't guess.",
    grade: (s) => ({ pass: s.status === "completed" && has(s.finalText, "2026-01-05", "2026-03-31", "2026-12-25") && !has(s.finalText, "2026-02-14") && !has(s.finalText, "2026-07-04") && !has(s.finalText, "2026-11-20"),
      notes: `programs=${programs(s).length}` }) },
  { id: "H1", level: "hard", message: "Create a memory table 'inventory' with columns item (text), qty (integer), unit_cost (real). Insert these rows: widget 12 @ 2.5, gadget 3 @ 10, gizmo 7 @ 4.25, doohickey 0 @ 99. Then read the table back and report the total inventory value (sum of qty*unit_cost) and which item has the highest value. Compute exactly.",
    grade: (s) => ({ pass: s.status === "completed" && has(s.finalText, "89.75") && failedTools(s).length === 0 && (has(s.finalText, "widget") || has(s.finalText, "gadget")), notes: `programs=${programs(s).length} tools=${s.tools.map((t) => t.name).join(",")}` }) },
  { id: "H2", level: "hard", message: "In one program: first try calling a tool named rally_core.nonexistent_tool; if that throws, catch it and instead compute 2 to the power of 40 exactly and return both the error message you caught and the number. Then tell me both.",
    grade: (s) => ({ pass: s.status === "completed" && has(s.finalText, "1099511627776") && programs(s).some((p) => p.status === "completed"), notes: `programs=${programs(s).map((p) => p.status).join(",")}` }) },
  { id: "X1", level: "extra", message: "Using a single program: create a memory table 'nov_days' with columns day (integer), weekday (text), iso_week (integer), insert one row for every day of November 2026, then read the table back and tell me: how many Mondays there are, which ISO weeks appear (list them), and the sum of the day numbers of all Sundays.",
    grade: (s) => ({ pass: s.status === "completed" && has(s.finalText, "5") && has(s.finalText, "75") && has(s.finalText, "44") && has(s.finalText, "49") && failedTools(s).length === 0, notes: `programs=${programs(s).length} tools=${s.tools.map((t) => t.name).join(",")}` }) },
  { id: "X2", level: "extra", message: "Write and run a program that creates a memory table 'ledger' with one column entry (text), inserts the rows 'one' and 'two', and then throws new Error('stop here') before inserting 'three'. After that program fails, do not insert 'one' or 'two' again; insert only 'three', then read the table and tell me the final row count and the entries.",
    grade: (s) => {
      const inserts = s.tools.filter((t) => /insert|rows|table/.test(t.name) && JSON.stringify(t.input ?? "").includes("\"one\""));
      const ledger = has(s.finalText, "3");
      return { pass: s.status === "completed" && ledger && has(s.finalText, "three") && !/4 rows|five|4 entries/.test(s.finalText), notes: `programs=${programs(s).map((p) => p.status).join(",")} directInsertsOfOne=${inserts.length}` };
    } },
  { id: "X3", level: "extra", message: "I need the exact number of seconds between 2026-03-08T01:30:00 America/Los_Angeles and 2026-03-08T03:30:00 America/Los_Angeles (DST starts that morning), and the number of days from today until 2027-01-01 counted in Pacific time. Use the current time tool for today, not the program's clock.",
    grade: (s) => { const usesTimeTool = called(s, "current_time").length > 0 || programs(s).some((p) => JSON.stringify(p.input ?? "").includes("current_time"));
      return { pass: s.status === "completed" && has(s.finalText, "3600") && failedTools(s).length === 0 && usesTimeTool, notes: `programs=${programs(s).length} usesTimeTool=${usesTimeTool}` }; } },
  { id: "E3", level: "easy", message: "Create a memory table called notes with one text column called text, and insert one row with the text 'hello'.",
    grade: (s) => ({ pass: s.status === "completed" && failedTools(s).length === 0, notes: `programs=${programs(s).length} tools=${s.tools.map((t) => t.name).join(",")}` }) },
  { id: "X4", level: "extra", message: "Insert 120 rows into a new memory table 'big' with one integer column n holding 1 through 120. Then read the table back in pages and report the sum of n over the rows where n is divisible by 7. Compute exactly.",
    grade: (s) => ({ pass: s.status === "completed" && has(s.finalText, "1071") && failedTools(s).length === 0, notes: `programs=${programs(s).length} tools=${s.tools.map((t) => t.name).join(",")}` }) },
  { id: "X5", level: "extra", message: "Run a program that creates a memory table 'resend_test' with one text column entry and inserts one row 'alpha'. Then run exactly the same program text a second time. Then read the table and tell me how many rows it has and why.",
    // Tables dedupe on their key columns, so one row is the right answer when the model made entry the key; what matters is that
    // the second send ran again (no replay claim) and the explanation comes from evidence.
    grade: (s) => ({ pass: s.status === "completed" && programs(s).filter((p) => p.status === "completed").length >= 2 && !/replay(ed)? (from|the) (cache|receipt)|did not run|was skipped because it already ran/i.test(s.finalText) && /\b[12]\b|one|two/.test(s.finalText), notes: `programs=${programs(s).map((p) => p.status).join(",")} text=${s.finalText.slice(0, 160)}` }) },
  { id: "X6", level: "extra", message: "Using one program only and no direct tool calls: read the current time tool and return the exact ISO 8601 timestamp it reports plus the weekday name in Pacific time. Then tell me both.",
    grade: (s) => ({ pass: s.status === "completed" && called(s, "current_time").length === 0 && programs(s).some((p) => p.status === "completed") && /Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday/.test(s.finalText) && /2026-\d\d-\d\dT/.test(s.finalText),
      notes: `programs=${programs(s).map((p) => p.status).join(",")} direct=${called(s, "current_time").length} text=${s.finalText.slice(0, 120)}` }) },
  { id: "T1", level: "choice", message: "Run this Python and tell me what it prints: print(sum(i*i for i in range(1, 101)))",
    grade: (s) => { const terminal = called(s, "load_plugin").some((t) => JSON.stringify(t.input ?? "").includes("rally_terminal")); const code = called(s, "load_plugin").some((t) => JSON.stringify(t.input ?? "").includes("rally_code"));
      return { pass: s.status === "completed" && terminal && !code, notes: `terminal=${terminal} code=${code} text=${s.finalText.slice(0, 80)}` }; } },
  { id: "T2", level: "choice", message: "What is 17.5% of 36,480, exactly? And what is that divided by 7, to three decimals?",
    grade: (s) => { const terminal = called(s, "load_plugin").some((t) => JSON.stringify(t.input ?? "").includes("rally_terminal"));
      return { pass: s.status === "completed" && !terminal && has(s.finalText, "6384") && has(s.finalText, "912"), notes: `terminal=${terminal} programs=${programs(s).length} text=${s.finalText.slice(0, 80)}` }; } },
  { id: "T3", level: "choice", message: "Create a CSV file with the numbers 1 through 10 and their squares, and publish it as a file I can download from this conversation.",
    grade: (s) => { const terminal = called(s, "load_plugin").some((t) => JSON.stringify(t.input ?? "").includes("rally_terminal")); const code = called(s, "load_plugin").some((t) => JSON.stringify(t.input ?? "").includes("rally_code"));
      return { pass: terminal && !code, notes: `status=${s.status} terminal=${terminal} code=${code} tools=${s.tools.map((t) => t.name).join(",")}` }; } },
];

const WIZARD = [
  { id: "WE1", level: "easy", message: "Set up a Sidekick I can run on demand that reports how many days are left until 2026-12-25 and the current ISO week number, counting in Pacific time. Make the date arithmetic a saved tool so every run computes it the same way.",
    gradeWizard: (w, sk) => { const tools = sk.definition?.customTools ?? []; return { pass: sk.lifecycle === "active" && tools.length >= 1 && called(w, "tool_test").some((t) => t.status === "completed"), notes: `tools=${tools.map((t) => t.name).join(",")} tested=${called(w, "tool_test").map((t) => t.status).join(",")} lifecycle=${sk.lifecycle}` }; },
    run: true,
    gradeRun: (r) => ({ pass: r.status === "completed" && customCalls(r).some((t) => t.status === "completed") && programs(r).length === 0 && /\b4[4-9]\b|\b5[0-3]\b/.test(r.finalText), notes: `custom=${customCalls(r).map((t) => `${t.name}:${t.status}`).join(",")} programs=${programs(r).length} tools=${r.tools.map((t) => t.name).join(",")}` }) },
  { id: "WE2", level: "easy", message: "Set up a Sidekick I can run on demand that simply reminds me to drink a glass of water and stretch, in a friendly one-liner.",
    gradeWizard: (w, sk) => ({ pass: sk.lifecycle === "active" && (sk.definition?.customTools ?? []).length === 0, notes: `tools=${(sk.definition?.customTools ?? []).length} (no deterministic method, no tool expected)` }), run: false },
  { id: "WM1", level: "medium", message: "Set up an on-demand Sidekick that keeps a memory table called runs_log; each run appends one row with the run's date (Pacific) and ISO week, then reports how many rows the table now has. Put the table work in a saved tool.",
    gradeWizard: (w, sk) => { const tools = sk.definition?.customTools ?? []; return { pass: sk.lifecycle === "active" && tools.length >= 1 && tools.some((t) => t.requiredPlugins.includes("rally_tables")) && singlePurpose(sk), notes: `tools=${tools.map((t) => `${t.name}[${t.requiredPlugins.join("+")}](${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} flags=${flagged(sk).join(",")}` }; },
    run: true,
    gradeRun: (r) => ({ pass: r.status === "completed" && customCalls(r).some((t) => t.status === "completed") && /\b\d+\b/.test(r.finalText) && programs(r).length === 0, notes: `custom=${customCalls(r).map((t) => `${t.name}:${t.status}`).join(",")} tools=${r.tools.map((t) => t.name).join(",")}` }) },
  { id: "WM2", level: "medium", message: "Set up a Sidekick I can run on demand that reports how many days are left until 2026-12-25, with the arithmetic in a saved tool.",
    followUp: "Change the target date to 2027-01-01 instead.",
    gradeWizard: (w, sk) => { const tools = sk.definition?.customTools ?? []; return { pass: sk.lifecycle === "active" && tools.some((t) => t.code.includes("2027") || JSON.stringify(t.inputSchema).includes("2027")) && called(w, "tool_test").filter((t) => t.status === "completed").length >= 1, notes: `tools=${tools.map((t) => t.name).join(",")} has2027=${tools.some((t) => t.code.includes("2027"))} tests=${called(w, "tool_test").map((t) => t.status).join(",")}` }; },
    run: true,
    gradeRun: (r) => ({ pass: r.status === "completed" && customCalls(r).some((t) => t.status === "completed") && /\b6[0-2]\b/.test(r.finalText), notes: `custom=${customCalls(r).map((t) => `${t.name}:${t.status}`).join(",")} text=${r.finalText.slice(0, 160)}` }) },
  { id: "WH1", level: "hard", message: "Set up an on-demand Sidekick that computes the next biweekly paydays (Fridays, starting 2026-11-06), stores them in a memory table 'paydays' with columns date (text) and iso_week (integer) without creating duplicate rows across runs, and reports the dates. Save the deterministic part as a tool that takes the number of paydays as input; runs should ask for 4.",
    gradeWizard: (w, sk) => { const tools = sk.definition?.customTools ?? []; return { pass: sk.lifecycle === "active" && tools.some((t) => Object.keys(t.inputSchema.properties ?? {}).length >= 1), notes: `tools=${tools.map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")}` }; },
    run: true,
    gradeRun: (r) => ({ pass: r.status === "completed" && customCalls(r).some((t) => t.status === "completed") && (has(r.finalText, "2026-11-06", "2026-11-20", "2026-12-04", "2026-12-18") || has(r.finalText, "November 6", "November 20", "December 4", "December 18")), notes: `custom=${customCalls(r).map((t) => `${t.name}:${t.status}`).join(",")} text=${r.finalText.slice(0, 200)}` }) },
  { id: "WX1", level: "extra", message: "Set up a Sidekick that every morning posts our open Linear issue count to the #eng Slack channel, with the count fetched by a saved tool.",
    gradeWizard: (w, sk) => { const tools = sk.definition?.customTools ?? []; const overConnector = tools.filter((t) => t.requiredPlugins.some((p) => p.startsWith("plugin_"))); return { pass: overConnector.length === 0 && called(w, "tool_test").every((t) => t.status !== "completed" || true), notes: `lifecycle=${sk.lifecycle} tools=${tools.map((t) => `${t.name}[${t.requiredPlugins.join("+")}]`).join(",")} text=${w.finalText.slice(0, 200)}` }; }, run: false },
  { id: "WX2", level: "extra", message: "Set up an on-demand Sidekick that searches the web for the phrase 'Cloudflare Dynamic Workers' and reports the title of the top result. Put the search in a saved tool.",
    gradeWizard: (w, sk) => { const tools = sk.definition?.customTools ?? []; return { pass: sk.lifecycle === "active" && tools.some((t) => t.requiredPlugins.includes("rally_web")), notes: `tools=${tools.map((t) => `${t.name}[${t.requiredPlugins.join("+")}]`).join(",")}` }; },
    run: true,
    gradeRun: (r) => ({ pass: r.status === "completed" && customCalls(r).some((t) => t.status === "completed") && r.finalText.length > 20, notes: `custom=${customCalls(r).map((t) => `${t.name}:${t.status}`).join(",")} loads=${called(r, "load_plugin").map((t) => JSON.stringify(t.input)).join(",")} text=${r.finalText.slice(0, 160)}` }) },
];


/** Twenty wizard scenarios of increasing complexity: the final eval. Runs use the primary model. */
const toolsOf = (sk) => sk.definition?.customTools ?? [];
const active = (sk) => sk.lifecycle === "active";
const tested = (w) => called(w, "tool_test").some((t) => t.status === "completed");
const ranCustom = (r) => r.status === "completed" && customCalls(r).some((t) => t.status === "completed");
const FINAL = [
  { id: "F01", level: "1", message: "Set up a Sidekick I can run on demand that replies with one short motivational quote.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).length === 0, notes: `tools=${toolsOf(sk).length}` }), run: true,
    gradeRun: (r) => ({ pass: r.status === "completed" && r.finalText.length > 10, notes: r.finalText.slice(0, 80) }) },
  { id: "F02", level: "2", message: "Set up an on-demand Sidekick that reports how many days remain until 2026-12-25 in Pacific time, with the arithmetic in a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).length >= 1 && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b(4[0-9]|5[0-5])\b/.test(r.finalText), notes: `custom=${customCalls(r).map((t) => t.status).join(",")} text=${r.finalText.slice(0, 100)}` }) },
  { id: "F03", level: "3", message: "Set up an on-demand Sidekick that reports today's ISO week number and day of the year, both in Pacific time, computed by a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).length >= 1 && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b4[4-6]\b/.test(r.finalText) && /\b30[0-9]\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 120)}` }) },
  { id: "F04", level: "4", message: "Set up an on-demand Sidekick that reports the date and weekday a given number of days from today in Pacific time. The saved tool takes the number of days as input; runs use 10.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => Object.keys(t.inputSchema.properties ?? {}).length >= 1) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /2026-11-1[01]|November 1[01]/.test(r.finalText), notes: `text=${r.finalText.slice(0, 120)}` }) },
  { id: "F05", level: "5", message: "Set up an on-demand Sidekick that converts an amount from USD to EUR at a fixed rate of 0.92 and rounds to cents. The saved tool takes the amount and the direction as inputs and refuses a negative amount. Runs convert 1234.56 USD to EUR.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => Object.keys(t.inputSchema.properties ?? {}).length >= 2) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && has(r.finalText, "1135.8"), notes: `text=${r.finalText.slice(0, 120)}` }) },
  { id: "F06", level: "6", message: "Set up an on-demand Sidekick that keeps a memory table 'visits': each run appends one row with the run's UTC timestamp and then reports how many rows the table holds. Put the table work in a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables")) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}[${t.requiredPlugins.join("+")}]`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b[1-9]\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 120)}` }) },
  { id: "F07", level: "7", message: "Set up an on-demand Sidekick over a memory table 'expenses' with columns item (text) and amount (real). During setup insert three rows: coffee 10.5, lunch 20.25, taxi 30. Each run reads the table with a saved tool and reports the total and the average amount, exactly.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables")) && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && has(r.finalText, "60.75") && has(r.finalText, "20.25"), notes: `text=${r.finalText.slice(0, 140)}` }) },
  { id: "F08", level: "8", message: "Set up an on-demand Sidekick that computes the next biweekly paydays (Fridays, starting 2026-11-06), stores them in a memory table 'paydays' with columns date (text) and iso_week (integer) without creating duplicate rows across runs, and reports the dates. Save the deterministic part as a tool that takes the number of paydays as input; runs should ask for 4.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => Object.keys(t.inputSchema.properties ?? {}).length >= 1) && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && (has(r.finalText, "2026-11-06", "2026-11-20", "2026-12-04", "2026-12-18") || has(r.finalText, "November 6", "November 20", "December 4", "December 18")), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "F09", level: "9", message: "Set up an on-demand Sidekick over a memory table 'nums' with one integer column n. During setup insert n = 1 through 150. Each run uses a saved tool that reads every row, page by page, and reports the sum of all even n.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables")) && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")} code_next=${toolsOf(sk).some((t) => t.code.includes("_next") || t.code.includes("nextPageId"))}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && has(r.finalText, "5700"), notes: `text=${r.finalText.slice(0, 120)}` }) },
  { id: "F10", level: "10", message: "Set up an on-demand Sidekick that searches the web for 'Cloudflare Dynamic Workers' and reports the title and URL of the top result. Put the search in a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_web")) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}[${t.requiredPlugins.join("+")}]`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /https?:\/\//.test(r.finalText), notes: `custom=${customCalls(r).map((t) => t.status).join(",")} loads=${called(r, "load_plugin").length} text=${r.finalText.slice(0, 120)}` }) },
  { id: "F11", level: "11", message: "Set up an on-demand Sidekick that fetches https://developers.cloudflare.com/dynamic-workers/ and reports how many times the word 'Worker' (case-insensitive, including 'Workers') appears in the page text, counted by a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_web")) && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b[1-9]\d*\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 120)}` }) },
  { id: "F12", level: "12", message: "Set up an on-demand Sidekick that records the current ISO week (Pacific) in a memory table 'weeks' only if that week has no row yet, and reports whether it inserted a new row or found the week already recorded. Use a saved tool for the check-and-insert.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables")) && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /insert|new|record|already|exist|skipp/i.test(r.finalText), notes: `text=${r.finalText.slice(0, 120)}` }) },
  { id: "F13", level: "13", message: "Set up a Sidekick I can run on demand that reports how many days are left until 2026-12-25, with the arithmetic in a saved tool.",
    followUp: "Change the target date to 2027-01-01 instead.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.code.includes("2027")) && called(w, "tool_test").filter((t) => t.status === "completed").length >= 2, notes: `has2027=${toolsOf(sk).some((t) => t.code.includes("2027"))} tests=${called(w, "tool_test").map((t) => t.status).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b6[0-2]\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 100)}` }) },
  { id: "F14", level: "14", message: "Set up an on-demand Sidekick that reports the date and weekday a given number of days from today. The saved tool takes the number of days as input; runs use 10.",
    followUp: "Add a timezone input to the tool, defaulting to America/Los_Angeles, and have runs pass Asia/Tokyo.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => Object.keys(t.inputSchema.properties ?? {}).some((k) => /zone|tz/i.test(k))) && called(w, "tool_test").filter((t) => t.status === "completed").length >= 2, notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} tests=${called(w, "tool_test").map((t) => t.status).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /2026-11-1[01]|November 1[01]/.test(r.finalText) && customCalls(r).some((t) => JSON.stringify(t.input ?? "").includes("Tokyo")), notes: `inputs=${customCalls(r).map((t) => JSON.stringify(t.input)).join(",")} text=${r.finalText.slice(0, 100)}` }) },
  { id: "F15", level: "15", message: "Set up a Sidekick that every morning posts our open Linear issue count to the #eng Slack channel, with the count fetched by a saved tool.",
    gradeWizard: (w, sk) => ({ pass: toolsOf(sk).every((t) => !t.requiredPlugins.some((p) => p.startsWith("plugin_"))) && !active(sk) || toolsOf(sk).length === 0, notes: `lifecycle=${sk.lifecycle} tools=${toolsOf(sk).map((t) => `${t.name}[${t.requiredPlugins.join("+")}]`).join(",")} text=${w.finalText.slice(0, 120)}` }), run: false },
  { id: "F16", level: "16", message: "Save a reusable skill, with no triggers, explaining how to write a good commit message for this team: subject under 50 characters, imperative mood, body says why.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && (sk.definition?.triggers ?? []).length === 0 && toolsOf(sk).length === 0, notes: `triggers=${(sk.definition?.triggers ?? []).length} tools=${toolsOf(sk).length} lifecycle=${sk.lifecycle}` }), run: false },
  { id: "F17", level: "17", message: "Set up a Sidekick that runs every weekday at 9am Pacific and reports how many days remain until 2026-12-25, computed by a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && (sk.definition?.triggers ?? []).some((t) => /schedule|cron|calendar/i.test(t.type)) && toolsOf(sk).length >= 1 && tested(w), notes: `triggers=${(sk.definition?.triggers ?? []).map((t) => t.type).join(",")} tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b(4[0-9]|5[0-5])\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 100)}` }) },
  { id: "F18", level: "18", message: "Set up an on-demand Sidekick with two saved tools: one that computes the next 3 biweekly Fridays from 2026-11-06, and a second that appends those dates to a memory table 'calendar' without duplicates and returns the table's row count. Each run calls both and reports the dates and the count.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).length >= 2 && tested(w), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && new Set(customCalls(r).filter((t) => t.status === "completed").map((t) => t.name)).size >= 2 && (has(r.finalText, "2026-11-20", "2026-12-04") || has(r.finalText, "November 20", "December 4")), notes: `custom=${customCalls(r).map((t) => `${t.name}:${t.status}`).join(",")} text=${r.finalText.slice(0, 120)}` }) },
  { id: "F19", level: "19", message: "Set up an on-demand Sidekick that reports a weekly summary: the number of rows added to memory table 'events' in the last 7 days (Pacific), the busiest weekday among them, and the ISO week being summarized. During setup create the table with columns happened_at (text, ISO timestamp) and label (text) and insert six rows spread over the last five days. Put the counting in a saved tool that takes the number of days to look back as input; runs use 7.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables") && Object.keys(t.inputSchema.properties ?? {}).length >= 1) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b6\b/.test(r.finalText) && /W?4[4-6]\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "F20", level: "20", message: "Set up an on-demand Sidekick over a memory table 'inventory' (item text, qty integer, unit_cost real), seeded during setup with widget 12 @ 2.5, gadget 3 @ 10, gizmo 7 @ 4.25. Each run uses a saved tool that takes a markup percentage, computes each item's value with the markup, the total, and the highest-value item, writes one row per Pacific date (no duplicates on the same day) to a table 'valuations' with the date and total, and returns everything. Runs use a 10 percent markup and report the total, the highest item, and whether a valuation row was written.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables") && Object.keys(t.inputSchema.properties ?? {}).length >= 1) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && has(r.finalText, "98.7") && /widget|gadget/.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
];

/**
 * Scenarios shaped after Sidekicks running in production (daily signup and
 * activity reports, careers-page monitors with baseline ledgers, note deltas
 * behind a cursor, weekly call prep, hourly dashboards, polling windows,
 * research dedup, triage over connectors), rewritten over the plugins a local
 * run holds: memory tables, time, the public web. A connector the request
 * names and the run lacks is the point of that scenario.
 */
/** No mode, action, dry-run or preview input: one tool is one task. */
const FLAG_INPUT = /^(mode|action|dry_?run|preview|record_[a-z_]+|only_[a-z_]+|skip_[a-z_]+)$/i;
const singlePurpose = (sk) => toolsOf(sk).every((t) => !Object.keys(t.inputSchema.properties ?? {}).some((k) => FLAG_INPUT.test(k)));
const flagged = (sk) => toolsOf(sk).flatMap((t) => Object.keys(t.inputSchema.properties ?? {}).filter((k) => FLAG_INPUT.test(k)).map((k) => `${t.name}.${k}`));
// A tool runs the routine procedure, its own table writes included; delivery to people stays with the run.
// Delivery tools across Rally and the connectors: conversation and agent messages, mail, replies, comments.
// A dotted connector name such as gmail.send is called in bracket form: tools.plugin_google["gmail.send"](...).
const POSTS = /(?:\.|\[\s*["'`](?:\w+\.)?)(conversation_post|post|send_message|send|reply|reply_to_message|create_comment)(?:["'`]\s*\])?\s*\(/;
// A table the tool writes is passed in, so a test or review can point it at a scratch table.
// Only writes are graded: a fixed read cannot change the live tables during a test.
// A table found by name (create reopens a same-named table, search returns it) is as fixed as a literal ID.
const TABLE_WRITES = /\.(insert_rows|update_rows|delete_rows|invalidate_rows)\s*\(/;
const FIXED_TABLE = /['"`]mtt_[A-Za-z0-9_-]+['"`]|rally_tables\.(create|search)\s*\(/;
const MAX_TOOLS = 4;
const posters = (sk) => toolsOf(sk).filter((t) => POSTS.test(t.code)).map((t) => t.name);
const fixedWriters = (sk) => toolsOf(sk).filter((t) => TABLE_WRITES.test(t.code) && FIXED_TABLE.test(t.code)).map((t) => t.name);
const shaped = (sk) => singlePurpose(sk) && posters(sk).length === 0 && fixedWriters(sk).length === 0 && toolsOf(sk).length <= MAX_TOOLS;
const shapeNotes = (sk) => `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} count=${toolsOf(sk).length} flags=${flagged(sk).join(",")} posters=${posters(sk).join(",")} fixedTables=${fixedWriters(sk).join(",")}`;

const PROD = [
  { id: "P01", level: "daily activity report", message: "Set up a Sidekick that every day at 9am Pacific reports how many rows were added to memory table 'org_messages' (columns org text, sent_at text ISO timestamp) during the preceding Pacific calendar day, DST-aware, and how many distinct orgs sent them. Keep a checkpoint in a second table so a day a run missed is covered by the next run. During setup create the tables and insert 8 rows spread over yesterday and today across three orgs. Put the counting in a saved tool that takes the day to count as input. Report in the run's own conversation; do not post to another conversation.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables") && Object.keys(t.inputSchema.properties ?? {}).length >= 1) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} triggers=${(sk.definition?.triggers ?? []).map((t) => t.type).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b\d+\b/.test(r.finalText) && /org/i.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "P02", level: "monitor with baseline ledger", message: "Set up a Sidekick that runs every morning at 8am Pacific and monitors pages for new matching headings. Sources live in memory table 'sources' (company text, url text); during setup insert two: Cloudflare https://developers.cloudflare.com/dynamic-workers/ and Cloudflare Docs https://developers.cloudflare.com/workers/. Each run fetches every source, extracts headings containing the word 'Worker', inserts each into a ledger table keyed by company plus heading plus url, and reports only the net-new ones. The first successful run is a baseline that records everything and reports nothing. Put the fetch, extract and ledger insert in a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_web") && t.requiredPlugins.includes("rally_tables")) && tested(w) && singlePurpose(sk), notes: `tools=${toolsOf(sk).map((t) => `${t.name}[${t.requiredPlugins.join("+")}](${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} flags=${flagged(sk).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /baseline|no new|nothing new|0 new|net-new/i.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "P03", level: "delta behind a cursor", message: "Set up a Sidekick that every morning at 9:30am Eastern posts the delta of notes added to memory table 'notes' (columns note_id integer, title text, created_at text ISO) since the cursor stored in table 'notes_cursor', and advances the cursor only after the report is produced. During setup create both tables and insert 5 notes. Put the deterministic parts in saved tools.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).length >= 2 && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables")) && tested(w) && singlePurpose(sk), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} flags=${flagged(sk).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b[0-5]\b|five|no new/i.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "P04", level: "weekly call prep", message: "Set up a Sidekick for Tuesday call prep: every Tuesday at 1pm Pacific it records the week's key (that Tuesday's date) in memory table 'weekly_calls', and at 2pm it reports which of Alex, Katherine and Adam have an entry for that week key in table 'call_responses' (person text, week_key text, items text) and who is missing. A manual run does the 2pm report for the current week. Put the deterministic parts in saved tools. Create both tables during setup.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).length >= 1 && tested(w) && (sk.definition?.triggers ?? []).filter((t) => t.type === "calendar").length >= 1 && singlePurpose(sk), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} flags=${flagged(sk).join(",")} triggers=${(sk.definition?.triggers ?? []).length}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /Alex|Katherine|Adam/.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "P05", level: "daily signup report", message: "Set up a Sidekick that every day at 3pm Pacific reports, for the previous Pacific calendar day: web signups, desktop signups, and the top attribution source, from memory table 'signups' (signed_up_at text ISO, platform text web or desktop, source text). During setup create the table and insert 10 rows across yesterday with both platforms and three sources. Put the counting in a saved tool that takes the day as input; the instructions decide the wording. Report in the run's own conversation; do not post to another conversation.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables") && Object.keys(t.inputSchema.properties ?? {}).length >= 1) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /web/i.test(r.finalText) && /desktop/i.test(r.finalText) && /\b\d+\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "P06", level: "connector firehose", message: "Set up a Sidekick that posts a natural Slack alert to #eng whenever a pull request is opened or merged in our GitHub repositories, keeping a ledger of seen PR events so nothing is alerted twice, with the ledger logic in a saved tool.",
    gradeWizard: (w, sk) => ({ pass: toolsOf(sk).every((t) => !t.requiredPlugins.some((p) => p.startsWith("plugin_"))) && /github|slack|not (connected|available|configured)|unavailable/i.test(w.finalText), notes: `lifecycle=${sk.lifecycle} tools=${toolsOf(sk).map((t) => `${t.name}[${t.requiredPlugins.join("+")}]`).join(",")} text=${w.finalText.slice(0, 160)}` }), run: false },
  { id: "P07", level: "weekly metrics", message: "Set up a Sidekick that every Monday at 5pm Pacific computes weekly metrics from memory table 'orgs' (org_id text, created_at text ISO, last_seen_at text ISO): organizations created in the last 7 days, organizations active in the last 7 days, and the week-over-week change in both. During setup create the table and insert 12 rows spread over the last three weeks. Put the computation in a saved tool that takes the week end as input.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables") && Object.keys(t.inputSchema.properties ?? {}).length >= 1) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /week/i.test(r.finalText) && /\b\d+\b/.test(r.finalText), notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "P08", level: "instruction-only skill", message: "Save a reusable NDA review skill with no triggers: review an NDA the user provides and return exactly one decision, APPROVED STANDARD, APPROVED WITH NOTES, or LEGAL REVIEW REQUIRED, checking mutuality, term, definition breadth, non-solicit and non-compete clauses, and governing law. Internal triage only, not legal advice.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && (sk.definition?.triggers ?? []).length === 0 && toolsOf(sk).length === 0, notes: `triggers=${(sk.definition?.triggers ?? []).length} tools=${toolsOf(sk).length}` }), run: false },
  { id: "P09", level: "manual judgement", message: "Set up an on-demand Sidekick that evaluates a customer-conversation transcript I paste for product fit, rating eight criteria Low, Medium or High with evidence, and refusing to infer a transcript when none is supplied.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).length === 0, notes: `tools=${toolsOf(sk).length} triggers=${(sk.definition?.triggers ?? []).map((t) => t.type).join(",")}` }), run: false },
  { id: "P10", level: "hourly dashboard", message: "Set up a Sidekick that every weekday hour from 8am to 6pm Pacific summarizes open pull requests from memory table 'open_prs' (number integer, title text, author text, updated_at text ISO, is_draft integer), grouped by author with each author's PRs sorted most recently updated first, and reports the groups. During setup create the table and insert 6 PRs from three authors. Put the grouping and sorting in a saved tool. Report in the run's own conversation; do not post to another conversation.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables")) && tested(w) && (sk.definition?.triggers ?? []).some((t) => t.type === "calendar"), notes: `tools=${toolsOf(sk).map((t) => t.name).join(",")} triggers=${(sk.definition?.triggers ?? []).map((t) => t.type).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b\d+\b/.test(r.finalText) && r.finalText.length > 60, notes: `text=${r.finalText.slice(0, 160)}` }) },
  { id: "P11", level: "polling window", message: "Set up a Sidekick that starts at 9am Pacific daily and polls every 10 minutes until noon: if memory table 'call_notes' (note_date text, body text) has a note for today's Pacific date that is not yet in table 'processed_calls', post the note's action items once and record it; outside 9am to noon it ends with one short line and no other work. Put the deterministic parts in saved tools. Create both tables during setup, empty.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_tables")) && tested(w) && singlePurpose(sk) && !toolsOf(sk).some((t) => /window|9am|noon/i.test(t.description) && /processed/i.test(t.description)), notes: `tools=${toolsOf(sk).map((t) => `${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(",")})`).join(",")} flags=${flagged(sk).join(",")} triggers=${(sk.definition?.triggers ?? []).map((t) => t.type).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: r.status === "completed" && r.finalText.length > 5, notes: `custom=${customCalls(r).map((t) => t.status).join(",")} text=${r.finalText.slice(0, 120)}` }) },
  { id: "P12", level: "research dedup", message: "Set up a Sidekick that every weekday at 9am Pacific searches the web for three fixed queries ('AI agent harness design', 'LLM tool calling sandbox', 'agent runtime idempotency receipts'), skips any result URL already in memory table 'research_findings' (url text, title text, found_at text ISO), inserts the new ones, and reports only the new findings. Put the search, dedup and insert in a saved tool.",
    gradeWizard: (w, sk) => ({ pass: active(sk) && toolsOf(sk).some((t) => t.requiredPlugins.includes("rally_web") && t.requiredPlugins.includes("rally_tables")) && tested(w), notes: `tools=${toolsOf(sk).map((t) => `${t.name}[${t.requiredPlugins.join("+")}]`).join(",")}` }), run: true,
    gradeRun: (r) => ({ pass: ranCustom(r) && /\b\d+\b|new/i.test(r.finalText), notes: `custom=${customCalls(r).map((t) => t.status).join(",")} loads=${called(r, "load_plugin").length} text=${r.finalText.slice(0, 160)}` }) },
];
const only = args.only ? new Set(args.only.split(",")) : null;
const models = (args.models ?? "sol,terra").split(",");
const timeoutMs = Number(args.timeout ?? 420) * 1000;
const concurrency = Number(args.concurrency ?? 3);
const results = [];
const jobs = [];
if (args.suite === "code" || args.suite === "all" || !args.suite) {
  for (const scenario of CODE) if (!only || only.has(scenario.id)) for (const model of models) jobs.push(async () => {
    const started = Date.now();
    try {
      const s = await runWorkstream(scenario.message, MODELS[model], timeoutMs);
      const g = scenario.grade(s);
      results.push({ suite: "code", id: scenario.id, level: scenario.level, model, pass: g.pass, notes: g.notes, status: s.status, seconds: Math.round((Date.now() - started) / 1000), workstreamId: s.id, finalText: s.finalText.slice(0, 600), tools: s.tools });
    } catch (error) {
      results.push({ suite: "code", id: scenario.id, level: scenario.level, model, pass: false, notes: `error ${error.message}`, seconds: Math.round((Date.now() - started) / 1000) });
    }
  });
}
if (args.suite === "wizard" || args.suite === "all" || args.suite === "final" || args.suite === "prod") {
  for (const scenario of (args.suite === "final" ? FINAL : args.suite === "prod" ? PROD : WIZARD)) if (!only || only.has(scenario.id)) jobs.push(async () => {
    const started = Date.now();
    try {
      const created = await request("/sidekicks", { method: "POST", headers });
      if (created.response.status !== 201) throw new Error(`create sidekick ${created.response.status}`);
      const sidekickId = created.body.automationId;
      let w = await sendToWizard(sidekickId, scenario.message, timeoutMs);
      if (scenario.followUp) {
        const sk0 = await readSidekick(sidekickId);
        const w2 = await sendToWizard(sidekickId, scenario.followUp, timeoutMs);
        w = { ...w2, tools: [...w.tools, ...w2.tools], before: sk0 };
      }
      const sk = await readSidekick(sidekickId);
      const g0 = scenario.gradeWizard(w, sk);
      const g = args.suite === "prod" ? { pass: g0.pass && shaped(sk), notes: `${g0.notes} | ${shapeNotes(sk)}` } : g0;
      const record = { suite: "wizard", id: scenario.id, level: scenario.level, model: "sol", pass: g.pass, notes: g.notes, status: w.status, seconds: Math.round((Date.now() - started) / 1000), sidekickId, finalText: w.finalText.slice(0, 600), tools: w.tools.map((t) => ({ name: t.name, status: t.status, error: t.error })), customTools: sk.definition?.customTools ?? null, instructions: sk.definition?.instructions ?? null };
      results.push(record);
      if (scenario.run && g.pass) {
        const r = await runSidekick(sidekickId, timeoutMs);
        const gr = scenario.gradeRun(r);
        results.push({ suite: "run", id: `${scenario.id}-run`, level: scenario.level, model: r.model ?? "primary", pass: gr.pass, notes: gr.notes, toolCalls: r.tools.length, status: r.status, seconds: Math.round((Date.now() - started) / 1000), sidekickId, runId: r.runId, finalText: r.finalText.slice(0, 600), tools: r.tools });
      }
    } catch (error) {
      results.push({ suite: "wizard", id: scenario.id, level: scenario.level, model: "sol", pass: false, notes: `error ${error.message}`, seconds: Math.round((Date.now() - started) / 1000) });
    }
  });
}
if (args.suite === "rerun" && args.sidekicks) {
  for (const sidekickId of args.sidekicks.split(",")) jobs.push(async () => {
    const started = Date.now();
    const scenario = WIZARD.find((w) => w.id === (args.scenario ?? "WE1"));
    const r = await runSidekick(sidekickId, timeoutMs);
    const gr = scenario.gradeRun(r);
    results.push({ suite: "run", id: `${scenario.id}-run`, level: scenario.level, model: r.model ?? "primary", pass: gr.pass, notes: gr.notes, toolCalls: r.tools.length, status: r.status, seconds: Math.round((Date.now() - started) / 1000), sidekickId, runId: r.runId, finalText: r.finalText.slice(0, 600), tools: r.tools });
  });
}
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (next < jobs.length) { const job = jobs[next++]; await job(); }
}));
results.sort((a, b) => a.id.localeCompare(b.id) || a.model.localeCompare(b.model));
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.suite}/${r.id} [${r.level}] ${r.model} ${r.seconds}s status=${r.status}${r.toolCalls === undefined ? "" : ` toolCalls=${r.toolCalls}`} ${r.notes}`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 1));
