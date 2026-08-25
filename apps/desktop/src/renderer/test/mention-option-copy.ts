export function mentionOptionCopy(option: HTMLElement): {
  badge: string | null;
  description: string | null;
  label: string | null;
} {
  return {
    badge: option.querySelector('.badge')?.textContent ?? null,
    description: option.querySelector('small')?.textContent ?? null,
    label: option.querySelector('strong')?.textContent ?? null,
  };
}
