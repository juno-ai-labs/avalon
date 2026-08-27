import { relative, sep } from "node:path";

/**
 * The two rules that make `components/ui/` a library rather than a folder.
 *
 * Both encode a promise the rest of the codebase relies on and neither is
 * checkable by a type or a test: they are about which file an import names,
 * which is exactly what a lint rule sees and nothing else does.
 */

/** Where the registries live, relative to the repository root. */
const ICON_REGISTRY = "apps/desktop/src/renderer/components/ui/icon.tsx";
const CONNECTOR_REGISTRY = "apps/desktop/src/renderer/components/ui/connector-icon.tsx";

/**
 * Files that still import Lucide directly, and the reason this list exists.
 *
 * Consolidating twelve icon sizes and two packages onto one registry is a
 * mechanical change to roughly two hundred and fifty call sites, and doing it
 * inside the change that *introduces* the registry would bury the design under
 * the diff — with a visual regression surface across every screen, since the
 * sizes in use are not the sizes the scale offers. So the rule ships with the
 * unconverted files named, which makes the invariant real for everything
 * written from now on and turns the backlog into something a build can count.
 *
 * **This list only shrinks.** A new entry is not a small exception; it is the
 * rule being switched off for a file. Convert the icons instead.
 */
const LUCIDE_LEGACY = new Set([
  "apps/desktop/src/renderer/App.tsx",
  "apps/desktop/src/renderer/components/attachment-lightbox.tsx",
  "apps/desktop/src/renderer/components/attachments.tsx",
  "apps/desktop/src/renderer/components/composer-input.tsx",
  "apps/desktop/src/renderer/components/inspector-rail.tsx",
  "apps/desktop/src/renderer/components/primitives.tsx",
  "apps/desktop/src/renderer/components/sidebar.tsx",
  "apps/desktop/src/renderer/components/workstream-blocks.tsx",
  "apps/desktop/src/renderer/components/workstream-composer.tsx",
  "apps/desktop/src/renderer/screens/automation-overview.tsx",
  "apps/desktop/src/renderer/screens/meeting-notes.tsx",
  "apps/desktop/src/renderer/screens/new-automation.tsx",
  "apps/desktop/src/renderer/screens/new-workstream.tsx",
  "apps/desktop/src/renderer/screens/note-detail.tsx",
  "apps/desktop/src/renderer/screens/onboarding.tsx",
  "apps/desktop/src/renderer/screens/workspace-settings.tsx",
  "apps/desktop/src/renderer/screens/workstream.tsx",
]);

/**
 * The path as this file writes it, so the lists above read like the tree.
 * `context.cwd` is the repository root under the flat config at `eslint.config.mjs`.
 */
function repoRelative(context) {
  return relative(context.cwd, context.filename).split(sep).join("/");
}

export const iconRegistryRule = {
  meta: {
    type: "problem",
    docs: { description: "Draw icons from the semantic registry, not from an icon package." },
    schema: [],
    messages: {
      lucide:
        "Import { Icon } from 'components/ui' and add a row to icon.tsx instead of naming a Lucide glyph here. A name in that registry says what the icon means; a glyph picked at the call site is why the renderer drew twelve icon sizes across two packages.",
      tabler:
        "Tabler is the brand-mark source only. Use ConnectorIcon from 'components/ui' for a provider's mark, and the Icon registry for everything else.",
    },
  },
  create(context) {
    const path = repoRelative(context);
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (source === "lucide-react") {
          if (path === ICON_REGISTRY || LUCIDE_LEGACY.has(path)) return;
          context.report({ node, messageId: "lucide" });
        }
        if (source === "@tabler/icons-react" && path !== CONNECTOR_REGISTRY) {
          context.report({ node, messageId: "tabler" });
        }
      },
    };
  },
};

export const componentLibraryBarrelRule = {
  meta: {
    type: "problem",
    docs: { description: "Import the component library through its barrel." },
    schema: [],
    messages: {
      deep:
        "Import from '{{barrel}}' rather than reaching into '{{source}}'. The barrel is what lets a component's backing be replaced in one file; a deep import pins the caller to today's implementation.",
    },
  },
  create(context) {
    const path = repoRelative(context);
    // Inside the library, siblings import each other directly — that is what
    // a library's internals are. The rule is about everyone else.
    if (path.startsWith("apps/desktop/src/renderer/components/ui/")) return {};
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        const match = /(?:^|\/)components\/ui\/(?!index)[\w.-]+$/u.exec(source);
        if (!match) return;
        const barrel = source.slice(0, source.indexOf("components/ui/") + "components/ui".length);
        context.report({ data: { barrel, source }, messageId: "deep", node });
      },
    };
  },
};
