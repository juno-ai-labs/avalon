const forbiddenMethods = new Set(["get", "put", "delete", "list", "transaction"]);

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

function referencesDurableStorageType(node) {
  const annotation = node?.typeAnnotation?.typeAnnotation;
  return annotation?.type === "TSTypeReference"
    && annotation.typeName.type === "Identifier"
    && annotation.typeName.name === "DurableObjectStorage";
}

/**
 * Durable Object state must be represented in explicit SQLite tables.
 *
 * A SQLite-backed Durable Object still exposes the legacy key-value API, so a
 * Wrangler `new_sqlite_class` declaration alone does not enforce the data
 * model. This rule rejects those KV calls while leaving SQL, alarms, and the
 * hibernating WebSocket APIs available. It tracks ordinary local aliases and
 * destructured method aliases so `const store = state.storage` cannot bypass
 * the boundary accidentally.
 */
export const durableObjectSqlStorageRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require explicit SQLite SQL for all Durable Object persistence.",
    },
    schema: [],
    messages: {
      kv: "Durable Objects persist through explicit SQLite tables only. Replace DurableObjectStorage.{{method}}() with storage.sql queries; alarms and hibernating WebSockets remain platform APIs.",
    },
  },
  create(context) {
    const storageAliases = new Set(["storage"]);
    const methodAliases = new Map();

    const isStorage = (candidate) => {
      const node = unwrap(candidate);
      if (!node) return false;
      if (node.type === "Identifier") return storageAliases.has(node.name);
      return node.type === "MemberExpression" && memberName(node) === "storage";
    };

    const rememberBinding = (id, init) => {
      if (!id) return;
      if (id.type === "Identifier") {
        if (isStorage(init) || referencesDurableStorageType(id)) storageAliases.add(id.name);
        return;
      }
      if (id.type !== "ObjectPattern" || !isStorage(init)) return;
      for (const property of id.properties) {
        if (property.type !== "Property") continue;
        const sourceName = property.computed
          ? property.key.type === "Literal" ? property.key.value : null
          : property.key.type === "Identifier" ? property.key.name : null;
        if (typeof sourceName !== "string" || !forbiddenMethods.has(sourceName)) continue;
        const local = property.value.type === "Identifier"
          ? property.value.name
          : property.value.type === "AssignmentPattern" && property.value.left.type === "Identifier"
            ? property.value.left.name
            : null;
        if (local) methodAliases.set(local, sourceName);
      }
    };

    return {
      VariableDeclarator(node) {
        rememberBinding(node.id, node.init);
      },
      AssignmentExpression(node) {
        rememberBinding(node.left, node.right);
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee?.type === "Identifier") {
          const method = methodAliases.get(callee.name);
          if (method) context.report({ node, messageId: "kv", data: { method } });
          return;
        }
        if (callee?.type !== "MemberExpression" || !isStorage(callee.object)) return;
        const method = memberName(callee);
        if (!method || !forbiddenMethods.has(method)) return;
        context.report({ node, messageId: "kv", data: { method } });
      },
    };
  },
};
