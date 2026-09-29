import { readFileSync } from "node:fs";
import tseslint from "typescript-eslint";

/**
 * No Durable Object may name a WorkspaceDO table on its own regional binding.
 *
 * A service is constructed with `withWorkspaceRuntimeDatabase(env, workspaceId)`
 * and its `DB` is the router. A Durable Object is handed the raw environment and
 * nothing wraps it, so `this.env.DB` there is regional D1, which since migration
 * 0090 retired the product tables does not have them. The statement fails as
 * `no such table`, which is not one of an object's snake_case codes, so it
 * reaches the caller as `500 internal_error` with the table name discarded.
 *
 * That shipped three times, each found by a person in production:
 * `slackUserIsLinked` joining `slack_user_links`, the origin-label read of
 * `automation_directory`, and the automation object resolving a delivery
 * destination through `connector_connections`.
 *
 * The table list is read from `WORKSPACE_LOCAL_TABLES` in the TypeScript module
 * that routes by it, not copied here: a copy drifts exactly when a table is
 * added, which is when the guard matters. The read follows a spread of an
 * imported `as const` array into its own module, and throws on any element it
 * cannot resolve to a string, so a change to the list's shape stops lint
 * rather than shrinking the list the rule enforces.
 *
 * The ESLint cache does not see that list: run `pnpm lint:fresh` after changing it
 * (docs/dev-environment.md#quality-gate-caches).
 */

const LIST_MODULE = new URL("../../apps/api/src/services/workspace-runtime-database.ts", import.meta.url);
const LIST_NAME = "WORKSPACE_LOCAL_TABLES";

function parseModule(url) {
  return tseslint.parser.parseForESLint(readFileSync(url, "utf8"), {
    sourceType: "module",
    ecmaVersion: "latest",
    filePath: url.pathname,
  }).ast;
}

function unwrap(node) {
  let current = node;
  while (["ChainExpression", "TSAsExpression", "TSNonNullExpression", "TSTypeAssertion", "TSSatisfiesExpression"]
    .includes(current?.type)) {
    current = current.expression;
  }
  return current;
}

function exportedArray(program, name, url) {
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : null;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier" || declarator.id.name !== name) continue;
      const init = unwrap(declarator.init);
      if (init?.type === "ArrayExpression") return init;
      throw new Error(`${name} in ${url.pathname} is no longer an array literal; update ${import.meta.url}.`);
    }
  }
  throw new Error(`${name} is no longer exported from ${url.pathname}; update ${import.meta.url}.`);
}

function importedFrom(program, localName, url) {
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.local.name !== localName) continue;
      const importedName = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
      return { url: new URL(`${statement.source.value}.ts`, url), name: importedName };
    }
  }
  throw new Error(`${localName}, spread into a table list in ${url.pathname}, is not a named import there.`);
}

function tablesOf(url, name) {
  const program = parseModule(url);
  return exportedArray(program, name, url).elements.flatMap((element) => {
    if (element?.type === "Literal" && typeof element.value === "string") return [element.value];
    if (element?.type === "SpreadElement" && element.argument.type === "Identifier") {
      const source = importedFrom(program, element.argument.name, url);
      return tablesOf(source.url, source.name);
    }
    throw new Error(`${name} in ${url.pathname} holds an element this rule cannot read; update ${import.meta.url}.`);
  });
}

let tablePatterns = null;

/** The same whole-identifier test the runtime router applies to a statement. */
function workspaceTablePatterns() {
  tablePatterns ??= tablesOf(LIST_MODULE, LIST_NAME)
    .map((table) => ({ table, pattern: new RegExp(`\\b${table}\\b`, "iu") }));
  return tablePatterns;
}

/** `this.env.DB`, through optional chaining and non-null assertions. */
function isRegionalBinding(node) {
  const db = unwrap(node);
  if (db?.type !== "MemberExpression" || db.computed || db.property.name !== "DB") return false;
  const env = unwrap(db.object);
  return env?.type === "MemberExpression" && !env.computed && env.property.name === "env"
    && unwrap(env.object)?.type === "ThisExpression";
}

/** The literal SQL text of a statement argument; interpolations read as a space. */
function literalText(node) {
  const argument = unwrap(node);
  if (argument?.type === "Literal") return typeof argument.value === "string" ? argument.value : " ";
  if (argument?.type === "TemplateLiteral") return argument.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ");
  if (argument?.type === "BinaryExpression" && argument.operator === "+") {
    return `${literalText(argument.left)} ${literalText(argument.right)}`;
  }
  return " ";
}

export const durableObjectWorkspaceTableRoutingRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid naming a WorkspaceDO-local table in a statement sent to a Durable Object's regional this.env.DB.",
    },
    schema: [],
    messages: {
      misrouted: "`{{table}}` lives in WorkspaceDO, not regional D1: this.env.DB here answers `no such table` and the caller gets a 500. Route the query through the object that owns the table: from another object, a typed WorkspaceDO method or withWorkspaceRuntimeDatabase(env, workspaceId); inside WorkspaceDO itself, its own storage (runWorkspaceSql or localWorkspaceEnv), because withWorkspaceRuntimeDatabase without the local executor calls the object back.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee?.type !== "MemberExpression" || callee.computed) return;
        if (!["prepare", "exec"].includes(callee.property.name) || !isRegionalBinding(callee.object)) return;
        const sql = literalText(node.arguments[0]);
        for (const { table, pattern } of workspaceTablePatterns()) {
          if (pattern.test(sql)) context.report({ node, messageId: "misrouted", data: { table } });
        }
      },
    };
  },
};
