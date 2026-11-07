/**
 * Presentation surfaces must render product-authored failure states. Transport,
 * provider, and exception diagnostics belong in telemetry and logs, not UI copy.
 */
export const presentationBoundaryFiles = [
  "apps/desktop/src/renderer/components/message-feed.tsx",
  "apps/desktop/src/renderer/components/scope-sharing-panel.tsx",
  "apps/desktop/src/renderer/components/**/*{sidebar,rail}*.tsx",
  "apps/desktop/src/renderer/components/workstream-blocks.tsx",
  "apps/desktop/src/renderer/screens/conversation-surface.tsx",
  "packages/ui/src/components/**/*{sidebar,rail}*.tsx",
  "packages/ui/src/components/sidekick-picker.tsx",
  "packages/ui/src/components/sidekick-section.tsx",
];

export const presentationBoundaryIgnores = ["**/*.test.tsx"];

function staticPropertyName(node) {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal") return node.property.value;
  return null;
}

function unwrap(node) {
  if (!node) return node;
  if (["ChainExpression", "TSAsExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(node.type)) {
    return unwrap(node.expression);
  }
  return node;
}

function objectPatternReadsMessage(pattern) {
  return pattern.properties.some((property) => property.type === "Property"
    && ((!property.computed && property.key.type === "Identifier" && property.key.name === "message")
      || (property.computed && property.key.type === "Literal" && property.key.value === "message")
      || (!property.computed && property.key.type === "Literal" && property.key.value === "message")));
}

export const noDiagnosticMessageInPresentationRule = {
  meta: {
    type: "problem",
    docs: {
      description: "prevent raw diagnostic messages from crossing into presentation surfaces",
    },
    schema: [],
    messages: {
      diagnosticMessage: "Do not turn a diagnostic error into presentation copy here. Map the failure to a semantic state and let the presentation component own the copy.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const diagnosticVariables = new WeakSet();

    function variableFor(identifier) {
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return undefined;
    }

    function isDiagnosticExpression(candidate) {
      const node = unwrap(candidate);
      if (!node) return false;
      if (node.type === "Identifier") {
        const variable = variableFor(node);
        if (variable && diagnosticVariables.has(variable)) return true;
        if (variable?.defs.some((definition) => definition.type === "Parameter")) return false;
        return /^(?:error|err|cause|exception)$/iu.test(node.name)
          || /(?:Error|Exception)$/u.test(node.name);
      }
      if (node.type === "MemberExpression") {
        const property = staticPropertyName(node);
        return property === "error" || property === "cause" || isDiagnosticExpression(node.object);
      }
      if (node.type === "LogicalExpression") {
        return isDiagnosticExpression(node.left) || isDiagnosticExpression(node.right);
      }
      if (node.type === "ConditionalExpression") {
        return isDiagnosticExpression(node.consequent) || isDiagnosticExpression(node.alternate);
      }
      return false;
    }

    return {
      MemberExpression(node) {
        const propertyName = staticPropertyName(node);
        if ((propertyName === "message" || propertyName === "toString") && isDiagnosticExpression(node.object)) {
          context.report({ node: node.property, messageId: "diagnosticMessage" });
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === "ObjectPattern" && objectPatternReadsMessage(node.id) && isDiagnosticExpression(node.init)) {
          context.report({ node: node.id, messageId: "diagnosticMessage" });
        }
        if (node.parent.kind === "const" && node.id.type === "Identifier" && isDiagnosticExpression(node.init)) {
          for (const variable of sourceCode.getDeclaredVariables(node)) diagnosticVariables.add(variable);
        }
      },
      CatchClause(node) {
        for (const variable of sourceCode.getDeclaredVariables(node)) diagnosticVariables.add(variable);
        if (node.param?.type === "ObjectPattern" && objectPatternReadsMessage(node.param)) {
          context.report({ node: node.param, messageId: "diagnosticMessage" });
        }
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "String"
          && node.arguments.some((argument) => argument.type !== "SpreadElement" && isDiagnosticExpression(argument))) {
          context.report({ node: node.callee, messageId: "diagnosticMessage" });
        }
      },
    };
  },
};
