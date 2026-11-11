/**
 * One loadable instruction module, as the host hands it to the harness.
 *
 * Authored as markdown. `description` and `whenToUse` are the only parts the
 * model sees before it loads the skill, so they carry the whole routing
 * decision: what this is, and when it applies. `body` is paid for only on load.
 *
 * `SKILL.md` files parse straight into this shape with `parseSkillMarkdown`
 * from `@juno-ai/bind/skills`.
 */
export interface HarnessSkill {
  /** Host-selected routing preference; does not activate instructions. */
  recommended?: boolean;
  /** Lower-kebab identifier, unique within a run. What `load_skill` takes. */
  name: string;
  /** Tier-1 catalog line: what the skill does. */
  description: string;
  /** Tier-1 activation hint: when to reach for it. */
  whenToUse: string;
  /** The instructions injected once loaded. */
  body: string;
  /**
   * The plugin whose tools this skill describes, if any. Two effects, both
   * conservative: the skill is offered only to a run whose scope already
   * includes that plugin, and loading it *names* the plugin rather than
   * activating it — a document must not be able to grant a capability.
   */
  ownerPlugin?: string;
  /** Bundled reference files, readable with `read_skill_resource` after loading. */
  resources?: Array<{ path: string; body: string; contentType?: string }>;
}
