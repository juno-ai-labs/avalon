/**
 * Presentation surfaces must render product-authored failure states. Transport,
 * provider, and exception diagnostics belong in telemetry and logs, not UI copy.
 */
export const presentationBoundaryFiles = [
  "apps/browser/src/conversation.tsx",
  "apps/desktop/src/renderer/components/scope-sharing-panel.tsx",
  "apps/desktop/src/renderer/components/**/*{sidebar,rail}*.tsx",
  "apps/desktop/src/renderer/components/sidekick-picker.tsx",
  "apps/desktop/src/renderer/components/sidekick-section.tsx",
  "apps/desktop/src/renderer/components/workstream-blocks.tsx",
  "apps/desktop/src/renderer/screens/conversation-surface.tsx",
  "apps/desktop/src/renderer/screens/workstream.tsx",
  "packages/ui/src/components/conversation-header.tsx",
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

function isDiagnosticExpression(candidate, catchBindings = new Set()) {
  const node = unwrap(candidate);
  if (!node) return false;
  if (node.type === "Identifier") {
    return catchBindings.has(node.name)
      || /^(?:error|err|cause|exception)$/iu.test(node.name)
      || /(?:Error|Exception)$/u.test(node.name);
  }
  if (node.type === "MemberExpression") {
    const property = staticPropertyName(node);
    return property === "error" || property === "cause" || isDiagnosticExpression(node.object, catchBindings);
  }
  if (node.type === "LogicalExpression") {
    return isDiagnosticExpression(node.left, catchBindings) || isDiagnosticExpression(node.right, catchBindings);
  }
  if (node.type === "ConditionalExpression") {
    return isDiagnosticExpression(node.consequent, catchBindings) || isDiagnosticExpression(node.alternate, catchBindings);
  }
  return false;
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
    const catchBindings = new Map();
    return {
      MemberExpression(node) {
        const propertyName = staticPropertyName(node);
        if ((propertyName === "message" || propertyName === "toString") && isDiagnosticExpression(node.object, catchBindings)) {
          context.report({ node: node.property, messageId: "diagnosticMessage" });
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === "ObjectPattern" && objectPatternReadsMessage(node.id) && isDiagnosticExpression(node.init, catchBindings)) {
          context.report({ node: node.id, messageId: "diagnosticMessage" });
        }
      },
      CatchClause(node) {
        if (node.param?.type === "Identifier") {
          catchBindings.set(node.param.name, (catchBindings.get(node.param.name) ?? 0) + 1);
        }
        if (node.param?.type === "ObjectPattern" && objectPatternReadsMessage(node.param)) {
          context.report({ node: node.param, messageId: "diagnosticMessage" });
        }
      },
      "CatchClause:exit"(node) {
        if (node.param?.type === "Identifier") {
          const remaining = (catchBindings.get(node.param.name) ?? 1) - 1;
          if (remaining === 0) catchBindings.delete(node.param.name);
          else catchBindings.set(node.param.name, remaining);
        }
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "String"
          && node.arguments.some((argument) => argument.type !== "SpreadElement" && isDiagnosticExpression(argument, catchBindings))) {
          context.report({ node: node.callee, messageId: "diagnosticMessage" });
        }
      },
    };
  },
};
