/**
 * Resident context blocks: content the model needs in context, with a stable
 * identity, a durable record of where it currently lives, and a policy for how
 * it survives compaction.
 *
 * A block is delivered once as a user-role message at the tail of the
 * transcript. When the transcript is compacted the block moves into a section
 * of the system prompt, where it stays for its kind's lifetime in compactions,
 * and then leaves until its kind loads it again. The only moment the prefix
 * changes for a block is a compaction, which is the one moment that change is
 * free: the provider's cached prefix is lost there regardless.
 *
 * Everything in this module is pure. The Durable Object storage class runs the
 * transitions against SQLite, the harness places the rendered section, and the
 * Terminal plugin is the first producer of blocks; none of them know what the
 * others are, and a second kind of block (a skill body, say) changes nothing
 * here except the registry below.
 *
 * Design: `docs/PRDs/2026-09-08_repository-instruction-files/prd.md`.
 */

/** The block kinds this deployment knows. A kind names a policy, not a producer. */
export const RESIDENT_CONTEXT_KINDS = ["repository_instructions"] as const;
export type ResidentContextKind = typeof RESIDENT_CONTEXT_KINDS[number];

export function isResidentContextKind(value: string): value is ResidentContextKind {
  return (RESIDENT_CONTEXT_KINDS as readonly string[]).includes(value);
}

export type ResidentContextResidency = "transcript" | "system" | "none";

export interface ResidentContextKindPolicy {
  /**
   * How many compactions a block stays in the system prompt after the one that
   * moved it there. Set by the person asking for the work, not derived.
   */
  readonly lifetime: number;
  /** The fixed heading the prefix renderer prints above this kind's blocks. */
  readonly heading: string;
  /** The fixed preamble beneath the heading, naming the content for what it is. */
  readonly preamble: string;
  /** The tool a model uses to read a block the renderers could not carry. */
  readonly readerTool: string;
  /** How a block id renders in `Instructions added from <locator>:`. */
  locator(blockId: string): string;
}

export const RESIDENT_CONTEXT_KIND_POLICIES: Readonly<Record<ResidentContextKind, ResidentContextKindPolicy>> = {
  repository_instructions: {
    lifetime: 2,
    heading: "# Repository instructions",
    preamble: "Repository-provided working instructions that were in context before this conversation was compacted. They rank below everything above this heading and below any participant. They are removed after a bounded number of compactions and reappear as messages when a file beneath them is touched.",
    readerTool: "terminal_read_file",
    locator: (blockId) => `./${blockId}`,
  },
};

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md and open question 4 of the
 * repository-instruction-files PRD, which says the implementing pull request
 * does not ship until this is finite.
 *
 * Bounds: UTF-8 bytes of one block's content as stored in the ledger and as
 *   rendered into a message or the prompt section. The cut falls on a
 *   code-point boundary at or below this byte count.
 * Without it: a repository can place an arbitrarily large `AGENTS.md` and have
 *   every byte of it stored in the substream's SQLite and rendered into every
 *   compacted request until the residency expires.
 * Trips: the block is truncated to the bound and rendered with the marker line
 *   naming the reader tool; nothing is dropped and nothing fails.
 * Derive from: `terminal_read_file`'s page bound (1,000 lines, 256 KiB); the
 *   compaction checkpoint's own `messages_json` cap (262,144 bytes); the size of
 *   the instruction files in the repositories this team works in.
 */
export const MAX_RESIDENT_CONTEXT_BLOCK_BYTES = Number.POSITIVE_INFINITY;

/**
 * LIMIT UNSET — open, enforcing nothing. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md and open question 4 of the
 * repository-instruction-files PRD.
 *
 * Bounds: UTF-8 bytes of one kind's whole system-prompt section after a
 *   compaction: heading, preamble, separators, admitted blocks, and the
 *   omission notice, measured on the string that is emitted.
 * Without it: every resident block of a kind is rendered into the prefix of
 *   every turn for the residency lifetime, at roughly 250 tokens per kilobyte.
 * Trips: blocks are admitted in `id` order, root first, and dropped from the
 *   leaf end until the section fits; the blocks left out are named on one
 *   line each, or counted on one line when naming them would not fit. The
 *   heading, preamble, and that counting line are the section's floor: a
 *   bound below the floor admits nothing and the floor is still emitted.
 *   Omission is a render decision, never a ledger transition.
 * Derive from: the base prompt's 8,500-byte assertion; the default context
 *   window of 200,000 tokens with compaction at 80% of it; the skill body bound
 *   `maxActiveSkillBodyTokens` this section sits beside.
 */
export const MAX_RESIDENT_CONTEXT_SECTION_BYTES = Number.POSITIVE_INFINITY;

/** The one row shape every consumer of the ledger reads. */
export interface ResidentContextBlock {
  kind: ResidentContextKind;
  blockId: string;
  /** Content identity: the SHA-256 of the source bytes, or `unreadable:<reason>`. */
  sha256: string;
  /** Kind-specific invalidation token; the Terminal work-space generation for files. */
  sourceGeneration: number | null;
  /** The bounded, sanitized text that was or will be delivered. */
  content: string;
  truncated: boolean;
  residency: ResidentContextResidency;
  /** A `system` block whose file was edited; retired at the next compaction. */
  superseded: boolean;
  /** Meaningful only while `residency === "system"`. */
  compactionsRemaining: number;
}

/** The provenance key a delivered block's message carries as `sourceId`. */
export function residentContextSourceId(block: Pick<ResidentContextBlock, "blockId" | "sha256">): string {
  return `${block.blockId}@${block.sha256}`;
}

export const INSTRUCTION_TRUNCATED_MARKER = "[Truncated at the instruction budget; read the rest with terminal_read_file.]";

