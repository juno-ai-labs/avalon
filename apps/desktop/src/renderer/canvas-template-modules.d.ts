declare module '*.md?canvas-template' {
  import type { PickableWorkstreamIconKey, PALETTE_RING } from '@rally/contracts';

  const template: {
    name: string;
    description: string;
    icon: PickableWorkstreamIconKey;
    color: (typeof PALETTE_RING)[number];
    tags: string[];
    prompt: string;
  };
  export default template;
}
