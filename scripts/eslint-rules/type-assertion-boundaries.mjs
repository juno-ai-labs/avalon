function isUnknownAssertion(node) {
  return node?.type === "TSAsExpression" && node.typeAnnotation.type === "TSUnknownKeyword";
}

/** Production code may narrow or parse, but may not erase a type before asserting another. */
export const noProductionDoubleAssertionRule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid `as unknown as` in production code." },
    schema: [],
    messages: {
      double: "Do not erase a production value with `as unknown as`. Parse the runtime boundary or convert it to the target shape explicitly.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (!isUnknownAssertion(node.expression)) return;
        context.report({ node, messageId: "double" });
      },
    };
  },
};

function rootTypeNames(node, names = new Set()) {
  if (!node) return names;
  switch (node.type) {
    case "Identifier":
      names.add(node.name);
      break;
    case "TSQualifiedName":
      rootTypeNames(node.left, names);
      break;
    case "TSTypeReference":
      rootTypeNames(node.typeName, names);
      for (const parameter of node.typeArguments?.params ?? []) rootTypeNames(parameter, names);
      break;
    case "TSIndexedAccessType":
      rootTypeNames(node.objectType, names);
      break;
    case "TSTypeQuery":
      rootTypeNames(node.exprName, names);
      break;
    case "TSArrayType":
      rootTypeNames(node.elementType, names);
      break;
    case "TSUnionType":
    case "TSIntersectionType":
      for (const type of node.types) rootTypeNames(type, names);
      break;
    default:
      break;
  }
  return names;
}

function isApplicationImport(source) {
  return (source.startsWith(".") || source.startsWith("@rally/"))
    && !source.includes("/helpers/")
    && !source.startsWith("./helpers/");
}

/** Application test doubles prove the smallest consumed contract with `satisfies`. */
export const noApplicationContractTestCastRule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid assertions past application-owned contracts in tests." },
    schema: [],
    messages: {
      cast: "Do not cast a fixture or test double to an application contract. Type the production dependency as its smallest capability and make the test value `satisfies` that capability.",
    },
  },
  create(context) {
    const applicationBindings = new Set();

    return {
      ImportDeclaration(node) {
        if (!isApplicationImport(String(node.source.value))) return;
        for (const specifier of node.specifiers) applicationBindings.add(specifier.local.name);
      },
      TSAsExpression(node) {
        if (!isUnknownAssertion(node.expression)) return;
        const names = rootTypeNames(node.typeAnnotation);
        const applicationContract = [...names].some((name) => applicationBindings.has(name));
        const desktopGlobal = node.typeAnnotation.type === "TSTypeQuery"
          && node.typeAnnotation.exprName.type === "TSQualifiedName"
          && node.typeAnnotation.exprName.left.type === "Identifier"
          && node.typeAnnotation.exprName.left.name === "window";
        if (!applicationContract && !desktopGlobal) return;
        context.report({ node, messageId: "cast" });
      },
    };
  },
};

const cloudflareTypes = new Set([
  "Ai",
  "D1Database",
  "D1PreparedStatement",
  "D1Result",
  "DurableObjectNamespace",
  "DurableObjectState",
  "DurableObjectStorage",
  "Env",
  "Flagship",
  "ImagesBinding",
  "Queue",
  "R2Bucket",
]);

function assertedTypeName(node) {
  if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") return node.typeName.name;
  if (
    node.type === "TSArrayType"
    && node.elementType.type === "TSTypeReference"
    && node.elementType.typeName.type === "Identifier"
  ) return node.elementType.typeName.name;
  return null;
}

/** Cloudflare's complete runtime interfaces are asserted only by typed test builders. */
export const noDirectCloudflareTestCastRule = {
  meta: {
    type: "problem",
    docs: { description: "Centralize partial Cloudflare runtime test doubles." },
    schema: [],
    messages: {
      cast: "Build partial Cloudflare runtime values through the typed helpers in test/helpers/cloudflare-test; direct casts hide binding drift.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        const name = assertedTypeName(node.typeAnnotation);
        if (!name || !cloudflareTypes.has(name)) return;
        context.report({ node, messageId: "cast" });
      },
    };
  },
};
