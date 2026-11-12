/** The homepage's illustrative Canvas. No live product data or actions. */
type ExampleId = "launch" | "meeting" | "weekly";
type Task = { title: string; owner: string; done: boolean };
type Example = {
  name: string;
  artifact: string;
  prompt: string;
  reply: string;
  followup: string;
  kicker: string;
  description: string;
  heading: string;
  note: string;
  tasks: Task[];
  completedTasks: Task[];
  receipt: string;
};
const examples: Record<ExampleId, Example> = {
  launch: {
    name: "The next big thing",
    artifact: "Launch plan",
    prompt:
      "Let’s turn our launch notes into a plan the whole team can work from.",
    reply:
      "On it. I’ve pulled the milestones together and made a launch plan. Want me to keep an eye on the moving parts?",
    followup: "Yes please. Keep it up to date when our Linear issues change.",
    kicker: "ALL HANDS ON DECK",
    description: "One little plan for our next big thing.",
    heading: "The path to launch",
    note: "A Sidekick can follow the Linear issues and publish a new version when things change.",
    tasks: [
      {
        title: "Find our first five design partners",
        owner: "Maya",
        done: true,
      },
      { title: "Polish the onboarding flow", owner: "Theo", done: true },
      { title: "Ship the new homepage", owner: "Maya", done: false },
      { title: "Send a little hello to the world", owner: "Theo", done: false },
    ],
    completedTasks: [
      {
        title: "Find our first five design partners",
        owner: "Maya",
        done: true,
      },
      { title: "Polish the onboarding flow", owner: "Theo", done: true },
      { title: "Ship the new homepage", owner: "Maya", done: true },
      { title: "Send a little hello to the world", owner: "Theo", done: false },
    ],
    receipt:
      "Example run: Linear issue completed → launch plan updated to version 2.",
  },
  meeting: {
    name: "Good conversations, next steps",
    artifact: "Meeting follow-ups",
    prompt: "Can you pull the next steps out of our team meeting notes?",
    reply:
      "Here’s what everyone committed to, with a person for each next step. I can do this after the next meeting, too.",
    followup: "Perfect. Run this whenever a new Granola note lands.",
    kicker: "FROM TALKING TO DOING",
    description: "Good ideas deserve a next step.",
    heading: "What we promised",
    note: "A Sidekick can react to a new Granola note and publish the follow-ups here.",
    tasks: [
      { title: "Share the revised customer brief", owner: "Maya", done: true },
      { title: "Sketch the new onboarding flow", owner: "Theo", done: false },
      { title: "Set up the design partner calls", owner: "Maya", done: false },
    ],
    completedTasks: [
      { title: "Share the revised customer brief", owner: "Maya", done: true },
      { title: "Sketch the new onboarding flow", owner: "Theo", done: false },
      { title: "Set up the design partner calls", owner: "Maya", done: false },
      {
        title: "Bring a prototype to the next check-in",
        owner: "Theo",
        done: false,
      },
    ],
    receipt:
      "Example run: new Granola note → one new follow-up added in version 2.",
  },
  weekly: {
    name: "A week worth sharing",
    artifact: "The weekly update",
    prompt: "Make a weekly update from what we shipped in GitHub.",
    reply:
      "Here’s the week in one place, with the shipped work pulled together. Shall I make this a Friday ritual?",
    followup: "Yes! Every Friday at 4pm. Keep the update in this Canvas.",
    kicker: "SMALL WINS, ALL TOGETHER",
    description: "A little record of a week well spent.",
    heading: "Fresh out of the workshop",
    note: "A Friday Sidekick can read the latest GitHub activity and publish the week’s update.",
    tasks: [
      {
        title: "A warmer welcome for new teammates",
        owner: "Maya",
        done: true,
      },
      { title: "A faster way to find your work", owner: "Theo", done: true },
      { title: "The little fixes that add up", owner: "Theo", done: true },
    ],
    completedTasks: [
      {
        title: "A warmer welcome for new teammates",
        owner: "Maya",
        done: true,
      },
      { title: "A faster way to find your work", owner: "Theo", done: true },
      { title: "The little fixes that add up", owner: "Theo", done: true },
      { title: "A new homepage, out in the world", owner: "Maya", done: true },
    ],
    receipt:
      "Example run: Friday schedule → latest GitHub work added in version 2.",
  },
};
const panel = document.querySelector<HTMLElement>("#example-panel");
const tabs = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-example]"),
];
const run = document.querySelector<HTMLButtonElement>(".run-sidekick");
let selected: ExampleId = "launch";

function setText(field: string, value: string): void {
  panel
    ?.querySelectorAll<HTMLElement>(`[data-demo="${field}"]`)
    .forEach((element) => {
      element.textContent = value;
    });
}
function renderTasks(tasks: Task[]): void {
  const list = panel?.querySelector('[data-demo="tasks"]');
  if (!list) return;
  list.replaceChildren(
    ...tasks.map((task) => {
      const row = document.createElement("li");
      const check = document.createElement("span");
      check.className = `task-check${task.done ? " done" : ""}`;
      check.textContent = task.done ? "✓" : "";
      check.setAttribute("aria-label", task.done ? "Completed" : "To do");
      const title = document.createElement("span");
      title.textContent = task.title;
      const owner = document.createElement("span");
      owner.className = `task-owner${task.owner === "Theo" ? " lilac" : ""}`;
      owner.textContent = task.owner;
      row.append(check, title, owner);
      return row;
    }),
  );
}
function selectExample(id: ExampleId): void {
  selected = id;
  const example = examples[id];
  for (const key of [
    "name",
    "artifact",
    "prompt",
    "reply",
    "followup",
    "kicker",
    "description",
    "heading",
    "note",
  ] as const) {
    setText(key, example[key]);
  }
  setText("version", "Version 1");
  setText("status", id === "weekly" ? "This week" : "In motion");
  setText("receipt", "An illustrative Canvas. Try running its Sidekick.");
  renderTasks(example.tasks);
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
  const example = examples[selected];
  renderTasks(example.completedTasks);
  setText("version", "Version 2");
  setText("status", "Just updated");
  setText("receipt", example.receipt);
  setText(
    "note",
    "A new version, in the same Canvas. Your team can pick up right here.",
  );
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
