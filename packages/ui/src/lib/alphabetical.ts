const alphabeticalCollator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  usage: 'sort',
});

/** Case-insensitive alphabetical order for titled navigation rows. */
export function compareAlphabeticalTitle(
  left: Readonly<{ title: string }>,
  right: Readonly<{ title: string }>,
): number {
  return alphabeticalCollator.compare(left.title, right.title);
}
