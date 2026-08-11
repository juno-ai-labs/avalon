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

    /**
     * The identifier a member chain is rooted at — `PageSchema` in
     * `PageSchema.shape.items.parse`, `JSON` in `JSON.parse`.
     */
    function chainRoot(node) {
      let current = node;
      while (current?.type === "MemberExpression" && !current.computed) current = current.object;
      return current?.type === "Identifier" ? current.name : null;
    }

    /**
     * `SomethingSchema.parse(value)` — including `await` and a trailing cast.
     *
     * The chain has to be rooted at a `*Schema`, not merely end in `.parse`.
     * Without that, `JSON.parse(...)` satisfies the rule, which would leave the
     * rule passing on exactly the response it exists to catch.
     */
    function isContractParse(node) {
      if (!node) return false;
      if (node.type === "AwaitExpression") return isContractParse(node.argument);
      if (node.type === "TSAsExpression" || node.type === "TSNonNullExpression") {
        return isContractParse(node.expression);
      }
      if (node.type !== "CallExpression") return false;
      const callee = node.callee;
      if (
        callee.type !== "MemberExpression"
        || callee.computed
        || callee.property.type !== "Identifier"
        || (callee.property.name !== "parse" && callee.property.name !== "parseAsync")
      ) return false;
      const root = chainRoot(callee.object);
      return root !== null && /Schema$/u.test(root);
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression"
          || callee.computed
          || callee.property.type !== "Identifier"
          || callee.property.name !== "json"
          // Any identifier, not just `c`: the Hono context is named `context` in
          // several handlers, and a rule that only recognised one spelling would
          // hold by naming convention rather than by checking anything.
          // `await response.json()` is not caught by this, because reading a
          // body takes no argument and the arity check below returns first.
          || callee.object.type !== "Identifier"
        ) return;
        const body = node.arguments[0];
        if (body === undefined || isContractParse(body) || isLiteralShape(body)) return;
        context.report({ node: body, messageId: "unvalidated" });
      },
    };
  },
};
