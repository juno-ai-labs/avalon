/** The illustrative Canvas on the page about everything else (`/developer-mode/`). No live product data or actions. */
type ExampleId = "gtm" | "requests" | "podcast";
type Example = {
  artifact: string;
  kind: string;
  prompt: string;
  reply: string;
  followup: string;
  receipt: string;
};
const examples: Record<ExampleId, Example> = {
  gtm: {
    artifact: "Q4 pipeline",
    kind: "Dashboard",
    prompt:
      "Pull the deal emails from Maya’s, Theo’s and Priya’s Gmail into one pipeline dashboard.",
    reply:
      "Done, from your inbox. To add Theo’s and Priya’s, each of them needs to let the Sidekick act as them.",
    followup: "Allowed. Send a push notification when a new deal opens.",
    receipt:
      "Example run: Northwind emailed Priya → new deal, push notification sent, version 2.",
  },
  requests: {
    artifact: "Feature requests",
    kind: "Micro-app",
    prompt:
      "Read our Granola user interviews and build a feature request page the team can vote on.",
    reply:
      "Here’s a board from six interviews, with a quote for each request. Votes are open to the whole team. Shall I add new interviews as they land?",
    followup: "Please do. Keep the quotes, they help us argue less.",
    receipt:
      "Example run: new Granola interview → one new request, one more mention, version 2.",
  },
  podcast: {
    artifact: "The Friday Brief",
    kind: "Podcast feed",
    prompt:
      "Every Friday, turn what we shipped in GitHub and said in #launch into a short episode for the team.",
    reply:
      "Episode 12 is in the feed. Add it to any podcast app. The next one goes out Friday at 4pm.",
    followup: "Love it. Add a customer quote to each episode, too.",
    receipt: "Example run: Friday schedule → episode 13 added to the feed.",
  },
};
const panel = document.querySelector<HTMLElement>("#example-panel");
const tabs = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-example]"),
];
const views = [
  ...(panel?.querySelectorAll<HTMLElement>("[data-view]") ?? []),
];
// Values a Sidekick run changes: version 1 is the markup, version 2 is `data-v2`.
const changing = [
  ...(panel?.querySelectorAll<HTMLElement>("[data-v2]") ?? []),
].map((element) => ({
  element,
  v1: element.textContent ?? "",
  v2: element.dataset.v2 ?? "",
}));
const run = document.querySelector<HTMLButtonElement>(".run-sidekick");
let selected: ExampleId = "gtm";

function setText(field: string, value: string): void {
  panel
    ?.querySelectorAll<HTMLElement>(`[data-demo="${field}"]`)
    .forEach((element) => {
      element.textContent = value;
    });
}
function setVersion(version: 1 | 2): void {
  panel?.setAttribute("data-version", String(version));
  for (const { element, v1, v2 } of changing)
    element.textContent = version === 2 ? v2 : v1;
}
function selectExample(id: ExampleId): void {
  selected = id;
  const example = examples[id];
  for (const key of [
    "artifact",
    "kind",
    "prompt",
    "reply",
    "followup",
  ] as const) {
    setText(key, example[key]);
  }
  views.forEach((view) => {
    view.hidden = view.dataset.view !== id;
  });
  setVersion(1);
  setText("receipt", "An illustrative Canvas. Try running its Sidekick.");
  panel?.setAttribute("aria-labelledby", `tab-${id}`);
  tabs.forEach((tab) => {
    const active = tab.dataset.example === id;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  if (run) {
    run.disabled = false;
    run.textContent = "✳ Run the Sidekick →";
  }
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () =>
    selectExample(tab.dataset.example as ExampleId),
  );
  tab.addEventListener("keydown", (event) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    if (target) {
      selectExample(target.dataset.example as ExampleId);
      target.focus();
    }
  });
});
run?.addEventListener("click", () => {
  setVersion(2);
  setText("receipt", examples[selected].receipt);
  run.disabled = true;
  run.textContent = "✓ Canvas updated";
});
document
  .querySelectorAll<HTMLAnchorElement>("[data-pick-example]")
  .forEach((link) => {
    link.addEventListener("click", () =>
      selectExample(link.dataset.pickExample as ExampleId),
    );
  });
export {};
