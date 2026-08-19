function constantInitializer(context, node, seen) {
  if (node?.type !== "Identifier" || seen.has(node.name)) return node;
  seen.add(node.name);
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    const definition = variable?.defs.length === 1 ? variable.defs[0] : null;
    if (definition?.type === "Variable"
      && definition.parent.kind === "const"
      && definition.node.init) {
      return constantInitializer(context, definition.node.init, seen);
    }
    scope = scope.upper;
  }
  return node;
}

function literalString(context, node, seen = new Set()) {
  const resolved = constantInitializer(context, node, seen);
  if (resolved !== node) return literalString(context, resolved, seen);
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function requestedUrl(context, node, seen = new Set()) {
  const resolved = constantInitializer(context, node, seen);
  if (resolved !== node) return requestedUrl(context, resolved, seen);
  const direct = literalString(context, node, seen);
  if (direct !== null) return direct;
  if (node?.type !== "NewExpression" || node.callee.type !== "Identifier" || node.callee.name !== "Request") {
    return null;
  }
  return requestedUrl(context, node.arguments[0], seen);
}

function unwrap(node) {
  let current = node;
  while (["AwaitExpression", "ChainExpression", "TSAsExpression", "TSNonNullExpression", "TSTypeAssertion"].includes(current?.type)) {
    current = current.argument ?? current.expression;
  }
  return current;
}

function referencesStubType(node) {
  const annotation = node?.typeAnnotation?.typeAnnotation;
  return annotation?.type === "TSTypeReference"
    && annotation.typeName.type === "Identifier"
    && annotation.typeName.name === "DurableObjectStub";
}

/** Internal DO calls use typed RPC; fetch is reserved for HTTP/WebSocket flows. */
export const durableObjectNativeRpcRule = {
  meta: {
    type: "problem",
    docs: { description: "Require typed native RPC for internal Durable Object calls." },
    schema: [],
    messages: {
      internalFetch: "Call a typed Durable Object RPC method instead of fetch() for an /internal endpoint. Keep fetch() only for HTTP and WebSocket upgrade flows.",
    },
  },
  create(context) {
    const stubAliases = new Set();
    const isStubExpression = (candidate) => {
      const node = unwrap(candidate);
      if (!node) return false;
      if (node.type === "Identifier") return stubAliases.has(node.name);
      if (node.type !== "CallExpression") return false;
      const callee = unwrap(node.callee);
      return callee?.type === "Identifier"
        && [
          "durableObjectStubForRegion",
          "durableObjectStubForRegionalSingleton",
          "durableObjectStubForWorkspace",
        ].includes(callee.name);
    };
    const rememberStub = (target, value) => {
      if (target?.type !== "Identifier") return;
      if (referencesStubType(target) || isStubExpression(value)) stubAliases.add(target.name);
    };
    return {
      VariableDeclarator(node) {
        rememberStub(node.id, node.init);
      },
      AssignmentExpression(node) {
        rememberStub(node.left, node.right);
      },
      FunctionDeclaration(node) {
        for (const parameter of node.params) rememberStub(parameter, null);
      },
      FunctionExpression(node) {
        for (const parameter of node.params) rememberStub(parameter, null);
      },
      ArrowFunctionExpression(node) {
        for (const parameter of node.params) rememberStub(parameter, null);
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const property = node.callee.property;
        const method = node.callee.computed
          ? property.type === "Literal" ? property.value : null
          : property.type === "Identifier" ? property.name : null;
        if (method !== "fetch") return;
        if (!isStubExpression(node.callee.object)) return;
        const url = requestedUrl(context, node.arguments[0]);
        if (url?.includes("/internal")) context.report({ node, messageId: "internalFetch" });
      },
    };
  },
};
