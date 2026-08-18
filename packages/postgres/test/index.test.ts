import { describe, expect, it } from "vitest";

import { assertTransactionPoolerUrl, uuidV7, uuidV7From } from "../src/index";

describe("Postgres runtime primitives", () => {
  it("creates lexically sortable UUIDv7 identifiers", () => {
    const earlier = uuidV7(1_700_000_000_000);
    const later = uuidV7(1_700_000_000_001);
    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(earlier < later).toBe(true);
  });

  it("matches the SQL UUIDv7 byte contract and rejects invalid inputs", () => {
    const random = Uint8Array.from([
      0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0xab, 0x88,
      0xff, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00,
    ]);
    expect(uuidV7From(0x0102_0304_0506, random))
      .toBe("01020304-0506-7b88-bf66-554433221100");
    expect(() => uuidV7From(-1, random)).toThrow("uuid_v7_timestamp_out_of_range");
    expect(() => uuidV7From(0x1_0000_0000_0000, random)).toThrow("uuid_v7_timestamp_out_of_range");
    expect(() => uuidV7From(1, new Uint8Array(15))).toThrow("uuid_v7_random_bytes_invalid");
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
