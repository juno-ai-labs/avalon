const DEFAULT_LIMITS = {
  maxArrayExpansion: 64,
  maxConstraints: 10,
  maxDepth: 10,
  maxNodes: 80,
};

const CONSTRAINT_KEYS = new Set([
  "contains",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

function propertyName(property) {
  if (property.computed || property.type !== "Property") return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
  return null;
}

function unwrap(node) {
  if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node?.type)) {
    return unwrap(node.expression);
  }
  return node;
}

function staticValue(node) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (value.type === "Literal") return value.value;
  if (value.type === "ArrayExpression") {
    const items = [];
    for (const element of value.elements) {
      if (!element || element.type === "SpreadElement") return undefined;
      const item = staticValue(element);
      if (item === undefined) return undefined;
      items.push(item);
    }
    return items;
  }
  if (value.type !== "ObjectExpression") return undefined;
  const output = {};
  for (const property of value.properties) {
    const key = propertyName(property);
    if (key === null || property.type !== "Property" || property.kind !== "init") return undefined;
    const child = staticValue(property.value);
    if (child === undefined) return undefined;
    output[key] = child;
  }
  return output;
}

function schemaTypeIncludes(schema, expected) {
  return schema.type === expected || (Array.isArray(schema.type) && schema.type.includes(expected));
}

export function measureProviderJsonSchema(schema) {
  const metrics = { arrayExpansion: 1, constraints: 0, depth: 0, nodes: 0 };

  function visit(candidate, depth, parentArrayExpansion) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    metrics.depth = Math.max(metrics.depth, depth);
    metrics.nodes += 1;
    metrics.constraints += Object.keys(candidate).filter((key) => CONSTRAINT_KEYS.has(key)).length;

    const ownArrayExpansion = schemaTypeIncludes(candidate, "array") && Number.isInteger(candidate.maxItems)
      ? parentArrayExpansion * Math.max(1, candidate.maxItems)
      : parentArrayExpansion;
    metrics.arrayExpansion = Math.max(metrics.arrayExpansion, ownArrayExpansion);

    for (const collectionKey of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]) {
      const collection = candidate[collectionKey];
      if (!collection || typeof collection !== "object" || Array.isArray(collection)) continue;
      for (const child of Object.values(collection)) visit(child, depth + 1, ownArrayExpansion);
    }
    for (const childKey of ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames"]) {
      visit(candidate[childKey], depth + 1, ownArrayExpansion);
    }
    for (const collectionKey of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const collection = candidate[collectionKey];
      if (!Array.isArray(collection)) continue;
      for (const child of collection) visit(child, depth + 1, ownArrayExpansion);
    }
  }

  visit(schema, 1, 1);
  return metrics;
}

export const providerJsonSchemaComplexityRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep model-facing JSON Schemas within a portable constrained-decoding budget.",
    },
    schema: [{
      type: "object",
      additionalProperties: false,
      properties: {
        maxArrayExpansion: { type: "integer", minimum: 1 },
        maxConstraints: { type: "integer", minimum: 0 },
        maxDepth: { type: "integer", minimum: 1 },
        maxNodes: { type: "integer", minimum: 1 },
      },
    }],
    messages: {
      tooComplex: "Model-facing JSON Schema exceeds the portable complexity budget: {{failures}}. Keep the provider schema structural and enforce detailed bounds after generation.",
    },
  },
  create(context) {
    const declarations = new Map();
    const references = [];

    return {
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && node.init) declarations.set(node.id.name, node.init);
      },
      Property(node) {
        if (propertyName(node) === "jsonSchema") references.push(node);
      },
      "Program:exit"() {
        const configured = context.options[0] ?? {};
        const limits = { ...DEFAULT_LIMITS, ...configured };
        for (const reference of references) {
          const rawValue = unwrap(reference.value);
          const schemaNode = rawValue?.type === "Identifier" ? declarations.get(rawValue.name) : rawValue;
          const schema = staticValue(schemaNode);
          if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;
          const metrics = measureProviderJsonSchema(schema);
          const failures = [];
          if (metrics.depth > limits.maxDepth) failures.push(`depth ${metrics.depth} > ${limits.maxDepth}`);
          if (metrics.nodes > limits.maxNodes) failures.push(`nodes ${metrics.nodes} > ${limits.maxNodes}`);
          if (metrics.constraints > limits.maxConstraints) failures.push(`constraints ${metrics.constraints} > ${limits.maxConstraints}`);
          if (metrics.arrayExpansion > limits.maxArrayExpansion) {
            failures.push(`nested bounded-array expansion ${metrics.arrayExpansion} > ${limits.maxArrayExpansion}`);
          }
          if (failures.length > 0) {
            context.report({ node: reference, messageId: "tooComplex", data: { failures: failures.join(", ") } });
          }
        }
      },
    };
  },
};
