/** One node of DevTools' `Accessibility.getFullAXTree`, as far as the outline reads it. */
interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  childIds?: string[];
  parentId?: string;
}

/** Roles that only group their children; shown when they carry a name. */
const STRUCTURAL = new Set(['generic', 'none', 'presentation', 'group', 'InlineTextBox', 'LineBreak']);

/**
 * The page's accessibility tree as an indented outline: one `role "name"` line
 * per meaningful node, children indented under their parent.
 *
 * A raw tree is mostly wrapper divs and per-line text boxes; this keeps the
 * nodes a reader would name — headings, links, buttons, text, landmarks — and
 * lifts the children of an unnamed wrapper to its own level. Ignored nodes are
 * skipped the same way.
 */
export function axOutline(tree: unknown): string {
  const nodes = (tree && typeof tree === 'object' && Array.isArray((tree as { nodes?: unknown }).nodes))
    ? (tree as { nodes: AxNode[] }).nodes : [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId));
  if (!root) return '';
  const lines: string[] = [];
  const text = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  const visit = (node: AxNode, depth: number, seen: Set<string>) => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = text(node.role?.value);
    const name = text(node.name?.value);
    const shown = !node.ignored && role !== '' && (!STRUCTURAL.has(role) || name !== '')
      && !(role === 'StaticText' && name === '');
    if (shown) lines.push(`${'  '.repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ''}`);
    // Static text repeats its parent's name, line by line, in text boxes.
    if (role === 'StaticText') return;
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, shown ? depth + 1 : depth, seen);
    }
  };
  visit(root, 0, new Set());
  return lines.join('\n');
}
