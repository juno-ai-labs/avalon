const alphabeticalCollator = new Intl.Collator('en-US', {
  sensitivity: 'base',
  usage: 'sort',
});
const alphabeticalTieBreakCollator = new Intl.Collator('en-US', {
  sensitivity: 'variant',
  usage: 'sort',
});

type TitledNavigationRow = Readonly<
  { title: string } & ({ id: string } | { substreamId: string })
>;

function stableNavigationKey(row: TitledNavigationRow): string {
  return 'id' in row ? row.id : row.substreamId;
}

/** Fixed-locale, case-insensitive alphabetical order for two labels, ties broken by a stable key. */
export function compareAlphabetical(
  left: string,
  leftKey: string,
  right: string,
  rightKey: string,
): number {
  return alphabeticalCollator.compare(left, right)
    || alphabeticalTieBreakCollator.compare(left, right)
    || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
}

/** Fixed-locale, case-insensitive alphabetical order for titled navigation rows. */
export function compareAlphabeticalTitle(
  left: TitledNavigationRow,
  right: TitledNavigationRow,
): number {
  return compareAlphabetical(left.title, stableNavigationKey(left), right.title, stableNavigationKey(right));
}

/** The same order for named rows, such as Spaces. */
export function compareAlphabeticalName(
  left: Readonly<{ id: string; name: string }>,
  right: Readonly<{ id: string; name: string }>,
): number {
  return compareAlphabetical(left.name, left.id, right.name, right.id);
}
