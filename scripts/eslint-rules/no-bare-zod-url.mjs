/** Disallow generic Zod URL parsing where the product's accepted schemes are implicit. */
export const noBareZodUrlRule = {
  meta: {
    type: "problem",
    docs: { description: "Require an explicit URL-scheme contract instead of bare Zod .url()." },
    schema: [],
    messages: {
      bare: "Bare Zod .url() has ambiguous scheme semantics. Use an explicit schema from @rally/contracts/url-schemas.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const zodBindings = new Set();
    const schemaBindings = new Set();
    const directUrlBindings = new Set();

    function resolve(identifier) {
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return null;
    }

    function tracked(node, bindings) {
      if (node?.type !== "Identifier") return false;
      const variable = resolve(node);
      return variable !== null && bindings.has(variable);
    }

    function track(node, bindings) {
      for (const variable of sourceCode.getDeclaredVariables(node)) bindings.add(variable);
    }

    function isZodRoot(node) {
      if (!node) return false;
      if (node.type === "Identifier") return tracked(node, zodBindings) || tracked(node, schemaBindings);
      return node.type === "MemberExpression" && !node.computed && tracked(node.object, zodBindings);
    }

    function isSchemaChain(node) {
      if (!node) return false;
      if (isZodRoot(node)) return true;
      if (node.type !== "CallExpression") return false;
      if (node.callee.type === "Identifier") return isZodRoot(node.callee);
      return node.callee.type === "MemberExpression" && !node.callee.computed
        ? isSchemaChain(node.callee.object)
        : false;
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "zod" || node.importKind === "type") return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === "type") continue;
          track(specifier, zodBindings);
          if (
            specifier.type === "ImportSpecifier"
            && ((specifier.imported.type === "Identifier" && specifier.imported.name === "url")
              || (specifier.imported.type === "Literal" && specifier.imported.value === "url"))
          ) track(specifier, directUrlBindings);
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init && isSchemaChain(node.init)) track(node, schemaBindings);
      },
      CallExpression(node) {
        if (tracked(node.callee, directUrlBindings)) {
          context.report({ node, messageId: "bare" });
          return;
        }
        if (
          node.callee.type !== "MemberExpression"
          || propertyName(node.callee) !== "url"
          || !isSchemaChain(node.callee.object)
        ) return;
        context.report({ node, messageId: "bare" });
      },
    };
  },
};

function propertyName(node) {
  if (!node || node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal") return node.property.value;
  return null;
}
