import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { shouldRunAtLocalHour } from "../src/index";
import { planRetention, runRetention } from "../src/retention";
import { createTestR2Bucket } from "./helpers/cloudflare-test";

interface StoredObject {
  content: Uint8Array;
  customMetadata: Record<string, string>;
  etag: string;
  httpMetadata: R2HTTPMetadata;
  key: string;
  storageClass: "Standard" | "InfrequentAccess";
}

const prefix = "stable/darwin/arm64/";

function etag(content: Uint8Array): string {
  return createHash("md5").update(content).digest("hex");
}

function stored(
  key: string,
  content = new TextEncoder().encode(key),
  storageClass: StoredObject["storageClass"] = "Standard",
): StoredObject {
  return {
    content,
    customMetadata: { release: key },
    etag: etag(content),
    httpMetadata: {
      cacheControl: key.endsWith("-mac.yml") ? "public, max-age=0, must-revalidate" : "immutable",
      contentType: key.endsWith(".dmg") ? "application/x-apple-diskimage" : "application/octet-stream",
    },
    key,
    storageClass,
  };
}

function releaseKeys(version: string, productName = "Avalon"): string[] {
  return [
    `${prefix}${productName}-${version}-mac-arm64.dmg`,
    `${prefix}${productName}-${version}-mac-arm64.dmg.blockmap`,
    `${prefix}${productName}-${version}-mac-arm64.zip`,
    `${prefix}${productName}-${version}-mac-arm64.zip.blockmap`,
    `${prefix}${version}/SHA256SUMS`,
  ];
}

function inventory(versions: string[]): StoredObject[] {
  return [
    stored(`${prefix}Avalon.dmg`),
    stored(`${prefix}latest-mac.yml`),
    ...versions.flatMap((version) => releaseKeys(version).map((key) => stored(key))),
  ];
}

function asR2Object(object: StoredObject): R2Object {
  return {
    customMetadata: object.customMetadata,
    etag: object.etag,
    httpEtag: `"${object.etag}"`,
    httpMetadata: object.httpMetadata,
    key: object.key,
    size: object.content.byteLength,
    storageClass: object.storageClass,
    uploaded: new Date("2026-08-07T00:00:00Z"),
  } as R2Object;
}

class MockBucket {
  readonly deleteCalls: string[][] = [];
  readonly objects = new Map<string, StoredObject>();
  listHook?: (call: number, bucket: MockBucket) => void;
  private listCalls = 0;

  constructor(objects: StoredObject[] = []) {
    for (const object of objects) this.objects.set(object.key, structuredClone(object));
  }

  async list(): Promise<R2Objects> {
    this.listCalls += 1;
    this.listHook?.(this.listCalls, this);
    return {
      delimitedPrefixes: [],
      objects: [...this.objects.values()].sort((left, right) => left.key.localeCompare(right.key)).map(asR2Object),
      truncated: false,
    } as R2Objects;
  }

