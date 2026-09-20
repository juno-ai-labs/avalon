# Implementation plan

- [ ] Directed relationship storage and canonical demo/original-cast authorization, proved against migrated SQLite.
- [ ] HTTP catalog and represented message admission with real-workerd integration tests, audit, and demo provisioning.
- [ ] Shared card presentation and state-machine tests for immutable attempts and retries.
- [ ] Session-bound Electron window, eligible menu entry, navigation/sign-out lifecycle, and IPC tests.
- [ ] Real-window visual verification, regression gates, and final documentation.

Each behavior starts with a failing test. Integration assertions also undergo a production-code mutation check. Commits group passing behavior semantically.
