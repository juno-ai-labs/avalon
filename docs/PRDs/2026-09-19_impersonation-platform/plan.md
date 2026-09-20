# Implementation plan

- [x] Directed relationship storage and canonical demo/original-cast authorization, proved against migrated SQLite.
- [x] HTTP catalog and represented message admission with real-workerd integration tests, audit, and demo provisioning.
- [x] Shared card presentation and state-machine tests for immutable attempts and retries.
- [x] Session-bound Electron window, eligible menu entry, navigation/sign-out lifecycle, and IPC tests.
- [x] Real-window visual verification, regression gates, and final documentation.

Each behavior starts with a failing test. Integration assertions also undergo a production-code mutation check. Commits group passing behavior semantically.

## Verification

- `pnpm lint` and `pnpm typecheck` passed.
- Migrated SQLite authority/register suites: 10 tests passed.
- Real-workerd HTTP sidecar, preparation, and retirement suites: 17 tests passed.
- Desktop card, window lifecycle, IPC contract, shared presentation, host adapter,
  and account-menu suites: 33 tests passed.
- `electron-vite build` passed with both renderer/preload entries.
- Real Electron inspection covered the menu, loading, populated draft, sending,
  sent, failed, unknown outcome, denied, offline, and dark/empty states using
  catalog/direct-response fixtures. This does not claim a live-provider test.
- Removing relationship revocation and operator-session revalidation separately
  made their integration assertions fail; both guards were restored and passed.
  New retirement, audit, catalog-label, card, and lifecycle behavior began with
  failing assertions before implementation.
