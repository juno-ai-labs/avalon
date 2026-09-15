const RELEASE_PREFIX = "stable/darwin/arm64/";
/**
 * Every product name a release artifact in this bucket may carry, current
 * first.
 *
 * The rename from Avalon changed what a release is *named*, not what is already
 * in the bucket: `Avalon-1.146.0-mac-arm64.dmg` and `Rally-1.147.0-mac-arm64.dmg`
 * both exist, and both are complete releases. A retention pass that knows only
 * one name does not degrade — `analyzeInventory` throws `Unexpected active R2
 * key` on the first object it cannot classify, so retention stops entirely and
 * the active bucket grows without bound.
 *
 * A version's own artifacts decide its name; the two are never mixed within
 * one release.
 */
const PRODUCT_NAMES: readonly string[] = Object.freeze(["Rally", "Avalon"]);
/**
 * The recovery-installer pointer, one per product name.
 *
 * `Avalon.dmg` is never removed: `MANUAL_UPDATE_URL` is compiled into every
 * build shipped before the rename, so that key is polled forever. At least one
 * must exist — requiring a specific one would fail every night between this
 * shipping and the first Rally release.
 */
const CANONICAL_DMG_POINTERS = new Set(PRODUCT_NAMES.map((name) => `${RELEASE_PREFIX}${name}.dmg`));
const LEGACY_MANIFEST = `${RELEASE_PREFIX}latest-mac.yml`;
const CHANNEL_MANIFESTS = new Set([
  `${RELEASE_PREFIX}stable-mac.yml`,
  `${RELEASE_PREFIX}faster-mac.yml`,
]);
const CHANNEL_RECEIPT = `${RELEASE_PREFIX}stable-channel.json`;
const REQUIRED_POINTERS = new Set([LEGACY_MANIFEST]);
const CHANNEL_POINTERS = new Set([...CHANNEL_MANIFESTS, CHANNEL_RECEIPT]);
const MUTABLE_POINTERS = new Set([...CANONICAL_DMG_POINTERS, ...REQUIRED_POINTERS, ...CHANNEL_POINTERS]);
const SEMANTIC_VERSION = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";
const VERSIONED_ARTIFACT = new RegExp(
  `^${RELEASE_PREFIX}(${PRODUCT_NAMES.join("|")})-(${SEMANTIC_VERSION})-mac-arm64\\.(?:dmg|zip)(?:\\.blockmap)?$`,
);
const CHECKSUM_MANIFEST = new RegExp(
  `^${RELEASE_PREFIX}(${SEMANTIC_VERSION})/SHA256SUMS$`,
);

export interface RetentionBindings {
  ACTIVE_RELEASES: R2Bucket;
  ARCHIVED_RELEASES: R2Bucket;
}

export interface RetentionOptions {
  dryRun: boolean;
  keepCount: number;
}

export interface RetentionPlan {
  activeObjectCount: number;
  archiveVersions: string[];
  candidateKeys: string[];
  retainedVersions: string[];
}

export interface RetentionReport extends RetentionPlan {
  archivedObjectCount: number;
  copiedObjectCount: number;
  deletedObjectCount: number;
  dryRun: boolean;
  skippedExistingObjectCount: number;
  status: "archived" | "dry-run" | "noop";
}

interface ReleaseInventory {
  plan: RetentionPlan;
  releases: Map<string, string[]>;
}

function releaseKeys(version: string, productName: string): string[] {
  return [
    `${RELEASE_PREFIX}${productName}-${version}-mac-arm64.dmg`,
    `${RELEASE_PREFIX}${productName}-${version}-mac-arm64.dmg.blockmap`,
    `${RELEASE_PREFIX}${productName}-${version}-mac-arm64.zip`,
    `${RELEASE_PREFIX}${productName}-${version}-mac-arm64.zip.blockmap`,
    `${RELEASE_PREFIX}${version}/SHA256SUMS`,
  ].sort();
}

