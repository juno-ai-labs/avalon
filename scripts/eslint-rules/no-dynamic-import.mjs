/** Keep every JavaScript and TypeScript dependency in the statically checked graph. */
export const noDynamicImportRule = {
  meta: {
    type: "problem",
    docs: { description: "Require static module imports." },
    schema: [],
    messages: {
      dynamic: "Use a static import. Independent initialization requires a typed process or deployment boundary.",
    },
  },
  create(context) {
    return {
      ImportExpression(node) {
        context.report({ node, messageId: "dynamic" });
      },
    };
  },
};
