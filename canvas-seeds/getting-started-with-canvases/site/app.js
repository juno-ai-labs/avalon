// The page's behaviour. The steps' words live in index.html, so changing what
// a step says is an HTML edit; this file only fills in what the server knows:
// who is looking, which steps are done, and what is on the wall.

const POLL_MS = 4000;

const steps = [...document.querySelectorAll("[data-step]")];
const guide = document.querySelector("[data-guide]");
const cardList = document.querySelector("[data-cards]");
const cardTemplate = document.querySelector("[data-card-template]");
const status = document.querySelector("[data-status]");

let lastState = "";
/** The step the person has open. `undefined` until the first state arrives. */
let openStep;
/** The steps that were done at the last render, to notice one getting done. */
let doneBefore = new Set();
/** Whether the person asked to see the steps again after finishing. */
let showFinishedSteps = false;
let stopped = false;
let timer = null;
let failures = 0;

// ---------------------------------------------------------------- requests

async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) {
    signedOut();
    throw new Error("signed out");
  }
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json();
}

/** Sends a change and draws the state the server answers with. */
async function send(path, body) {
  try {
    render(await call(path, body ?? {}));
    say("");
  } catch {
    if (!stopped) say("That did not save. Try again.");
  }
}

function say(message) {
  status.textContent = message;
  status.hidden = message === "";
}

/** The viewer's Rally session ended: stop asking, and offer the way back in. */
function signedOut() {
  stopped = true;
  clearTimeout(timer);
  status.replaceChildren("You are signed out. ");
  const link = document.createElement("a");
  link.href = "/__rally/sign-in?return=" + encodeURIComponent(location.pathname + location.search);
  link.textContent = "Sign in to Rally";
  status.append(link);
  status.hidden = false;
}

// ----------------------------------------------------------------- polling

async function refresh() {
  try {
    render(await call("api/state"));
    failures = 0;
  } catch {
    failures += 1;
  }
}

function schedule() {
  clearTimeout(timer);
  if (stopped || document.hidden) return;
  // A failed request waits longer, never shorter, and not in step with others.
  const wait = failures === 0 ? POLL_MS : POLL_MS * Math.min(2 ** failures, 8) * (1 + Math.random());
  timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, wait);
}

document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    clearTimeout(timer);
    return;
  }
  await refresh();
  schedule();
});

// --------------------------------------------------------------- rendering

function render(state) {
  const serialized = JSON.stringify(state);
  if (serialized === lastState) return;
  lastState = serialized;

  const firstName = state.viewer.name.split(" ")[0];
  document.querySelector("[data-greeting]").textContent = `Hi ${firstName}.`;

  renderSteps(state.steps);
  renderCards(state.cards);
}

function renderSteps(states) {
  const byId = new Map(states.map((step) => [step.id, step]));
  const doneCount = states.filter((step) => step.done).length;
  const firstUndone = states.find((step) => !step.done)?.id ?? null;

  // Open the first step still to do. When the open step gets done, move on.
  const doneNow = new Set(states.filter((step) => step.done).map((step) => step.id));
  if (openStep === undefined) openStep = firstUndone;
  else if (openStep !== null && doneNow.has(openStep) && !doneBefore.has(openStep)) openStep = firstUndone;
  doneBefore = doneNow;

  for (const element of steps) {
    const step = byId.get(element.dataset.step);
    element.classList.toggle("done", step.done);
    const where = element.querySelector(".step-where");
    where.dataset.label ??= where.textContent;
    where.textContent = step.done && step.team && step.by && step.by !== "you" ? `Done by ${step.by}` : where.dataset.label;
    for (const part of element.querySelectorAll("[data-part]")) {
      part.classList.toggle("done", Boolean(step.parts?.[part.dataset.part]));
    }
    const tick = element.querySelector("[data-tick]");
    if (tick) tick.hidden = step.done;
    setOpen(element, element.dataset.step === openStep);
  }

  document.querySelector("[data-progress-count]").textContent = `${doneCount} of ${states.length} done`;
  document.querySelector("[data-progress-fill]").style.width = `${(doneCount / states.length) * 100}%`;

  const finished = doneCount === states.length;
  guide.classList.toggle("finished", finished && !showFinishedSteps);
  document.querySelector("[data-finished-note]").hidden = !finished || showFinishedSteps;
}

