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

/** Fixed-locale, case-insensitive alphabetical order for titled navigation rows. */
export function compareAlphabeticalTitle(
  left: TitledNavigationRow,
  right: TitledNavigationRow,
): number {
  return alphabeticalCollator.compare(left.title, right.title)
    || alphabeticalTieBreakCollator.compare(left.title, right.title)
    || (stableNavigationKey(left) < stableNavigationKey(right) ? -1
      : stableNavigationKey(left) > stableNavigationKey(right) ? 1 : 0);
}
