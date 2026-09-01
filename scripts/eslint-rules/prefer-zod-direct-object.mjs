/** Prefer Zod's direct object-mode constructors over constructing and cloning an object schema. */
export const preferZodDirectObjectRule = {
  meta: {
    type: "suggestion",
    docs: { description: "Prefer z.strictObject() and z.looseObject() over chained object-mode methods." },
    fixable: "code",
    schema: [],
    messages: {
      direct: "Construct this schema with z.{{constructor}}() instead of z.object().{{method}}().",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const zodBindings = new Set();

    function resolve(identifier) {
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return null;
    }

    function isTrackedZod(identifier) {
      if (identifier?.type !== "Identifier") return false;
      const variable = resolve(identifier);
      return variable !== null && zodBindings.has(variable);
    }

    function track(specifier) {
      for (const variable of sourceCode.getDeclaredVariables(specifier)) zodBindings.add(variable);
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "zod" || node.importKind === "type") return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === "type") continue;
          if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") {
            track(specifier);
            continue;
          }
          if (
            specifier.type === "ImportSpecifier"
            && ((specifier.imported.type === "Identifier" && specifier.imported.name === "z")
              || (specifier.imported.type === "Literal" && specifier.imported.value === "z"))
          ) track(specifier);
        }
      },
      CallExpression(node) {
        if (node.arguments.length !== 0 || node.callee.type !== "MemberExpression") return;
        const method = propertyName(node.callee);
        const constructor = method === "strict" ? "strictObject" : method === "passthrough" ? "looseObject" : null;
        if (!constructor) return;

        const objectCall = node.callee.object;
        if (
          objectCall.type !== "CallExpression"
          || objectCall.callee.type !== "MemberExpression"
          || propertyName(objectCall.callee) !== "object"
          || !isTrackedZod(objectCall.callee.object)
        ) return;

        context.report({
          node,
          messageId: "direct",
          data: { constructor, method },
          fix(fixer) {
            const directCallee = `${sourceCode.getText(objectCall.callee.object)}.${constructor}`;
            const chainedMethodTokens = sourceCode
              .getTokens(node)
              .filter((token) => token.range[0] >= objectCall.range[1]);
            return [
              fixer.replaceText(objectCall.callee, directCallee),
              ...chainedMethodTokens.map((token) => fixer.remove(token)),
            ];
          },
        });
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
