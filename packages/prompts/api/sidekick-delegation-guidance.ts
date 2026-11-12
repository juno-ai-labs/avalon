/** How a loop inspects, and where it may, changes a Sidekick's delegates. */
export function sidekickDelegationGuidance(sets = true): string {
  const name = (local: string) => `sidekick_${local}`;
  const inspect = `Use ${name("delegates_list")} to inspect a Sidekick's allowed users.`;
  if (!sets) {
    return `${inspect} This run cannot change delegation. When it needs an account nobody lends, say which account and why in your reply, so a person who manages the Sidekick can add a delegate. The harness handles eligible-account fallback after definite access refusals.`;
  }
  return `${inspect} Use ${name("set_delegation")} with a Sidekick ID and an Organization userId to add or withdraw that user's delegation. A background agent of this conversation may use it too; a Sidekick run and its workers may not. For your own withdrawal after access loss, use ${name("my_delegations_list")} or a known Sidekick ID. Changing delegation starts no run. The harness handles eligible-account fallback after definite access refusals.`;
}
