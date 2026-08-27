/*
 * GENERATED FILE — do not edit.
 *
 * Written by `scripts/build-theme-assets.mjs` from the design-token JSON
 * under `config/design-tokens/`. Run `pnpm tokens:build` after editing a
 * theme; `pnpm tokens:check` fails if this file and that JSON disagree.
 *
 * Imported by `apps/desktop/tailwind.config.ts`. Every entry is a `var()`
 * reference, so a utility class follows the active theme for the same
 * reason a hand-written rule in `app.css` does — and a colour Tailwind
 * ships but the registry does not name is not in the vocabulary at all.
 */

/** Every colour a utility may name. Nothing else resolves. */
export const colors = {
  transparent: 'transparent',
  current: 'currentColor',
  inherit: 'inherit',
  surface: {
    canvas: 'var(--av-sys-color-surface-canvas)',
    DEFAULT: 'var(--av-sys-color-surface-default)',
    subtle: 'var(--av-sys-color-surface-subtle)',
    sunken: 'var(--av-sys-color-surface-sunken)',
    raised: 'var(--av-sys-color-surface-raised)',
    'raised-hover': 'var(--av-sys-color-surface-raised-hover)',
    elevated: 'var(--av-sys-color-surface-elevated)',
    'elevated-hover': 'var(--av-sys-color-surface-elevated-hover)',
    'inverse-hover': 'var(--av-sys-color-surface-inverse-hover)',
  },
  ink: {
    'on-inverse': 'var(--av-sys-color-text-on-inverse)',
    DEFAULT: 'var(--av-sys-color-text-default)',
    subtle: 'var(--av-sys-color-text-subtle)',
    muted: 'var(--av-sys-color-text-muted)',
    disabled: 'var(--av-sys-color-text-disabled)',
  },
  line: {
    highlight: 'var(--av-sys-color-border-highlight)',
    DEFAULT: 'var(--av-sys-color-border-default)',
    subtle: 'var(--av-sys-color-border-subtle)',
    strong: 'var(--av-sys-color-border-strong)',
    hover: 'var(--av-sys-color-border-hover)',
    focus: 'var(--av-sys-color-border-focus)',
  },
  brand: {
    base: 'var(--av-sys-color-brand-base)',
    strong: 'var(--av-sys-color-brand-strong)',
    soft: 'var(--av-sys-color-brand-soft)',
    ink: 'var(--av-sys-color-brand-ink)',
    wash: 'var(--av-sys-color-brand-wash)',
    edge: 'var(--av-sys-color-brand-edge)',
    on: 'var(--av-sys-color-brand-on)',
    tint: 'var(--av-sys-color-brand-tint)',
    'tint-strong': 'var(--av-sys-color-brand-tint-strong)',
    glow: 'var(--av-sys-color-brand-glow)',
    hover: 'var(--av-sys-color-brand-hover)',
  },
  accent: {
    base: 'var(--av-sys-color-accent-base)',
    strong: 'var(--av-sys-color-accent-strong)',
    soft: 'var(--av-sys-color-accent-soft)',
    wash: 'var(--av-sys-color-accent-wash)',
    edge: 'var(--av-sys-color-accent-edge)',
    on: 'var(--av-sys-color-accent-on)',
    tint: 'var(--av-sys-color-accent-tint)',
  },
  success: {
    base: 'var(--av-sys-color-success-base)',
    strong: 'var(--av-sys-color-success-strong)',
    fill: 'var(--av-sys-color-success-fill)',
    'fill-edge': 'var(--av-sys-color-success-fill-edge)',
    soft: 'var(--av-sys-color-success-soft)',
    wash: 'var(--av-sys-color-success-wash)',
    edge: 'var(--av-sys-color-success-edge)',
    on: 'var(--av-sys-color-success-on)',
  },
  warning: {
    base: 'var(--av-sys-color-warning-base)',
    strong: 'var(--av-sys-color-warning-strong)',
    soft: 'var(--av-sys-color-warning-soft)',
    wash: 'var(--av-sys-color-warning-wash)',
    edge: 'var(--av-sys-color-warning-edge)',
    on: 'var(--av-sys-color-warning-on)',
  },
  danger: {
    base: 'var(--av-sys-color-danger-base)',
    strong: 'var(--av-sys-color-danger-strong)',
    soft: 'var(--av-sys-color-danger-soft)',
    wash: 'var(--av-sys-color-danger-wash)',
    edge: 'var(--av-sys-color-danger-edge)',
    on: 'var(--av-sys-color-danger-on)',
    tint: 'var(--av-sys-color-danger-tint)',
    'tint-strong': 'var(--av-sys-color-danger-tint-strong)',
  },
  workstream: {
    running: 'var(--av-sys-color-workstream-running)',
    'needs-input': 'var(--av-sys-color-workstream-needs-input)',
    completed: 'var(--av-sys-color-workstream-completed)',
    failed: 'var(--av-sys-color-workstream-failed)',
    stopped: 'var(--av-sys-color-workstream-stopped)',
    unread: 'var(--av-sys-color-workstream-unread)',
    mentioned: 'var(--av-sys-color-workstream-mentioned)',
    unseen: 'var(--av-sys-color-workstream-unseen)',
  },
  scrim: {
    DEFAULT: 'var(--av-sys-color-scrim-default)',
    subtle: 'var(--av-sys-color-scrim-subtle)',
    solid: 'var(--av-sys-color-scrim-solid)',
  },
  focus: {
    DEFAULT: 'var(--av-sys-color-focus-default)',
    quiet: 'var(--av-sys-color-focus-quiet)',
  },
  selection: {
    background: 'var(--av-sys-color-selection-background)',
  },
  scrollbar: {
    thumb: 'var(--av-sys-color-scrollbar-thumb)',
  },
  shimmer: {
    DEFAULT: 'var(--av-sys-color-shimmer-default)',
  },
  syntax: {
    plain: 'var(--av-sys-color-syntax-plain)',
    comment: 'var(--av-sys-color-syntax-comment)',
    punctuation: 'var(--av-sys-color-syntax-punctuation)',
    tag: 'var(--av-sys-color-syntax-tag)',
    number: 'var(--av-sys-color-syntax-number)',
    string: 'var(--av-sys-color-syntax-string)',
    operator: 'var(--av-sys-color-syntax-operator)',
    keyword: 'var(--av-sys-color-syntax-keyword)',
    function: 'var(--av-sys-color-syntax-function)',
    variable: 'var(--av-sys-color-syntax-variable)',
  },
  person: {
    '1': 'var(--av-sys-color-person-1)',
    '2': 'var(--av-sys-color-person-2)',
    '3': 'var(--av-sys-color-person-3)',
    '4': 'var(--av-sys-color-person-4)',
    '5': 'var(--av-sys-color-person-5)',
    '6': 'var(--av-sys-color-person-6)',
  },
  pane: {
    background: 'var(--av-cmp-pane-background)',
  },
  sidebar: {
    background: 'var(--av-cmp-sidebar-background)',
    'background-solid': 'var(--av-cmp-sidebar-background-solid)',
    border: 'var(--av-cmp-sidebar-border)',
  },
  row: {
    'background-hover': 'var(--av-cmp-row-background-hover)',
    'background-selected': 'var(--av-cmp-row-background-selected)',
  },
  bubble: {
    background: 'var(--av-cmp-bubble-background)',
    border: 'var(--av-cmp-bubble-border)',
  },
  composer: {
    background: 'var(--av-cmp-composer-background)',
    'border-color': 'var(--av-cmp-composer-border-color)',
    'border-color-focus': 'var(--av-cmp-composer-border-color-focus)',
    'rule-color': 'var(--av-cmp-composer-rule-color)',
    'rule-color-focus': 'var(--av-cmp-composer-rule-color-focus)',
    'send-background': 'var(--av-cmp-composer-send-background)',
    'send-foreground': 'var(--av-cmp-composer-send-foreground)',
  },
  tooltip: {
    background: 'var(--av-cmp-tooltip-background)',
    foreground: 'var(--av-cmp-tooltip-foreground)',
  },
  toggle: {
    track: 'var(--av-cmp-toggle-track)',
    'knob-off': 'var(--av-cmp-toggle-knob-off)',
  },
  connector: {
    'github-background': 'var(--av-cmp-connector-github-background)',
    'github-foreground': 'var(--av-cmp-connector-github-foreground)',
    'google-background': 'var(--av-cmp-connector-google-background)',
    'google-foreground': 'var(--av-cmp-connector-google-foreground)',
    'drive-background': 'var(--av-cmp-connector-drive-background)',
    'drive-foreground': 'var(--av-cmp-connector-drive-foreground)',
    'slack-background': 'var(--av-cmp-connector-slack-background)',
    'slack-foreground': 'var(--av-cmp-connector-slack-foreground)',
    'linear-background': 'var(--av-cmp-connector-linear-background)',
    'linear-foreground': 'var(--av-cmp-connector-linear-foreground)',
    'webhook-background': 'var(--av-cmp-connector-webhook-background)',
    'webhook-foreground': 'var(--av-cmp-connector-webhook-foreground)',
    'search-background': 'var(--av-cmp-connector-search-background)',
    'search-foreground': 'var(--av-cmp-connector-search-foreground)',
    'plug-background': 'var(--av-cmp-connector-plug-background)',
    'plug-foreground': 'var(--av-cmp-connector-plug-foreground)',
  },
} as const;