/** The version a key belongs to, and the product name it carries if any. */
function releaseForKey(key: string): { version: string; productName: string | null } | null {
  const artifact = VERSIONED_ARTIFACT.exec(key);
  if (artifact?.[1] && artifact[2]) return { version: artifact[2], productName: artifact[1] };
  const checksums = CHECKSUM_MANIFEST.exec(key);
  // A checksum manifest is named by version alone, so it says nothing about
  // which product name its release carries.
  return checksums?.[1] ? { version: checksums[1], productName: null } : null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function analyzeInventory(
  objects: R2Object[],
  keepCount: number,
  pointerVersions: ReadonlySet<string>,
): ReleaseInventory {
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new Error(`Retention keep count must be a positive integer; received ${keepCount}`);
  }

  const seenKeys = new Set<string>();
  const releases = new Map<string, string[]>();
  const productNames = new Map<string, string>();
  for (const object of objects) {
    if (seenKeys.has(object.key)) throw new Error(`Duplicate active R2 key: ${object.key}`);
    seenKeys.add(object.key);
    if (MUTABLE_POINTERS.has(object.key)) continue;
    const release = releaseForKey(object.key);
    if (release === null) throw new Error(`Unexpected active R2 key: ${object.key}`);
    if (release.productName !== null) {
      const recorded = productNames.get(release.version);
      if (recorded !== undefined && recorded !== release.productName) {
        throw new Error(
          `Release ${release.version} mixes product names: ${recorded} and ${release.productName}`,
        );
      }
      productNames.set(release.version, release.productName);
    }
    const keys = releases.get(release.version) ?? [];
    keys.push(object.key);
    releases.set(release.version, keys);
  }

  const missingPointers = [...REQUIRED_POINTERS].filter((key) => !seenKeys.has(key));
  if (missingPointers.length > 0) {
    throw new Error(`Missing mutable release pointers: ${missingPointers.join(", ")}`);
  }
  const presentChannelPointers = [...CHANNEL_POINTERS].filter((key) => seenKeys.has(key));
  if (presentChannelPointers.length > 0 && presentChannelPointers.length !== CHANNEL_POINTERS.size) {
    const missing = [...CHANNEL_POINTERS].filter((key) => !seenKeys.has(key));
    throw new Error(`Missing mutable release pointers: ${missing.join(", ")}`);
  }
  // Whichever product name it carries, exactly one recovery installer has to be
  // reachable; which one is a fact about when the last release shipped.
  if (![...CANONICAL_DMG_POINTERS].some((key) => seenKeys.has(key))) {
    throw new Error(
      `Missing mutable release pointers: one of ${[...CANONICAL_DMG_POINTERS].join(", ")}`,
    );
  }

  for (const [version, keys] of releases) {
    const productName = productNames.get(version);
    if (productName === undefined) {
      throw new Error(`Incomplete release ${version}: no versioned artifact names it`);
    }
    const expected = releaseKeys(version, productName);
    if (!sameStrings(keys, expected)) {
      throw new Error(
        `Incomplete release ${version}: expected ${expected.length} exact objects, found ${keys.length}`,
      );
    }
    keys.sort();
  }

  const versions = [...releases.keys()].sort(compareVersions);
  for (const version of pointerVersions) {
    if (!releases.has(version)) {
      throw new Error(`Mutable release manifest references missing release ${version}`);
    }
  }
  const splitIndex = Math.max(0, versions.length - keepCount);
  const archiveVersions = versions.slice(0, splitIndex)
    .filter((version) => !pointerVersions.has(version));
  const retainedVersions = versions.filter((version) => !archiveVersions.includes(version));
  const candidateKeys = archiveVersions
    .flatMap((version) => releaseKeys(version, productNames.get(version)!))
    .sort();
  return {
    releases,
    plan: {
      activeObjectCount: objects.length,
      archiveVersions,
      candidateKeys,
      retainedVersions,
    },
  };
}

