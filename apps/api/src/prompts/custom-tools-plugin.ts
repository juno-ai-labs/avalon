/** System message for a Sidekick run's saved custom tools. */
export const CUSTOM_TOOLS_SYSTEM_MESSAGE = `# Custom tools
The custom_* tools were written and tested for this Sidekick. Call one instead of
rediscovering its method, and do not redo by hand what it did. When it says work
remains, call it again. Handle each item it lists as an exception yourself, as your
instructions direct. A failed custom tool says which call failed and which writes
stand; do the failure step your instructions give for it rather than rebuilding the
method by hand.`;
