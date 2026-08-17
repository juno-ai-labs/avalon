import { describe, expect, it } from "vitest";

import { assertTransactionPoolerUrl, uuidV7 } from "../src/index";

describe("Postgres runtime primitives", () => {
  it("creates lexically sortable UUIDv7 identifiers", () => {
    const earlier = uuidV7(1_700_000_000_000);
    const later = uuidV7(1_700_000_000_001);
    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(earlier < later).toBe(true);
  });

  it("requires the Supavisor transaction port outside local development", () => {
    expect(assertTransactionPoolerUrl("postgresql://runner:secret@pooler.example.com:6543/postgres").port)
      .toBe("6543");
    expect(() => assertTransactionPoolerUrl("postgresql://runner:secret@pooler.example.com:5432/postgres"))
      .toThrow("postgres_connection_string_must_use_transaction_pooler");
  });

  it("allows the local direct port for migration and integration tests", () => {
    expect(assertTransactionPoolerUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres").hostname)
      .toBe("127.0.0.1");
  });
});