  async head(key: string): Promise<R2Object | null> {
    const object = this.objects.get(key);
    return object ? asR2Object(object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const content = object.content.slice();
    return {
      ...asR2Object(object),
      body: new Response(content).body,
    } as R2ObjectBody;
  }

  async put(key: string, value: ReadableStream, options: R2PutOptions): Promise<R2Object> {
    const content = new Uint8Array(await new Response(value).arrayBuffer());
    const storageClass = options.storageClass === "InfrequentAccess" ? "InfrequentAccess" : "Standard";
    const object = stored(key, content, storageClass);
    object.customMetadata = options.customMetadata ?? {};
    object.httpMetadata = options.httpMetadata instanceof Headers ? {} : options.httpMetadata ?? {};
    this.objects.set(key, object);
    return asR2Object(object);
  }

  async delete(keys: string | string[]): Promise<void> {
    const requested = Array.isArray(keys) ? [...keys] : [keys];
    this.deleteCalls.push(requested);
    for (const key of requested) this.objects.delete(key);
  }
}

function bindings(active: MockBucket, archive = new MockBucket()) {
  return {
    ACTIVE_RELEASES: createTestR2Bucket(active),
    ARCHIVED_RELEASES: createTestR2Bucket(archive),
  };
}

describe("release retention", () => {
  it("keeps the five highest semantic versions", async () => {
    const active = new MockBucket(inventory(["1.8.0", "1.9.0", "1.10.0", "1.11.0", "1.12.0", "1.13.0"]));
    const plan = await planRetention(createTestR2Bucket(active), 5);
    expect(plan.archiveVersions).toEqual(["1.8.0"]);
    expect(plan.retainedVersions).toEqual(["1.9.0", "1.10.0", "1.11.0", "1.12.0", "1.13.0"]);
  });

  it("retains an older release while the Stable channel still references it", async () => {
    const objects = inventory(["1.8.0", "1.9.0", "1.10.0", "1.11.0", "1.12.0", "1.13.0"]);
    objects.push(
      stored(`${prefix}stable-mac.yml`, new TextEncoder().encode("version: 1.8.0\n")),
      stored(`${prefix}faster-mac.yml`, new TextEncoder().encode("version: 1.13.0\n")),
      stored(`${prefix}stable-channel.json`, new TextEncoder().encode('{"version":"1.8.0"}\n')),
      stored(`${prefix}release-publication.json`, new TextEncoder().encode('{"version":"1.13.0"}\n')),
    );

    const plan = await planRetention(createTestR2Bucket(new MockBucket(objects)), 5);

    expect(plan.archiveVersions).toEqual([]);
    expect(plan.retainedVersions).toEqual(["1.8.0", "1.9.0", "1.10.0", "1.11.0", "1.12.0", "1.13.0"]);
  });

  it("fails closed during a partial channel-pointer publication", async () => {
    const objects = inventory(["1.8.0"]);
    objects.push(stored(`${prefix}faster-mac.yml`, new TextEncoder().encode("version: 1.8.0\n")));

    await expect(planRetention(createTestR2Bucket(new MockBucket(objects)), 5))
      .rejects.toThrow("Missing mutable release pointers");
  });

  it("does nothing when exactly five complete releases are active", async () => {
    const active = new MockBucket(inventory(["1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"]));
    const archive = new MockBucket();
    const report = await runRetention(bindings(active, archive), { dryRun: false, keepCount: 5 });
    expect(report.status).toBe("noop");
    expect(report.activeObjectCount).toBe(27);
    expect(active.deleteCalls).toEqual([]);
    expect(archive.objects.size).toBe(0);
  });

  it("preserves the persistent release lock while archiving old releases", async () => {
    const objects = inventory(["1.13.0", "1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"]);
    objects.push(stored(`${prefix}release-publish.lock`, new TextEncoder().encode("released:publisher")));
    const active = new MockBucket(objects);

    const report = await runRetention(bindings(active), { dryRun: false, keepCount: 5 });

    expect(report.archivedObjectCount).toBe(5);
    expect(active.objects.has(`${prefix}release-publish.lock`)).toBe(true);
  });

  it("reports the exact plan without writing in dry-run mode", async () => {
    const active = new MockBucket(inventory(["1.13.0", "1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"]));
    const archive = new MockBucket();
    const report = await runRetention(bindings(active, archive), { dryRun: true, keepCount: 5 });
    expect(report.status).toBe("dry-run");
    expect(report.archiveVersions).toEqual(["1.13.0"]);
    expect(report.candidateKeys).toHaveLength(5);
    expect(active.deleteCalls).toEqual([]);
    expect(archive.objects.size).toBe(0);
  });

  it("copies, verifies, and deletes only releases older than the newest five", async () => {
    const active = new MockBucket(inventory(["1.13.0", "1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"]));
    const archive = new MockBucket();
    const report = await runRetention(bindings(active, archive), { dryRun: false, keepCount: 5 });
    expect(report).toMatchObject({
      activeObjectCount: 27,
      archivedObjectCount: 5,
      archiveVersions: ["1.13.0"],
      copiedObjectCount: 5,
      deletedObjectCount: 5,
      retainedVersions: ["1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"],
      skippedExistingObjectCount: 0,
      status: "archived",
    });
    expect(active.deleteCalls).toEqual([releaseKeys("1.13.0").sort()]);
    for (const key of releaseKeys("1.13.0")) {
      expect(active.objects.has(key)).toBe(false);
      expect(archive.objects.get(key)?.storageClass).toBe("InfrequentAccess");
      expect(archive.objects.get(key)?.customMetadata).toEqual({ release: key });
    }
  });

  it("accepts already verified archive objects without rewriting them", async () => {
    const activeObjects = inventory(["1.13.0", "1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"]);
    const active = new MockBucket(activeObjects);
    const archived = activeObjects
      .filter((object) => releaseKeys("1.13.0").includes(object.key))
      .map((object) => ({ ...structuredClone(object), storageClass: "InfrequentAccess" as const }));
    const report = await runRetention(bindings(active, new MockBucket(archived)), {
      dryRun: false,
      keepCount: 5,
    });
    expect(report.copiedObjectCount).toBe(0);
    expect(report.skippedExistingObjectCount).toBe(5);
    expect(report.deletedObjectCount).toBe(5);
  });

  it("fails closed when a release is incomplete", async () => {
    const objects = inventory(["1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"])
      .filter((object) => object.key !== `${prefix}Avalon-1.18.0-mac-arm64.zip.blockmap`);
    const active = new MockBucket(objects);
    await expect(runRetention(bindings(active), { dryRun: false, keepCount: 5 }))
      .rejects.toThrow("Incomplete release 1.18.0");
    expect(active.deleteCalls).toEqual([]);
  });

  it("fails closed when an existing archive object does not match", async () => {
    const active = new MockBucket(inventory(["1.13.0", "1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"]));
    const mismatched = stored(releaseKeys("1.13.0")[0] ?? "", new TextEncoder().encode("different"), "InfrequentAccess");
    await expect(runRetention(bindings(active, new MockBucket([mismatched])), {
      dryRun: false,
      keepCount: 5,
    })).rejects.toThrow("Archive verification mismatch");
    expect(active.deleteCalls).toEqual([]);
  });

  it("refuses deletion if the active inventory changes after copying", async () => {
    const active = new MockBucket(inventory(["1.13.0", "1.14.0", "1.15.0", "1.16.0", "1.17.0", "1.18.0"]));
    active.listHook = (call, bucket) => {
      if (call === 2) bucket.objects.set(`${prefix}latest-mac.yml`, stored(`${prefix}latest-mac.yml`, new TextEncoder().encode("changed")));
    };
    await expect(runRetention(bindings(active), { dryRun: false, keepCount: 5 }))
      .rejects.toThrow("inventory changed during retention");
    expect(active.deleteCalls).toEqual([]);
  });
});

describe("Pacific schedule gate", () => {
  const zone = "America/Los_Angeles";

  it("runs at 02:00 in standard and daylight time", () => {
    expect(shouldRunAtLocalHour(Date.parse("2026-01-15T10:00:00Z"), zone, 2)).toBe(true);
    expect(shouldRunAtLocalHour(Date.parse("2026-07-15T09:00:00Z"), zone, 2)).toBe(true);
  });

  it("skips the other UTC trigger", () => {
    expect(shouldRunAtLocalHour(Date.parse("2026-01-15T09:00:00Z"), zone, 2)).toBe(false);
    expect(shouldRunAtLocalHour(Date.parse("2026-07-15T10:00:00Z"), zone, 2)).toBe(false);
  });

  it("runs at 03:00 only when the spring-forward gap removes 02:00", () => {
    expect(shouldRunAtLocalHour(Date.parse("2026-03-08T10:00:00Z"), zone, 2)).toBe(true);
    expect(shouldRunAtLocalHour(Date.parse("2026-03-09T10:00:00Z"), zone, 2)).toBe(false);
  });

  it("runs once at 02:00 after the fall-back transition", () => {
    expect(shouldRunAtLocalHour(Date.parse("2026-11-01T09:00:00Z"), zone, 2)).toBe(false);
    expect(shouldRunAtLocalHour(Date.parse("2026-11-01T10:00:00Z"), zone, 2)).toBe(true);
  });

  describe("the rename from Avalon", () => {
    // What the bucket actually looks like after the rename ships: releases up to
    // the rename named Avalon, releases after it named Rally, and both recovery
    // pointers present because `Avalon.dmg` is compiled into every build shipped
    // before it and can never be removed.
    function mixedInventory(avalon: string[], rally: string[]): StoredObject[] {
      return [
        stored(`${prefix}Avalon.dmg`),
        stored(`${prefix}Rally.dmg`),
        stored(`${prefix}latest-mac.yml`),
        ...avalon.flatMap((version) => releaseKeys(version).map((key) => stored(key))),
        ...rally.flatMap((version) => releaseKeys(version, "Rally").map((key) => stored(key))),
      ];
    }

    it("plans across releases named on either side of the rename", async () => {
      const active = new MockBucket(mixedInventory(
        ["1.8.0", "1.9.0", "1.10.0"],
        ["1.11.0", "1.12.0", "1.13.0"],
      ));

      const plan = await planRetention(createTestR2Bucket(active), 5);

      expect(plan.archiveVersions).toEqual(["1.8.0"]);
      expect(plan.retainedVersions).toEqual(["1.9.0", "1.10.0", "1.11.0", "1.12.0", "1.13.0"]);
      // The candidate keys carry the archived release's own product name.
      expect(plan.candidateKeys).toContain(`${prefix}Avalon-1.8.0-mac-arm64.dmg`);
    });

    it("archives a Rally release by its own name", async () => {
      const active = new MockBucket(mixedInventory([], ["1.11.0", "1.12.0"]));
      const archive = new MockBucket();

      const report = await runRetention(bindings(active, archive), { dryRun: false, keepCount: 1 });

      expect(report.archiveVersions).toEqual(["1.11.0"]);
      expect([...archive.objects.keys()]).toContain(`${prefix}Rally-1.11.0-mac-arm64.zip`);
      // Neither recovery pointer is ever a retention candidate.
      expect(report.candidateKeys).not.toContain(`${prefix}Avalon.dmg`);
      expect(report.candidateKeys).not.toContain(`${prefix}Rally.dmg`);
    });

    it("runs on a bucket that still holds only the Avalon pointer", async () => {
      // Between this shipping and the first Rally release there is no
      // `Rally.dmg`. Requiring one would break retention every night until then.
      const active = new MockBucket(inventory(["1.8.0", "1.9.0"]));

      const plan = await planRetention(createTestR2Bucket(active), 1);

      expect(plan.retainedVersions).toEqual(["1.9.0"]);
    });

    it("fails closed when a release mixes both product names", async () => {
      const active = new MockBucket([
        stored(`${prefix}Rally.dmg`),
        stored(`${prefix}latest-mac.yml`),
        ...releaseKeys("1.11.0", "Rally").slice(0, 2).map((key) => stored(key)),
        ...releaseKeys("1.11.0").slice(2).map((key) => stored(key)),
      ]);

      await expect(planRetention(createTestR2Bucket(active), 1))
        .rejects.toThrow(/mixes product names/u);
    });
  });
});