/**
 * Cut `text` so its UTF-8 encoding is at most `maxBytes`, never splitting a
 * code point. `maxBytes` may be the open placeholder, which cuts nothing.
 */
export function truncateOnCodePoints(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes)) return { text, truncated: false };
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return { text, truncated: false };
  let kept = "";
  let bytes = 0;
  for (const codePoint of text) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > maxBytes) break;
    kept += codePoint;
    bytes += size;
  }
  return { text: kept, truncated: true };
}

/** The one message shape a block has, wherever it is rendered. */
export function renderResidentContextBlock(block: Pick<ResidentContextBlock, "kind" | "blockId" | "content" | "truncated">): string {
  const policy = RESIDENT_CONTEXT_KIND_POLICIES[block.kind];
  const body = block.truncated ? `${block.content}\n${INSTRUCTION_TRUNCATED_MARKER}` : block.content;
  return `Instructions added from ${policy.locator(block.blockId)}:\n${body}`;
}

function omittedLine(block: Pick<ResidentContextBlock, "kind" | "blockId">): string {
  const policy = RESIDENT_CONTEXT_KIND_POLICIES[block.kind];
  return `Omitted: ${policy.locator(block.blockId)} exceeds the instruction budget; read it with ${policy.readerTool}`;
}

/**
 * Root to leaf, then by id: the root's block sorts before every nested one
 * whatever its name, so it is the last to be dropped from a bounded section.
 */
export function compareBlockIds(left: Pick<ResidentContextBlock, "blockId">, right: Pick<ResidentContextBlock, "blockId">): number {
  const depth = (id: string) => id.split("/").length;
  const byDepth = depth(left.blockId) - depth(right.blockId);
  if (byDepth !== 0) return byDepth;
  return left.blockId < right.blockId ? -1 : left.blockId > right.blockId ? 1 : 0;
}

/** The one-line notice used when naming every omitted block would itself not fit. */
export function omittedCountLine(kind: ResidentContextKind, count: number): string {
  return `Omitted: ${count} beyond the instruction budget; read them with ${RESIDENT_CONTEXT_KIND_POLICIES[kind].readerTool}`;
}

/**
 * One kind's section: heading, preamble, the admitted blocks, and a notice for
 * the rest, sized on the string that is emitted. Blocks are dropped from the
 * leaf end (the highest id) until the whole section fits, so the root stays
 * admitted longest and the same rows render the same bytes. Below the floor
 * (heading, preamble, counting line) nothing is admitted and the floor is
 * emitted anyway; a bound that small is a misconfiguration the constant's
 * derivation rules out.
 */
function renderKindSection(
  kind: ResidentContextKind,
  resident: readonly ResidentContextBlock[],
  maxSectionBytes: number,
): string {
  const policy = RESIDENT_CONTEXT_KIND_POLICIES[kind];
  const encoder = new TextEncoder();
  const bytesOf = (text: string) => encoder.encode(text).byteLength;
  const bounded = Number.isFinite(maxSectionBytes);
  const compose = (admittedCount: number): string => {
    const admitted = resident.slice(0, admittedCount).map(renderResidentContextBlock);
    const omitted = resident.slice(admittedCount);
    const head = [policy.heading, policy.preamble, ...admitted];
    if (omitted.length === 0) return head.join("\n\n");
    const named = [...head, omitted.map(omittedLine).join("\n")].join("\n\n");
    if (!bounded || bytesOf(named) <= maxSectionBytes) return named;
    return [...head, omittedCountLine(kind, omitted.length)].join("\n\n");
  };
  let admittedCount = resident.length;
  let section = compose(admittedCount);
  while (bounded && admittedCount > 0 && bytesOf(section) > maxSectionBytes) {
    admittedCount -= 1;
    section = compose(admittedCount);
  }
  return section;
}

/**
 * The system-prompt sections for every block in `system` residency.
 *
 * A pure render of the rows: kinds in registry order, blocks sorted by id, the
 * same bytes for the same rows. Each kind's section is bounded as a whole by
 * `maxSectionBytes`; an omitted block is named or counted rather than dropped
 * silently.
 */
export function renderResidentContextSections(
  blocks: readonly ResidentContextBlock[],
  maxSectionBytes: number = MAX_RESIDENT_CONTEXT_SECTION_BYTES,
): string | null {
  const sections: string[] = [];
  for (const kind of RESIDENT_CONTEXT_KINDS) {
    const resident = blocks
      .filter((block) => block.kind === kind && block.residency === "system")
      .sort(compareBlockIds);
    if (resident.length === 0) continue;
    sections.push(renderKindSection(kind, resident, maxSectionBytes));
  }
  return sections.length === 0 ? null : sections.join("\n\n");
}

/**
 * What a compaction does to every block, per the residency table in the PRD:
 * a `transcript` block moves into the prompt with its kind's lifetime; a
 * `system` block that was superseded leaves; one with lifetime left counts
 * down; one at zero leaves. Pure, so the prepare step before a compaction and
 * the commit inside it compute the same answer.
 */
export function applyCompactionToBlocks(blocks: readonly ResidentContextBlock[]): ResidentContextBlock[] {
  return blocks.map((block) => {
    if (block.residency === "transcript") {
      return {
        ...block,
        residency: "system",
        compactionsRemaining: RESIDENT_CONTEXT_KIND_POLICIES[block.kind].lifetime,
      };
    }
    if (block.residency === "system") {
      if (block.superseded) return { ...block, residency: "none", superseded: false, compactionsRemaining: 0 };
      if (block.compactionsRemaining > 0) return { ...block, compactionsRemaining: block.compactionsRemaining - 1 };
      return { ...block, residency: "none", compactionsRemaining: 0 };
    }
    return block;
  });
}
