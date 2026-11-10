import { memorySkillFiles, SkillCatalog } from "@modelcontextprotocol/server/ext/skills";

import CANVASES from "../../../plugins/rally/skills/canvases/SKILL.md";
import PUBLISHING from "../../../plugins/rally/skills/publishing/SKILL.md";

/**
 * Rally's skills, served over MCP's skills extension
 * (`io.modelcontextprotocol/skills`) from the same files the Claude Code
 * plugin ships, so every client that reads skills from a server gets the copy
 * Claude Code gets. `docs/rally-mcp.md#skills`.
 */
export const SKILL_FILES: Record<string, string> = {
  "canvases/SKILL.md": CANVASES,
  "publishing/SKILL.md": PUBLISHING,
};

/**
 * A catalog for one request's server, served at `skill://rally/<name>/…`.
 * Loaded per request rather than shared: a catalog keeps the servers it is
 * attached to, and this Worker makes a server per request. The files are a
 * few kilobytes, so loading them is digesting them.
 */
export function rallySkillCatalog(): Promise<SkillCatalog> {
  return SkillCatalog.load(memorySkillFiles(SKILL_FILES), { prefix: "rally", strict: true });
}
