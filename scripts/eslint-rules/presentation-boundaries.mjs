/**
 * Presentation surfaces must render product-authored failure states. Transport,
 * provider, and exception diagnostics belong in telemetry and logs, not UI copy.
 */
export const noDiagnosticMessageInPresentationRule = {
  meta: {
    type: "problem",
    docs: {
      description: "prevent raw diagnostic messages from crossing into presentation surfaces",
    },
    schema: [],
    messages: {
      diagnosticMessage: "Do not render a diagnostic .message here. Map the failure to a semantic state and let the presentation component own the copy.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const propertyName = node.computed
          ? node.property.type === "Literal" ? node.property.value : null
          : node.property.type === "Identifier" ? node.property.name : null;
        if (propertyName === "message") {
          context.report({ node: node.property, messageId: "diagnosticMessage" });
        }
      },
    };
  },
};
