PRAGMA foreign_keys = ON;

-- Demo preparation was removed on 2026-11-08, on the owner's instruction to
-- "remove the demo functionality completely" (docs/architecture.md, the
-- 2026-11-08 entry). Its three tables have no reader or writer left. Keeping
-- them as empty shells would let a stale query succeed against nothing
-- instead of failing, the reason 0090 dropped the legacy product tables.
--
-- This is a Worker-first migration: its name is in the deploy job's
-- Worker-first list, so the job promotes the Worker that no longer reads these
-- tables before it applies the drop. Applied first, it would break the
-- previous Worker, which reads `demo_operations` on every regional discovery.
-- The job refuses to run it alongside any other pending migration.
--
-- Children first. `demo_seed_receipts` and `demo_operation_phases` reference
-- `demo_operations` with ON DELETE CASCADE; nothing references either of them,
-- and no other table references `demo_operations`, so no DROP here cascades
-- into, nulls or is refused by a table that stays. Their indexes go with them.
-- The persona `users` rows a demo minted (`@persona.invalid`) are not touched:
-- they cannot sign in, and the retired demos' history references them.
DROP TABLE demo_seed_receipts;
DROP TABLE demo_operation_phases;
DROP TABLE demo_operations;
