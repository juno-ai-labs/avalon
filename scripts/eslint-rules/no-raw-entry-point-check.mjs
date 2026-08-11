/**
 * Disallow deciding "am I the entry point?" by comparing `import.meta.url` to
 * `process.argv[1]`.
 *
 * The two hold the same file under different names: `argv` keeps the path as it
 * was written on the command line, while `import.meta.url` is always resolved
 * through symlinks. A script reached through a symlinked directory therefore
 * fails its own guard, runs nothing, and exits 0 in silence — which every
 * caller reads as success. macOS's `os.tmpdir()` is such a directory, so this
 * shipped as a green Linux CI and a broken macOS release job.
 *
 * The rule matches the comparison rather than any one spelling of it, because
 * the three variants in this repository differed only in spelling:
 * `fileURLToPath(import.meta.url) === process.argv[1]`,
 * `import.meta.url === \`file://${process.argv[1]}\``, and
 * `import.meta.url === pathToFileURL(argv[1]).href`. The last is right about
 * URL encoding and still wrong about symlinks, which is the point: the fix is
 * resolving both sides, not escaping one better.
 */
export const noRawEntryPointCheckRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require isEntryPoint() instead of comparing import.meta.url against process.argv[1].",
    },
    schema: [],
    messages: {
      raw:
        "process.argv[1] and import.meta.url spell the same file differently — argv keeps symlinks, import.meta.url resolves them — so this guard fails wherever the script is reached through a symlinked directory, such as anything under macOS's os.tmpdir(). Use isEntryPoint(import.meta.url) from scripts/entry-point.mjs.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        const sides = [node.left, node.right];
        const mentionsImportMeta = sides.some((side) => subtreeHas(side, isImportMeta));
        const mentionsArgvEntry = sides.some((side) => subtreeHas(side, isArgvEntry));
        if (mentionsImportMeta && mentionsArgvEntry) context.report({ node, messageId: "raw" });
      },
    };
  },
};

// `import.meta`, wherever it sits in the expression — bare, unwrapped by
// fileURLToPath, or read through `.url`.
function isImportMeta(node) {
  return node.type === "MetaProperty"
    && node.meta?.name === "import"
    && node.property?.name === "meta";
}

// `process.argv[1]` and the destructured `argv[1]`, which is the same read.
function isArgvEntry(node) {
  if (node.type !== "MemberExpression" || !node.computed) return false;
  if (node.property.type !== "Literal" || node.property.value !== 1) return false;
  const { object } = node;
  if (object.type === "Identifier") return object.name === "argv";
  return object.type === "MemberExpression"
    && !object.computed
    && object.property.type === "Identifier"
    && object.property.name === "argv";
}

// Whether any node in the subtree satisfies `predicate`. The comparison's
// operands are arbitrary expressions — a call, a template literal, a member
// chain — so matching only their top-level shape would miss most spellings.
function subtreeHas(node, predicate) {
  if (!node || typeof node.type !== "string") return false;
  if (predicate(node)) return true;
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      if (value.some((child) => subtreeHas(child, predicate))) return true;
    } else if (subtreeHas(value, predicate)) return true;
  }
  return false;
}
