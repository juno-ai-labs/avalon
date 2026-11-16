/** The artifact marketplace's kind filter. Every card is in the markup; this only hides some. */
const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-filter]")];
const cards = [...document.querySelectorAll<HTMLElement>(".market-card")];
const empty = document.querySelector<HTMLElement>(".market-empty");

for (const button of buttons) {
  button.addEventListener("click", () => {
    const kind = button.dataset.filter;
    for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
    let shown = 0;
    for (const card of cards) {
      card.hidden = kind !== "all" && card.dataset.kind !== kind;
      if (!card.hidden) shown += 1;
    }
    if (empty) empty.hidden = shown > 0;
  });
}
export {};
