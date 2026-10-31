import { describe, expect, it } from "vitest";
import { renderCodeApi, renderType } from "./code-api";

describe("renderCodeApi", () => {
  it("renders namespaces by plugin with tools sorted by name and nullable, enum and nested shapes", () => {
    const rendered = renderCodeApi([
      {
        modelId: "plugin_linear",
        description: "Linear: issues, projects, comments.",
        tools: [
          {
            name: "list_issues_next",
            description: "Next page.",
            mode: "read",
            inputSchema: { type: "object", properties: { pageId: { type: "string", description: "From the previous result." } }, required: ["pageId"] },
          },
          {
            name: "list_issues",
            description: "List issues in a project or team.\nReturns a page.",
            mode: "read",
            inputSchema: {
              type: "object",
              properties: {
                project: { anyOf: [{ type: "string" }, { type: "null" }], description: "Project name." },
                state: { type: "string", enum: ["open", "closed", "all"] },
                labels: { type: "array", items: { type: "string" } },
                limit: { type: ["integer", "null"] },
              },
              required: ["project"],
            },
          },
          {
            name: "create_issue",
            description: "Create one issue. */ not a terminator",
            mode: "write",
            inputSchema: { type: "object", properties: { team: { type: "string" }, meta: { type: "object", additionalProperties: { type: "string" } } }, required: ["team"] },
          },
        ],
      },
      { modelId: "plugin_empty", description: "No tools.", tools: [] },
    ]);
    expect(rendered).toBe(
      [
        "declare const tools: {",
        "  /** Linear: issues, projects, comments. */",
        "  plugin_linear: {",
        "    /** write. Create one issue. * / not a terminator */",
        "    create_issue(input: {",
        "      team: string;",
        "      meta?: Record<string, string>;",
        "    }): Promise<unknown>;",
        "    /** read. List issues in a project or team. Returns a page. */",
        "    list_issues(input: {",
        "      /** Project name. */ project: string | null;",
        '      state?: "open" | "closed" | "all";',
        "      labels?: string[];",
        "      limit?: number | null;",
        "    }): Promise<unknown>;",
        "    /** read. Next page. */",
        "    list_issues_next(input: {",
        "      /** From the previous result. */ pageId: string;",
        "    }): Promise<unknown>;",
        "  };",
        "};",
      ].join("\n"),
    );
  });

  it("renders nothing for no callable tools", () => {
    expect(renderCodeApi([])).toBe("");
    expect(renderCodeApi([{ modelId: "p", description: "d", tools: [] }])).toBe("");
  });

  it("falls back to unknown for shapes it does not model", () => {
    expect(renderType({ $ref: "#/x" }, 0)).toBe("unknown");
    expect(renderType(true, 0)).toBe("unknown");
    expect(renderType({ type: "array" }, 0)).toBe("unknown[]");
    expect(renderType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }, 0)).toBe("(string | number)[]");
    expect(renderType({ const: 7 }, 0)).toBe("7");
  });
});
