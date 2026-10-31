/**
 * The `# Code API` prompt section: the run's callable tools rendered as
 * TypeScript declarations for a `code_execute` program to write against.
 *
 * A pure function of the tool definitions the wire already shows the model, in
 * the order the caller hands them (Bind's plugin order, canonical id first),
 * with tools sorted by canonical name inside a plugin. Determinism matters: the
 * section is re-rendered on every model call from the active plugin set, and a
 * resumed attempt must produce the same bytes as a fresh one so the provider's
 * cached prefix survives.
 *
 * Design: docs/PRDs/2026-10-31_code-mode-and-sidekick-custom-tools/design.md.
 */

export interface CodeApiTool {
  /** Canonical tool name; the function name the program calls. */
  name: string;
  description: string;
  mode: "read" | "write";
  /** The model-facing argument schema, after provider repair. */
  inputSchema: Record<string, unknown>;
}

export interface CodeApiPlugin {
  /** The namespace: the plugin's model id, such as `plugin_linear`. */
  modelId: string;
  description: string;
  tools: CodeApiTool[];
}

/** Render the whole declaration block. Empty input renders an empty string. */
export function renderCodeApi(plugins: readonly CodeApiPlugin[]): string {
  const namespaces = plugins
    .filter((plugin) => plugin.tools.length > 0)
    .map((plugin) => renderNamespace(plugin));
  if (namespaces.length === 0) return "";
  return `declare const tools: {\n${namespaces.join("\n")}\n};`;
}

function renderNamespace(plugin: CodeApiPlugin): string {
  const tools = [...plugin.tools].sort((a, b) => a.name.localeCompare(b.name, "en"));
  const lines = [`  /** ${docText(plugin.description)} */`, `  ${identifier(plugin.modelId)}: {`];
  for (const tool of tools) {
    lines.push(`    /** ${tool.mode}. ${docText(tool.description)} */`);
    lines.push(`    ${identifier(tool.name)}(input: ${renderType(tool.inputSchema, 4)}): Promise<unknown>;`);
  }
  lines.push("  };");
  return lines.join("\n");
}

/** One line, no comment terminators, bounded so a verbose description cannot swamp the section. */
function docText(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();
  return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat;
}

function identifier(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON Schema to a TypeScript type expression. Covers what tool schemas use:
 * object, array, scalars, enum, const, nullable type arrays, anyOf/oneOf/allOf.
 * Anything else, `$ref` included, renders as `unknown`, which is honest rather
 * than wrong.
 */
export function renderType(schema: unknown, indent: number): string {
  if (schema === true) return "unknown";
  if (!isRecord(schema)) return "unknown";
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => literal(value)).join(" | ") || "never";
  if ("const" in schema) return literal(schema.const);
  const variants = (["anyOf", "oneOf"] as const).flatMap((key) => Array.isArray(schema[key]) ? (schema[key] as unknown[]) : []);
  if (variants.length > 0) return unique(variants.map((variant) => renderType(variant, indent))).join(" | ");
  if (Array.isArray(schema.allOf)) return unique((schema.allOf as unknown[]).map((part) => renderType(part, indent))).join(" & ") || "unknown";
  if (Array.isArray(schema.type)) {
    return unique((schema.type as unknown[]).map((type) => renderType({ ...schema, type }, indent))).join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${wrapUnion(renderType(schema.items, indent))}[]`;
    case "object":
      return renderObject(schema, indent);
    default:
      return isRecord(schema.properties) ? renderObject(schema, indent) : "unknown";
  }
}

function renderObject(schema: Record<string, unknown>, indent: number): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    if (isRecord(schema.additionalProperties)) return `Record<string, ${renderType(schema.additionalProperties, indent)}>`;
    return schema.additionalProperties === false ? "Record<string, never>" : "Record<string, unknown>";
  }
  const pad = " ".repeat(indent + 2);
  const lines = entries.map(([key, property]) => {
    const description = isRecord(property) && typeof property.description === "string" ? `/** ${docText(property.description)} */ ` : "";
    return `${pad}${description}${identifier(key)}${required.has(key) ? "" : "?"}: ${renderType(property, indent + 2)};`;
  });
  return `{\n${lines.join("\n")}\n${" ".repeat(indent)}}`;
}

function wrapUnion(type: string): string {
  return type.includes(" | ") || type.includes(" & ") ? `(${type})` : type;
}

function literal(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
