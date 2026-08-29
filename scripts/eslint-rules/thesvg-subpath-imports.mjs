/**
 * Require one brand per subpath from `@thesvg/react`, never the barrel.
 *
 * This is a build-cost rule, not a style one. `@thesvg/icons` declares each
 * icon by importing a type from its own index, so anything that reaches the
 * barrel pulls all ~6,500 brands into the TypeScript program: the desktop
 * renderer's program went from 575 files to 7,095, and a cold `pnpm lint` ran
 * out of heap on CI. The `@thesvg/react` per-icon declarations import only from
 * `react`, so `@thesvg/react/github` costs what it looks like.
 *
 * See `docs/using-company-brand-icons.md`.
 */
export const thesvgSubpathImportsRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Import a company mark from its own @thesvg/react subpath rather than the package barrel.",
    },
    schema: [],
    messages: {
      barrel:
        "Import one brand per subpath — `import Github from '@thesvg/react/github'`. The '{{source}}' barrel pulls every brand's declaration into the TypeScript program and takes a cold lint out of heap. See docs/using-company-brand-icons.md.",
    },
  },
  create(context) {
    // The two barrels, and the raw-string packages behind them. A subpath is
    // always `<package>/<slug>`, so a bare specifier is the only barrel form.
    const barrels = new Set(["@thesvg/react", "@thesvg/icons", "thesvg"]);

    function check(node, source) {
      if (typeof source !== "string" || !barrels.has(source)) return;
      context.report({ node, messageId: "barrel", data: { source } });
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source?.type === "Literal") check(node, node.source.value);
      },
    };
  },
};