/** The corner scale. `rounded` is `sys.size.radius.md`. */
export const borderRadius = {
  xs: 'var(--av-sys-size-radius-xs)',
  sm: 'var(--av-sys-size-radius-sm)',
  md: 'var(--av-sys-size-radius-md)',
  lg: 'var(--av-sys-size-radius-lg)',
  xl: 'var(--av-sys-size-radius-xl)',
  pill: 'var(--av-sys-size-radius-pill)',
  DEFAULT: 'var(--av-sys-size-radius-md)',
} as const;

/** Border widths beyond Tailwind’s own 0/2/4/8. */
export const borderWidth = {
  hairline: 'var(--av-sys-size-border-hairline)',
} as const;

/** Named spaces, alongside Tailwind’s numeric scale. */
export const spacing = {
  control: 'var(--av-sys-size-control-height)',
  pane: 'var(--av-sys-space-pane-padding)',
  stack: 'var(--av-sys-space-stack-gap)',
  row: 'var(--av-sys-space-row-gap)',
  group: 'var(--av-sys-space-group-gap)',
  block: 'var(--av-sys-space-block-gap)',
  prose: 'var(--av-sys-space-prose-gap)',
} as const;

/** The sizes the interface sets. */
export const fontSize = {
  base: 'var(--av-sys-font-size-base)',
  prose: 'var(--av-sys-font-size-prose)',
  row: 'var(--av-sys-font-size-row)',
  hint: 'var(--av-sys-font-size-hint)',
  action: 'var(--av-sys-font-size-action)',
  meta: 'var(--av-sys-font-size-meta)',
  author: 'var(--av-sys-font-size-author)',
  title: 'var(--av-sys-font-size-title)',
} as const;

