/** Keep a canvas in the same native destination until it is unpinned. */
export function allocatePinSlots(previous: readonly (string | null)[], pins: readonly string[], capacity: number): (string | null)[] {
  const slots = Array.from({ length: capacity }, (_, index) => {
    const id = previous[index];
    return id && pins.includes(id) ? id : null;
  });
  const additions = pins.filter((id) => !slots.includes(id));
  return slots.map((id) => id ?? additions.shift() ?? null);
}