function manifestVersion(text: string, key: string): string {
  const match = /^version:\s*["']?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))["']?\s*$/mu.exec(text);
  if (!match?.[1]) throw new Error(`Mutable release manifest has no valid version: ${key}`);
  return match[1];
}

async function pointerVersions(bucket: R2Bucket, objects: R2Object[]): Promise<Set<string>> {
  const present = new Set(objects.map((object) => object.key));
  const versions = new Set<string>();
  // Faster and the legacy manifest move with every release, so the ordinary
  // highest-version keep set already covers them. Stable may deliberately lag
  // behind more than five fast releases and therefore protects its version.
  for (const key of [`${RELEASE_PREFIX}stable-mac.yml`]) {
    if (!present.has(key)) continue;
    const object = await bucket.get(key);
    if (object === null) throw new Error(`Mutable release manifest disappeared: ${key}`);
    versions.add(manifestVersion(await new Response(object.body).text(), key));
  }
  return versions;
}

async function inventory(bucket: R2Bucket, keepCount: number): Promise<{
  analysis: ReleaseInventory;
  objects: R2Object[];
}> {
  const objects = await listAll(bucket);
  return {
    analysis: analyzeInventory(objects, keepCount, await pointerVersions(bucket, objects)),
    objects,
  };
}

async function listAll(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const options: R2ListOptions = {
      include: ["httpMetadata", "customMetadata"],
      limit: 1000,
      prefix: RELEASE_PREFIX,
    };
    if (cursor !== undefined) options.cursor = cursor;
    const page = await bucket.list(options);
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects.sort((left, right) => left.key.localeCompare(right.key));
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function comparableObject(object: R2Object): unknown {
  return normalize({
    customMetadata: object.customMetadata ?? {},
    etag: object.etag,
    httpMetadata: object.httpMetadata ?? {},
    key: object.key,
    size: object.size,
  });
}

function inventoryFingerprint(objects: R2Object[]): string {
  return JSON.stringify(
    objects.map((object) =>
      normalize({
        ...comparableObject(object) as Record<string, unknown>,
        storageClass: object.storageClass,
      }),
    ),
  );
}

function assertArchivedCopy(source: R2Object, archived: R2Object | null): void {
  if (archived === null) throw new Error(`Archive copy is missing after write: ${source.key}`);
  if (JSON.stringify(comparableObject(source)) !== JSON.stringify(comparableObject(archived))) {
    throw new Error(`Archive verification mismatch: ${source.key}`);
  }
  if (archived.storageClass !== "InfrequentAccess") {
    throw new Error(
      `Archive object ${source.key} uses ${archived.storageClass}, expected InfrequentAccess`,
    );
  }
}

function baseReport(plan: RetentionPlan, dryRun: boolean): RetentionReport {
  return {
    ...plan,
    archivedObjectCount: 0,
    copiedObjectCount: 0,
    deletedObjectCount: 0,
    dryRun,
    skippedExistingObjectCount: 0,
    status: plan.candidateKeys.length === 0 ? "noop" : dryRun ? "dry-run" : "archived",
  };
}

export async function planRetention(
  activeReleases: R2Bucket,
  keepCount: number,
): Promise<RetentionPlan> {
  return (await inventory(activeReleases, keepCount)).analysis.plan;
}

export async function runRetention(
  bindings: RetentionBindings,
  options: RetentionOptions,
): Promise<RetentionReport> {
  const initialInventory = await inventory(bindings.ACTIVE_RELEASES, options.keepCount);
  const initialObjects = initialInventory.objects;
  const initial = initialInventory.analysis;
  const report = baseReport(initial.plan, options.dryRun);
  if (initial.plan.candidateKeys.length === 0 || options.dryRun) return report;

  const activeByKey = new Map(initialObjects.map((object) => [object.key, object]));
  for (const key of initial.plan.candidateKeys) {
    const sourceHead = activeByKey.get(key);
    if (sourceHead === undefined) throw new Error(`Retention source object disappeared: ${key}`);
    const existingArchive = await bindings.ARCHIVED_RELEASES.head(key);
    if (existingArchive !== null) {
      assertArchivedCopy(sourceHead, existingArchive);
      report.skippedExistingObjectCount += 1;
      continue;
    }

    const source = await bindings.ACTIVE_RELEASES.get(key);
    if (source === null) throw new Error(`Retention source object disappeared: ${key}`);
    if (JSON.stringify(comparableObject(source)) !== JSON.stringify(comparableObject(sourceHead))) {
      throw new Error(`Retention source object changed before copy: ${key}`);
    }
    const putOptions: R2PutOptions = { storageClass: "InfrequentAccess" };
    if (source.customMetadata !== undefined) putOptions.customMetadata = source.customMetadata;
    if (source.httpMetadata !== undefined) putOptions.httpMetadata = source.httpMetadata;
    await bindings.ARCHIVED_RELEASES.put(key, source.body, putOptions);
    assertArchivedCopy(sourceHead, await bindings.ARCHIVED_RELEASES.head(key));
    report.copiedObjectCount += 1;
  }

  const immediatelyBeforeDelete = await listAll(bindings.ACTIVE_RELEASES);
  if (inventoryFingerprint(initialObjects) !== inventoryFingerprint(immediatelyBeforeDelete)) {
    throw new Error("Active release inventory changed during retention; refusing deletion");
  }
  const finalPlan = analyzeInventory(
    immediatelyBeforeDelete,
    options.keepCount,
    await pointerVersions(bindings.ACTIVE_RELEASES, immediatelyBeforeDelete),
  ).plan;
  if (
    !sameStrings(finalPlan.archiveVersions, initial.plan.archiveVersions) ||
    !sameStrings(finalPlan.retainedVersions, initial.plan.retainedVersions) ||
    !sameStrings(finalPlan.candidateKeys, initial.plan.candidateKeys)
  ) {
    throw new Error("Active release keep set changed during retention; refusing deletion");
  }

  await bindings.ACTIVE_RELEASES.delete(initial.plan.candidateKeys);
  report.deletedObjectCount = initial.plan.candidateKeys.length;

  const finalObjects = await listAll(bindings.ACTIVE_RELEASES);
  const completed = analyzeInventory(
    finalObjects,
    options.keepCount,
    await pointerVersions(bindings.ACTIVE_RELEASES, finalObjects),
  ).plan;
  // Count the pointers actually present rather than the names this build knows
  // about: `Rally.dmg` and `Avalon.dmg` are both recognized, and which of them
  // the bucket holds depends on when the last release shipped.
  const finalPointerCount = finalObjects.filter((object) => MUTABLE_POINTERS.has(object.key)).length;
  if (
    completed.archiveVersions.length !== 0 ||
    !sameStrings(completed.retainedVersions, initial.plan.retainedVersions) ||
    finalObjects.length !== initial.plan.retainedVersions.length * 5 + finalPointerCount
  ) {
    throw new Error("Final active release inventory failed retention verification");
  }
  for (const key of initial.plan.candidateKeys) {
    if (await bindings.ACTIVE_RELEASES.head(key)) {
      throw new Error(`Archived key still exists in the active bucket: ${key}`);
    }
    const sourceHead = activeByKey.get(key);
    if (sourceHead === undefined) throw new Error(`Missing preflight metadata for ${key}`);
    assertArchivedCopy(sourceHead, await bindings.ARCHIVED_RELEASES.head(key));
  }

  report.activeObjectCount = finalObjects.length;
  report.archivedObjectCount = initial.plan.candidateKeys.length;
  return report;
}
