declare module 'virtual:rally-canvas-templates' {
  import type { PickableWorkstreamIconKey, PALETTE_RING } from '@rally/contracts';

  const templates: readonly {
    name: string;
    description: string;
    icon: PickableWorkstreamIconKey;
    color: (typeof PALETTE_RING)[number];
    tags: string[];
    slug: string;
    prompt: string;
  }[];
  export default templates;
}
