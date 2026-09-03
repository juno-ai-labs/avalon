const durableObjectBindings = new Set([
  "CRASH_SYMBOLICATOR",
  "SUBSTREAM_AGENTS",
  "AUTOMATION_AGENTS",
  "WORKSPACE_DOS",
  "WORKSPACE_SCHEDULERS",
  "WORKSTREAM_DOS",
  "ARTIFACT_HOSTS",
]);

const namespaceMethods = new Set([
  "get",
  "getByName",
  "idFromName",
  "idFromString",
  "jurisdiction",
  "newUniqueId",
]);

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

function referencesNamespaceType(node) {
  const annotation = node?.typeAnnotation?.typeAnnotation;
  return annotation?.type === "TSTypeReference"
    && annotation.typeName.type === "Identifier"
    && annotation.typeName.name === "DurableObjectNamespace";
}

/**
 * Product Durable Object placement is a single architectural boundary.
 *
 * Cloudflare considers a location hint only on an object's first `get()`, and
 * derives different IDs for the same name in unrestricted, US, and EU
 * namespaces. This rule prevents any source module from constructing an ID or
 * stub outside the workspace-affinity or regional-singleton resolvers,
 * including through ordinary aliases and destructured methods. The resolver
 * module itself is excluded in the flat ESLint configuration.
 */
export const durableObjectRegionRoutingRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require jurisdiction-locked, location-hinted Durable Object resolution.",
    },
    schema: [],
    messages: {
      bypass: "Resolve Avalon Durable Objects through durableObjectStubForWorkspace(), durableObjectStubForRegionalSingleton(), or durableObjectStubForArtifact(). Direct {{method}} routing can bypass the US/EU jurisdiction lock or the workspace's immutable first-placement affinity.",
    },
  },
  create(context) {
    const namespaceAliases = new Set();
    const methodAliases = new Map();

    const isNamespace = (candidate) => {
      const node = unwrap(candidate);
      if (!node) return false;
      if (node.type === "Identifier") return namespaceAliases.has(node.name);
      if (node.type === "MemberExpression") {
        return durableObjectBindings.has(memberName(node) ?? "");
      }
      if (node.type !== "CallExpression") return false;
      const callee = unwrap(node.callee);
      return callee?.type === "MemberExpression"
        && memberName(callee) === "jurisdiction"
        && isNamespace(callee.object);
    };

    const rememberBinding = (id, init) => {
      if (!id) return;
      if (id.type === "Identifier") {
        if (isNamespace(init) || referencesNamespaceType(id)) namespaceAliases.add(id.name);
        return;
      }
      if (id.type !== "ObjectPattern") return;
      for (const property of id.properties) {
        if (property.type !== "Property") continue;
        const sourceName = property.computed
          ? property.key.type === "Literal" ? property.key.value : null
          : property.key.type === "Identifier" ? property.key.name : null;
        const local = property.value.type === "Identifier"
          ? property.value.name
          : property.value.type === "AssignmentPattern" && property.value.left.type === "Identifier"
            ? property.value.left.name
            : null;
        if (!local || typeof sourceName !== "string") continue;
        if (durableObjectBindings.has(sourceName)) {
          namespaceAliases.add(local);
        } else if (isNamespace(init) && namespaceMethods.has(sourceName)) {
          methodAliases.set(local, sourceName);
        }
      }
    };

    const rememberParameters = (parameters) => {
      for (const parameter of parameters) {
        const node = parameter.type === "AssignmentPattern" ? parameter.left : parameter;
        rememberBinding(node, null);
      }
    };

    return {
      VariableDeclarator(node) {
        rememberBinding(node.id, node.init);
      },
      AssignmentExpression(node) {
        rememberBinding(node.left, node.right);
      },
      FunctionDeclaration(node) {
        rememberParameters(node.params);
      },
      FunctionExpression(node) {
        rememberParameters(node.params);
      },
      ArrowFunctionExpression(node) {
        rememberParameters(node.params);
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee?.type === "Identifier") {
          if (callee.name === "durableObjectStubForRegion") {
            context.report({ node, messageId: "bypass", data: { method: callee.name } });
            return;
          }
          const method = methodAliases.get(callee.name);
          if (method) context.report({ node, messageId: "bypass", data: { method } });
          return;
        }
        if (callee?.type !== "MemberExpression" || !isNamespace(callee.object)) return;
        const method = memberName(callee);
        if (!method || !namespaceMethods.has(method)) return;
        context.report({ node, messageId: "bypass", data: { method } });
      },
    };
  },
};
