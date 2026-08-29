function unwrap(node) {
  let current = node;
  while (["ChainExpression", "TSAsExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(current?.type)) {
    current = current.expression;
  }
  return current;
}

function memberName(node) {
  const member = unwrap(node);
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

// A callback that is not written `async` can still hand the boundary a Promise —
// a reference to an async function, or an arrow that returns one — and only the
// callee's own signature says so. That answer needs a TypeScript program, which
// `eslint.config.mjs` arranges for `apps/api/src` alone because opening one is
// the single largest cost in a lint run.
//
// Throw rather than return `false` when it is missing. Degrading quietly would
// leave this rule reporting nothing on files nobody meant to exempt, and a guard
// that passes everything looks exactly like a guard that found nothing wrong.
function returnsPromise(parserServices, callback) {
  const program = parserServices?.program;
  const nodeMap = parserServices?.esTreeNodeToTSNodeMap;
  if (!program || !nodeMap) {
    throw new Error(
      "rally/durable-object-sync-transaction needs type information. Widen the "
      + "`projectService` block in eslint.config.mjs to cover the files this rule "
      + "is enabled on.",
    );
  }

  const checker = program.getTypeChecker();
  const tsCallback = nodeMap.get(callback);
  if (!tsCallback) return false;
  const callbackType = checker.getTypeAtLocation(tsCallback);

  const typeCanBePromise = (type) => {
    if (checker.getPromisedTypeOfPromise(type)) return true;
    return typeof type.isUnionOrIntersection === "function"
      && type.isUnionOrIntersection()
      && type.types.some(typeCanBePromise);
  };

  return callbackType.getCallSignatures().some((signature) => typeCanBePromise(
    checker.getReturnTypeOfSignature(signature),
  ));
}

const synchronousBoundaries = new Set([
  "transactionSync",
  "commitRuntimeMutation",
  "commitWithRegionalEffects",
]);

/** Keep asynchronous preparation outside every synchronous DO transaction boundary. */
export const durableObjectSyncTransactionRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid Promise-returning callbacks at synchronous Durable Object transaction boundaries.",
    },
    schema: [],
    messages: {
      promise: "{{boundary}} requires a callback that completes synchronously. Prepare asynchronous data before entering the transaction, then commit only synchronous SQLite work inside it.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const boundary = memberName(node.callee);
        if (!boundary || !synchronousBoundaries.has(boundary)) return;
        const callback = unwrap(node.arguments[0]);
        if (!callback || callback.type === "SpreadElement") return;

        const syntacticallyAsync = (
          callback.type === "ArrowFunctionExpression"
          || callback.type === "FunctionExpression"
        ) && callback.async;
        if (!syntacticallyAsync && !returnsPromise(context.sourceCode.parserServices, callback)) return;

        context.report({ node: callback, messageId: "promise", data: { boundary } });
      },
    };
  },
};
