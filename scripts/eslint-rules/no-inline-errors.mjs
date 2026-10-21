/** Errors interrupt with an acknowledged popup; they never become page content. */
export const noInlineErrorsRule = {
  meta: {
    type: "problem",
    docs: { description: "Require ErrorNotice instead of inline error messages." },
    schema: [],
    messages: { inline: "Inline errors are banned. Use ErrorNotice (or AcknowledgedErrorDialog) with an OK action." },
  },
  create(context) {
    function strings(node) {
      if (!node) return [];
      if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [];
      if (node.type === "JSXExpressionContainer") return strings(node.expression);
      if (node.type === "ConditionalExpression") return [...strings(node.consequent), ...strings(node.alternate)];
      if (node.type === "LogicalExpression") return [...strings(node.left), ...strings(node.right)];
      if (node.type === "TemplateLiteral") return [...node.quasis.map((part) => part.value.cooked ?? ""), ...node.expressions.flatMap(strings)];
      if (node.type === "ObjectExpression") return node.properties.flatMap((property) => property.type === "Property"
        ? [...strings(property.key), ...strings(property.value)] : []);
      if (node.type === "CallExpression") return node.arguments.flatMap(strings);
      return [];
    }
    return {
      ImportSpecifier(node) {
        if (node.imported.name === "InlineError") context.report({ node, messageId: "inline" });
      },
      JSXOpeningElement(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : node.name.property?.name;
        if (name === "InlineError") {
          context.report({ node, messageId: "inline" });
          return;
        }
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          const values = strings(attribute.value);
          if ((attribute.name.name === "role" && values.includes("alert"))
            || (attribute.name.name === "className" && values.some((value) => /(?:^|\s)(?:inline-error|[\w-]+-error|is-error)(?:\s|$)/u.test(value)))) {
            context.report({ node: attribute, messageId: "inline" });
            return;
          }
        }
      },
    };
  },
};
