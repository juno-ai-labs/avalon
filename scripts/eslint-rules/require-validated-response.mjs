/**
 * Require every route response body to pass its contract before it is serialized.
 *
 * A route that returns service output unvalidated has no failure mode of its
 * own: a malformed body leaves the Worker with a 200 and becomes a client-side
 * `invalid_response`, with nothing on the server to say which field was wrong or
 * that anything happened at all. The desktop client already parses every
 * response it receives, so without this the strict side of the contract is the
 * far side of the network.
 *
 * A value the route built itself out of literals is exempt — the route is its
 * own contract there, and there is no service output to check.
 */
export const requireValidatedResponseRule = {
  meta: {
    type: "problem",
    docs: { description: "Require route JSON responses to be parsed by a contract schema." },
    schema: [],
    messages: {
      unvalidated:
        "Route responses must pass a contract schema before serializing. Wrap this in `<Contract>Schema.parse(...)`, or build the body from literals if the route owns the shape.",
    },
  },
  create(context) {
    /** `{ ok: true }`, `{ challenge: "" }` — a body the route authored, not one a service returned. */
    function isLiteralShape(node) {
      if (!node) return false;
      switch (node.type) {
        case "Literal":
          return true;
        case "TemplateLiteral":
          return node.expressions.length === 0;
        case "UnaryExpression":
          return isLiteralShape(node.argument);
        case "ArrayExpression":
          return node.elements.every((element) => element === null || isLiteralShape(element));
        case "ObjectExpression":
          return node.properties.every((property) =>
            property.type === "Property" && !property.computed && isLiteralShape(property.value));
        default:
          return false;
      }
    }

    /** `SomethingSchema.parse(value)` — including `await` and a trailing `as` cast. */
    function isContractParse(node) {
      if (!node) return false;
      if (node.type === "AwaitExpression") return isContractParse(node.argument);
      if (node.type === "TSAsExpression" || node.type === "TSNonNullExpression") {
        return isContractParse(node.expression);
      }
      if (node.type === "CallExpression") {
        const callee = node.callee;
        return callee.type === "MemberExpression"
          && !callee.computed
          && callee.property.type === "Identifier"
          && (callee.property.name === "parse" || callee.property.name === "parseAsync");
      }
      return false;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression"
          || callee.computed
          || callee.property.type !== "Identifier"
          || callee.property.name !== "json"
          || callee.object.type !== "Identifier"
          || callee.object.name !== "c"
        ) return;
        const body = node.arguments[0];
        if (body === undefined || isContractParse(body) || isLiteralShape(body)) return;
        context.report({ node: body, messageId: "unvalidated" });
      },
    };
  },
};