/** Weights, to the degree the resolved family supports them. */
export const fontWeight = {
  strong: 'var(--av-sys-font-weight-strong)',
  heading: 'var(--av-sys-font-weight-heading)',
  emphasis: 'var(--av-sys-font-weight-emphasis)',
} as const;

/** The families. */
export const fontFamily = {
  ui: 'var(--av-sys-font-family-ui)',
  display: 'var(--av-sys-font-family-display)',
  mono: 'var(--av-sys-font-family-mono)',
} as const;

/** Line heights. */
export const lineHeight = {
  prose: 'var(--av-sys-font-leading-prose)',
  base: 'var(--av-sys-font-leading-base)',
} as const;

/** Depth, and the focus rings — whole `box-shadow` values. */
export const boxShadow = {
  sm: 'var(--av-sys-elevation-shadow-sm)',
  md: 'var(--av-sys-elevation-shadow-md)',
  lg: 'var(--av-sys-elevation-shadow-lg)',
  rail: 'var(--av-sys-elevation-shadow-rail)',
  'rail-strong': 'var(--av-sys-elevation-shadow-rail-strong)',
  drawer: 'var(--av-sys-elevation-shadow-drawer)',
  focus: 'var(--av-sys-focus-ring-default)',
  'focus-quiet': 'var(--av-sys-focus-ring-quiet)',
  'focus-brand': 'var(--av-sys-focus-ring-brand)',
} as const;
