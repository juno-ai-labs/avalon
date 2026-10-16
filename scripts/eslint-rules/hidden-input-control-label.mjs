/**
 * A control whose stylesheet hides its real `<input>` and draws a sibling in
 * its place must be a `<label>`, or sit inside one. The label is what forwards
 * a click on the drawn part to the input; without it the click lands on a
 * decoration and nothing changes. The class names come from the config, since
 * which classes hide their input is the stylesheet's decision, not this rule's.
 */
export const hiddenInputControlLabelRule = {
  meta: {
    type: "problem",
    docs: { description: "Require a <label> around controls whose CSS hides the real input." },
    schema: [{
      type: "object",
      properties: { classNames: { type: "array", items: { type: "string" }, uniqueItems: true } },
      required: ["classNames"],
      additionalProperties: false,
    }],
    messages: {
      unlabelled: "`{{className}}` hides its input, so a click on what it draws only reaches the input through a <label>. Make this element a <label> or put it inside one.",
    },
  },
  create(context) {
    const classNames = new Set(context.options[0]?.classNames ?? []);
    return {
      JSXOpeningElement(node) {
        const attribute = node.attributes.find((candidate) =>
          candidate.type === "JSXAttribute" && candidate.name.type === "JSXIdentifier" && candidate.name.name === "className");
        if (!attribute?.value) return;
        const className = classTokens(attribute.value).find((token) => classNames.has(token));
        if (!className || insideLabel(node)) return;
        context.report({ node, messageId: "unlabelled", data: { className } });
      },
    };
  },
};

/** Every class token spelled literally anywhere in a className value, conditionals and helper calls included. */
function classTokens(node) {
  switch (node?.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value.split(/\s+/u) : [];
    case "JSXExpressionContainer":
      return classTokens(node.expression);
    case "TemplateLiteral":
      return templateTokens(node);
    case "ConditionalExpression":
      return [...classTokens(node.consequent), ...classTokens(node.alternate)];
    case "LogicalExpression":
      return [...classTokens(node.left), ...classTokens(node.right)];
    // clsx('a', on && 'b', ['c'], { d: on }) and any other class-name helper.
    case "CallExpression":
      return node.arguments.flatMap(classTokens);
    case "ArrayExpression":
      return node.elements.flatMap(classTokens);
    case "ObjectExpression":
      return node.properties.flatMap((property) => property.type === "Property" && !property.computed
        ? property.key.type === "Identifier" ? [property.key.name] : classTokens(property.key)
        : []);
    default:
      return [];
  }
}

/**
 * A template's text tokens and its interpolations' tokens, keeping only those
 * that whitespace or the template's ends cut off whole: `settings-${x}` and
 * `${x}-hint` name neither half.
 */
function templateTokens(node) {
  const text = node.quasis.map((quasi) => quasi.value.cooked ?? "");
  const tokens = text.join("\0").split(/\s+/u).filter((token) => !token.includes("\0"));
  node.expressions.forEach((expression, index) => {
    const before = text[index];
    const after = text[index + 1];
    if ((before === "" || /\s$/u.test(before)) && (after === "" || /^\s/u.test(after))) {
      tokens.push(...classTokens(expression));
    }
  });
  return tokens;
}

/** The element itself or any JSX ancestor in the same tree is a `<label>`. */
function insideLabel(opening) {
  for (let node = opening.parent; node; node = node.parent) {
    if (node.type === "JSXElement" && node.openingElement.name.type === "JSXIdentifier"
      && node.openingElement.name.name === "label") return true;
  }
  return false;
}
