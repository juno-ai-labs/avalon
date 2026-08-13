function propertyName(node) {
  if (!node || !["Property", "MemberExpression"].includes(node.type)) return null;
  const property = node.type === "Property" ? node.key : node.property;
  if (!node.computed && property.type === "Identifier") return property.name;
  if (property.type === "Literal" && typeof property.value === "string") return property.value;
  return null;
}

function unwrap(node) {
  if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node?.type)) {
    return unwrap(node.expression);
  }
  return node;
}

function isZodCoerceNumberCall(node, isZodBinding, isDirectCoerceBinding) {
  const value = unwrap(node);
  if (value?.type !== "CallExpression") return false;
  const numberMember = value.callee;
  if (numberMember.type !== "MemberExpression" || propertyName(numberMember) !== "number") return false;
  const coerceMember = unwrap(numberMember.object);
  if (coerceMember?.type === "Identifier") return isDirectCoerceBinding(coerceMember);
  return coerceMember?.type === "MemberExpression"
    && propertyName(coerceMember) === "coerce"
    && coerceMember.object.type === "Identifier"
    && isZodBinding(coerceMember.object);
}

function literalTypeNames(node) {
  const value = unwrap(node);
  if (value?.type !== "ArrayExpression") return null;
  const names = [];
  for (const element of value.elements) {
    const item = unwrap(element);
    if (item?.type !== "Literal" || typeof item.value !== "string") return null;
    names.push(item.value);
  }
  return names;
}

function hasCompatibilityNumberStringUnion(names) {
  const types = new Set(names);
  const hasNumber = types.has("number") || types.has("integer");
  if (!hasNumber || !types.has("string")) return false;
  return [...types].every((type) => ["integer", "null", "number", "string"].includes(type));
}

/**
 * Keep tool input schemas honest and strict. The harness owns the deliberately
 * narrow compatibility behavior for exact numeric strings; putting coercion or
 * a string alternative in an individual tool either accepts too much or stops
 * the harness from normalizing the value to one canonical number.
 */
export const toolInputNumberBoundaryRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep model-facing numeric tool fields strict and rely on harness normalization.",
    },
    schema: [],
    messages: {
      coercion: "Tool input numbers must use strict z.number(); the harness already accepts exact finite JSON-number strings. z.coerce.number() also accepts ambiguous values such as empty or whitespace-only strings.",
      compatibilityUnion: "Declare this tool field as number/integer only. The harness accepts exact finite numeric strings without advertising string as a second model-facing type. If string has separate domain meaning, use explicit anyOf branches, document it, and add focused validation coverage.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const schemaInitializers = new Map();
    const toolSchemas = [];
    const reportedCoercions = new Set();
    const directCoerceBindings = new Set();
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

    function trackDeclared(node, collection) {
      for (const variable of sourceCode.getDeclaredVariables(node)) collection.add(variable);
    }

    function isZodBinding(identifier) {
      const variable = resolve(identifier);
      return variable !== null && zodBindings.has(variable);
    }

    function isDirectCoerceBinding(identifier) {
      const variable = resolve(identifier);
      return variable !== null && directCoerceBindings.has(variable);
    }

    function inspectSchema(node, seen) {
      const value = unwrap(node);
      if (!value || seen.has(value)) return;
      seen.add(value);

      if (
        isZodCoerceNumberCall(value, isZodBinding, isDirectCoerceBinding)
        && !reportedCoercions.has(value)
      ) {
        reportedCoercions.add(value);
        context.report({ node: value, messageId: "coercion" });
      }

      if (value.type === "Identifier") {
        const variable = resolve(value);
        if (variable && schemaInitializers.has(variable)) {
          inspectSchema(schemaInitializers.get(variable), seen);
        }
        return;
      }

      if (value.type === "ObjectExpression") {
        for (const property of value.properties) {
          if (property.type !== "Property" || property.kind !== "init") continue;
          if (propertyName(property) === "type") {
            const names = literalTypeNames(property.value);
            if (names && hasCompatibilityNumberStringUnion(names)) {
              context.report({ node: property.value, messageId: "compatibilityUnion" });
            }
          }
          inspectSchema(property.value, seen);
        }
        return;
      }
      if (value.type === "ArrayExpression") {
        for (const element of value.elements) inspectSchema(element, seen);
        return;
      }
      if (value.type === "CallExpression") {
        inspectSchema(value.callee, seen);
        for (const argument of value.arguments) {
          if (argument.type !== "SpreadElement") inspectSchema(argument, seen);
        }
        return;
      }
      if (value.type === "MemberExpression") {
        inspectSchema(value.object, seen);
        if (value.computed) inspectSchema(value.property, seen);
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "zod" || node.importKind === "type") return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === "type") continue;
          if (
            specifier.type === "ImportNamespaceSpecifier"
            || specifier.type === "ImportDefaultSpecifier"
            || (specifier.type === "ImportSpecifier"
              && ((specifier.imported.type === "Identifier" && specifier.imported.name === "z")
                || (specifier.imported.type === "Literal" && specifier.imported.value === "z")))
          ) {
            trackDeclared(specifier, zodBindings);
          } else if (
            specifier.type === "ImportSpecifier"
            && ((specifier.imported.type === "Identifier" && specifier.imported.name === "coerce")
              || (specifier.imported.type === "Literal" && specifier.imported.value === "coerce"))
          ) {
            trackDeclared(specifier, directCoerceBindings);
          }
        }
      },
      VariableDeclarator(node) {
        if (!node.init) return;
        for (const variable of sourceCode.getDeclaredVariables(node)) {
          schemaInitializers.set(variable, node.init);
        }
      },
      Property(node) {
        if (propertyName(node) !== "inputSchema") return;
        toolSchemas.push(node.value);
      },
      "Program:exit"() {
        for (const schema of toolSchemas) inspectSchema(schema, new Set());
      },
    };
  },
};
