/** Keep the shared work-stream cache's array contract behind its typed helper. */
export const noDirectWorkstreamsCacheWriteRule = {
  meta: {
    type: "problem",
    docs: { description: "Require the typed work-stream cache write helper." },
    schema: [],
    messages: {
      direct: "Write the workstreams cache through setCachedWorkstreams; React Query does not bind this key to its array value type.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const keyBindings = new Set();
    const variableInitializers = new Map();

    function track(node) {
      for (const variable of sourceCode.getDeclaredVariables(node)) keyBindings.add(variable);
    }

    function resolve(identifier) {
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return null;
    }

    function unwrap(node) {
      let current = node;
      while (
        current
        && (current.type === "TSAsExpression"
          || current.type === "TSSatisfiesExpression"
          || current.type === "TSNonNullExpression"
          || current.type === "ChainExpression")
      ) current = current.expression;
      return current;
    }

    function isWorkstreamsKey(node) {
      const value = unwrap(node);
      if (value?.type === "Identifier") {
        const variable = resolve(value);
        return variable !== null && keyBindings.has(variable);
      }
      return value?.type === "ArrayExpression"
        && value.elements.length === 1
        && value.elements[0]?.type === "Literal"
        && value.elements[0].value === "workstreams";
    }

    function propertyName(node) {
      if (!node || node.type !== "MemberExpression") return null;
      if (!node.computed && node.property.type === "Identifier") return node.property.name;
      if (node.computed && node.property.type === "Literal") return node.property.value;
      return null;
    }

    function queryKeyFromFilter(node, seen = new Set()) {
      const value = unwrap(node);
      if (value?.type === "Identifier") {
        const variable = resolve(value);
        if (!variable || seen.has(variable)) return null;
        const initializer = variableInitializers.get(variable);
        if (!initializer) return null;
        seen.add(variable);
        return queryKeyFromFilter(initializer, seen);
      }
      if (value?.type !== "ObjectExpression") return null;
      for (const property of value.properties) {
        if (property.type !== "Property" || property.computed) continue;
        const name = property.key.type === "Identifier" ? property.key.name : property.key.value;
        if (name === "queryKey") return property.value;
      }
      return null;
    }

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
          if (imported === "WORKSTREAMS_QUERY_KEY") track(specifier);
        }
      },
      VariableDeclarator(node) {
        for (const variable of sourceCode.getDeclaredVariables(node)) {
          variableInitializers.set(variable, node.init);
        }
        if (isWorkstreamsKey(node.init)) track(node);
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const method = propertyName(node.callee);
        const key = method === "setQueryData"
          ? node.arguments[0]
          : method === "setQueriesData"
            ? queryKeyFromFilter(node.arguments[0])
            : null;
        if (!key || !isWorkstreamsKey(key)) return;
        context.report({ node, messageId: "direct" });
      },
    };
  },
};
