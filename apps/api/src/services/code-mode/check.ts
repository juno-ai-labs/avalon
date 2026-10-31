/**
 * The pre-run check of a program: a parse and a walk, before any isolate is
 * loaded and before any call is made. It is best effort and static. It cannot
 * tell what a program will do; it refuses the shapes in which a write's
 * outcome is unknowable to the program or unrepeatable on a re-run, each of
 * which the gateway would otherwise meet at run time with a write already
 * made. A program that passes can still fail; one that is refused has written
 * nothing, and the refusal names the line.
 *
 * What it looks for, and why each is a write problem:
 *
 * - A write not awaited where it is called: the program goes on without
 *   knowing whether the write happened, and may return before it settles.
 * - A write inside `try`/`catch`/`finally`: a caught failure hides the
 *   outcome, and a `catch` is where a retry is written.
 * - A write inside `Promise.all` and the like: the writes serialize in the
 *   gateway, but a failure of one does not stop the next from being
 *   dispatched.
 * - A write inside a `map`/`forEach` callback: the same, by another route,
 *   with the promises dropped or gathered after the fact.
 * - `Date.now()`, `new Date()`, `Math.random()` and the like in a program that
 *   writes: a re-run replays a nested call by its input hash, so a write whose
 *   input came from the clock or a random number cannot be matched and is
 *   made again.
 *
 * Only the direct `tools.<plugin>.<tool>(...)` shape is recognized as a call.
 * An alias (`const t = tools.x`) or a computed name is not followed; the
 * gateway still governs it at run time. The parser is acorn, which runs on
 * workerd; the wrapper around the body is the one `wrapProgram` writes, so the
 * check parses what the isolate would compile.
 */

import { parse, type Node, type Program } from "acorn";
import { wrapProgram } from "./entry-module";

export type ProgramIssueCode =
  | "syntax_error"
  | "write_not_awaited"
  | "write_in_try"
  | "write_in_parallel"
  | "write_in_callback"
  | "write_with_clock_or_random";

export interface ProgramIssue {
  code: ProgramIssueCode;
  /** One-based line in the program body as the model wrote it. */
  line: number;
  /** One-based column. */
  column: number;
  /** The sentence the model reads: where, what, and the shape that passes. */
  message: string;
}

export interface CheckProgramOptions {
  /** `<plugin model id>.<tool name>` of every callable tool whose mode is `write`. */
  writeTools: ReadonlySet<string>;
}

/** The wrapper puts the body on its own lines after one line of its own. */
const WRAPPER_LINES_BEFORE_BODY = 1;

const PARALLEL_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
const ITERATION_CALLBACKS = new Set(["map", "forEach", "flatMap", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "reduce", "reduceRight", "sort"]);

type AnyNode = Node & Record<string, unknown>;

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function identifierName(node: unknown): string | null {
  return isNode(node) && node.type === "Identifier" ? (node.name as string) : null;
}

/** `tools.<plugin>.<tool>` as its two names, or null for any other callee. */
function toolCallee(callee: unknown): { plugin: string; tool: string } | null {
  if (!isNode(callee) || callee.type !== "MemberExpression" || callee.computed) return null;
  const tool = identifierName(callee.property);
  const inner = callee.object;
  if (tool === null || !isNode(inner) || inner.type !== "MemberExpression" || inner.computed) return null;
  const plugin = identifierName(inner.property);
  if (plugin === null || identifierName(inner.object) !== "tools") return null;
  return { plugin, tool };
}

/** `<object>.<property>` of a non-computed member callee, or null. */
function memberCallee(callee: unknown): { object: string | null; property: string } | null {
  if (!isNode(callee) || callee.type !== "MemberExpression" || callee.computed) return null;
  const property = identifierName(callee.property);
  return property === null ? null : { object: identifierName(callee.object), property };
}

function isFunction(node: AnyNode): boolean {
  return node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration";
}

function location(node: AnyNode): { line: number; column: number } {
  const loc = node.loc as { start: { line: number; column: number } } | undefined;
  return { line: (loc?.start.line ?? WRAPPER_LINES_BEFORE_BODY + 1) - WRAPPER_LINES_BEFORE_BODY, column: (loc?.start.column ?? 0) + 1 };
}

function issue(code: ProgramIssueCode, node: AnyNode, text: string): ProgramIssue {
  const { line, column } = location(node);
  return { code, line, column, message: `Line ${line}: ${text}` };
}

/**
 * Walk every node with its ancestors, nearest first. Acorn's nodes are plain
 * objects whose child nodes sit in properties or arrays of them; this visits
 * each once and never follows `loc`, which has no `type`.
 */
function walk(root: Program, visit: (node: AnyNode, ancestors: readonly AnyNode[]) => void): void {
  const stack: AnyNode[] = [];
  const step = (node: AnyNode): void => {
    visit(node, stack);
    stack.unshift(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) step(item);
      } else if (isNode(value)) {
        step(value);
      }
    }
    stack.shift();
  };
  if (isNode(root)) step(root);
}

/**
 * The shape a write sits in, judged from its ancestors nearest first. One
 * answer per call site, the most specific: a write inside a `map` callback
 * is also not awaited, and the callback is what to change.
 */
type WriteShape = "write_not_awaited" | "write_in_try" | "write_in_parallel" | "write_in_callback";

