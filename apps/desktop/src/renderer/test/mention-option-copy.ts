export function mentionOptionCopy(option: HTMLElement): {
  description: string | null;
  label: string | null;
} {
  return {
    description: option.querySelector('small')?.textContent ?? null,
    label: option.querySelector('strong')?.textContent ?? null,
  };
}