function setOpen(element, open) {
  element.classList.toggle("open", open);
  element.querySelector(".step-head").setAttribute("aria-expanded", String(open));
  element.querySelector(".step-body").hidden = !open;
}

/** Updates the wall card by card, so a poll never rebuilds what did not change. */
function renderCards(cards) {
  const existing = new Map([...cardList.children].map((node) => [node.dataset.id, node]));
  let previous = null;
  for (const card of cards) {
    const id = String(card.id);
    let node = existing.get(id);
    if (node) existing.delete(id);
    else {
      node = cardTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = id;
    }
    node.querySelector(".card-text").textContent = card.text;
    node.querySelector(".card-by").textContent = card.kind === "starter" ? "Example" : card.by;
    node.classList.toggle("from-rally", card.kind === "rally");
    node.querySelector("[data-remove]").hidden = !card.mine;
    const vote = node.querySelector("[data-vote]");
    vote.setAttribute("aria-pressed", String(card.voted));
    vote.querySelector(".vote-count").textContent = String(card.votes);
    const wanted = previous ? previous.nextElementSibling : cardList.firstElementChild;
    if (wanted !== node) cardList.insertBefore(node, wanted);
    previous = node;
  }
  for (const node of existing.values()) node.remove();
}

// ------------------------------------------------------------------- steps

for (const element of steps) {
  element.querySelector(".step-head").addEventListener("click", () => {
    openStep = element.classList.contains("open") ? null : element.dataset.step;
    for (const other of steps) setOpen(other, other.dataset.step === openStep);
  });
  element.querySelector("[data-tick]")?.addEventListener("click", () => {
    send("api/steps", { step: element.dataset.step });
  });
}

document.querySelector("[data-show-steps]").addEventListener("click", () => {
  showFinishedSteps = true;
  guide.classList.remove("finished");
  document.querySelector("[data-finished-note]").hidden = true;
});

// ----------------------------------------------------------------- prompts

/**
 * A prompt's words with the person's answers filled in. `{key|fallback}` in
 * the template takes the input named `key`, or the bracketed fallback while
 * that input is empty.
 */
function promptText(prompt) {
  return prompt.dataset.prompt.replace(/\{(\w+)\|([^}]+)\}/g, (_, key, fallback) => {
    const value = prompt.querySelector(`[data-fill="${key}"]`)?.value.trim();
    return value || `[${fallback}]`;
  });
}

for (const prompt of document.querySelectorAll("[data-prompt]")) {
  const text = prompt.querySelector("[data-prompt-text]");
  const update = () => {
    text.textContent = promptText(prompt);
  };
  prompt.addEventListener("input", update);
  update();
  const button = prompt.querySelector("[data-copy]");
  button.addEventListener("click", () => copy(promptText(prompt), button, text));
}

for (const button of document.querySelectorAll("[data-copy-starter]")) {
  const text = button.parentElement.querySelector("[data-starter]");
  button.addEventListener("click", async () => {
    await copy(text.textContent, button, text);
    send("api/steps", { step: "own_canvas" });
  });
}

/**
 * Copies `text` and says so on the button. A framed page is not always allowed
 * the clipboard API, so this falls back to the older command, and failing that
 * selects the words so the person can copy them by hand.
 */
async function copy(text, button, source) {
  let copied;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "visually-hidden";
    document.body.append(area);
    area.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
  }
  if (!copied) {
    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  button.dataset.label ??= button.textContent;
  button.textContent = copied ? "Copied" : "Selected. Copy it by hand";
  clearTimeout(button.resetTimer);
  button.resetTimer = setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 2000);
}

// -------------------------------------------------------------------- wall

document.querySelector("[data-add-card]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  const text = input.value.trim();
  if (text === "") return;
  input.value = "";
  await send("api/cards", { text });
});

cardList.addEventListener("click", (event) => {
  const card = event.target.closest(".card");
  if (!card) return;
  if (event.target.closest("[data-vote]")) send(`api/cards/${card.dataset.id}/vote`);
  else if (event.target.closest("[data-remove]")) send(`api/cards/${card.dataset.id}/remove`);
});

await refresh();
schedule();