function writeShape(ancestors: readonly AnyNode[]): WriteShape | null {
  const parent = ancestors[0];
  for (let depth = 0; depth < ancestors.length; depth += 1) {
    const node = ancestors[depth]!;
    const above = ancestors[depth + 1];
    if (isFunction(node) && node.type !== "FunctionDeclaration" && above?.type === "CallExpression" && (above.arguments as unknown[]).includes(node)) {
      const callee = memberCallee(above.callee);
      if (callee && ITERATION_CALLBACKS.has(callee.property)) return "write_in_callback";
    }
    if (node.type === "ArrayExpression" && above?.type === "CallExpression") {
      const callee = memberCallee(above.callee);
      if (callee && callee.object === "Promise" && PARALLEL_COMBINATORS.has(callee.property)) return "write_in_parallel";
    }
    if (node.type === "TryStatement") return "write_in_try";
    // The wrapper's own function is the body's boundary; nothing above it is the program's.
    if (node.type === "FunctionDeclaration" && above?.type === "ExportDefaultDeclaration") break;
  }
  if (parent?.type === "AwaitExpression" || parent?.type === "ReturnStatement") return null;
  return "write_not_awaited";
}

function writeIssue(code: WriteShape, node: AnyNode, label: string, ancestors: readonly AnyNode[]): ProgramIssue {
  switch (code) {
    case "write_in_callback": {
      const method = nearestIterationMethod(ancestors) ?? "map";
      return issue(code, node, `${label} is a write called inside a ${method}() callback, where its promise is not awaited in order. Write in a for...of loop with await, so each write finishes before the next starts.`);
    }
    case "write_in_parallel":
      return issue(code, node, `${label} is a write inside Promise.all() or a similar combinator. Writes run one at a time; call it with await, in sequence, so a failure stops before the next write.`);
    case "write_in_try":
      return issue(code, node, `${label} is a write inside try/catch/finally. A caught write failure hides whether the write happened; let the failure end the program and read the writes it names.`);
    case "write_not_awaited":
      return issue(code, node, `${label} is a write that is not awaited where it is called. Put await in front of it, so the program knows whether it happened before going on.`);
  }
}

function nearestIterationMethod(ancestors: readonly AnyNode[]): string | null {
  for (let depth = 0; depth < ancestors.length; depth += 1) {
    const node = ancestors[depth]!;
    const above = ancestors[depth + 1];
    if (isFunction(node) && above?.type === "CallExpression") {
      const callee = memberCallee(above.callee);
      if (callee && ITERATION_CALLBACKS.has(callee.property)) return callee.property;
    }
  }
  return null;
}

/** `Date.now()`, `new Date()` with no argument, `Math.random()`, `crypto.randomUUID()`, `crypto.getRandomValues()`, `performance.now()`. */
function clockOrRandom(node: AnyNode): string | null {
  if (node.type === "NewExpression" && identifierName(node.callee) === "Date" && (node.arguments as unknown[]).length === 0) return "new Date()";
  if (node.type !== "CallExpression") return null;
  const callee = memberCallee(node.callee);
  if (!callee || callee.object === null) return null;
  const name = `${callee.object}.${callee.property}`;
  return name === "Date.now" || name === "Math.random" || name === "crypto.randomUUID" || name === "crypto.getRandomValues" || name === "performance.now"
    ? `${name}()`
    : null;
}

/**
 * Check a program body before it runs. Returns the issues in source order;
 * an empty array is a program the isolate may load. A body that does not
 * parse yields one `syntax_error` and nothing else, since there is no tree
 * to walk.
 */
export function checkProgram(code: string, options: CheckProgramOptions): ProgramIssue[] {
  let tree: Program;
  try {
    tree = parse(wrapProgram(code), { ecmaVersion: 2023, sourceType: "module", locations: true });
  } catch (error) {
    const raw = error as { message?: unknown; loc?: { line: number; column: number } };
    const message = typeof raw.message === "string" ? raw.message.replace(/\s*\(\d+:\d+\)$/u, "") : "The program does not parse";
    const line = Math.max(1, (raw.loc?.line ?? WRAPPER_LINES_BEFORE_BODY + 1) - WRAPPER_LINES_BEFORE_BODY);
    const column = (raw.loc?.column ?? 0) + 1;
    return [{ code: "syntax_error", line, column, message: `Line ${line}, column ${column}: ${message}.` }];
  }
  const issues: ProgramIssue[] = [];
  const nondeterministic: Array<{ node: AnyNode; what: string }> = [];
  let writes = 0;
  walk(tree, (node, ancestors) => {
    if (node.type === "CallExpression") {
      const callee = toolCallee(node.callee);
      if (callee && options.writeTools.has(`${callee.plugin}.${callee.tool}`)) {
        writes += 1;
        const label = `${callee.plugin}.${callee.tool}`;
        const shape = writeShape(ancestors);
        if (shape !== null) issues.push(writeIssue(shape, node, label, ancestors));
        return;
      }
    }
    const what = clockOrRandom(node);
    if (what !== null) nondeterministic.push({ node, what });
  });
  if (writes > 0) {
    for (const { node, what } of nondeterministic) {
      issues.push(issue("write_with_clock_or_random", node, `${what} in a program that writes. A re-run cannot match a write whose input changed, so take the time from the time tool's result and use no random values.`));
    }
  }
  return issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The `<plugin>.<tool>` keys `checkProgram` treats as writes, from the callable set. */
export function writeToolKeys(callable: ReadonlyArray<{ plugin: { modelId: string }; tools: ReadonlyArray<{ definition: { name: string; mode: string } }> }>): Set<string> {
  const keys = new Set<string>();
  for (const { plugin, tools } of callable) {
    for (const tool of tools) if (tool.definition.mode === "write") keys.add(`${plugin.modelId}.${tool.definition.name}`);
  }
  return keys;
}
