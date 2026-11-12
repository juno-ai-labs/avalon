import { IdentityTile } from '@rally/ui/components/identity-tile';
import { WORKSTREAM_ICON_COMPONENTS } from '@rally/ui/components/workstream-glyph';
import { markColors } from '@rally/ui/lib/project-palette';
import { useState } from 'react';

import { CANVAS_TEMPLATE_CATEGORIES } from '../lib/canvas-template-categories';
import { CANVAS_TEMPLATES, type CanvasTemplate } from '../lib/canvas-templates';

type TemplateGroup = 'popular' | (typeof CANVAS_TEMPLATE_CATEGORIES)[number]['tag'];

/**
 * The first template of each category, in catalog order. Popular is what an
 * empty Canvas opens on, and no single category suits everyone who opens one:
 * one from each means every audience finds itself in the first view.
 */
const POPULAR: readonly CanvasTemplate[] = CANVAS_TEMPLATE_CATEGORIES.flatMap(({ tag }) =>
  CANVAS_TEMPLATES.find((template) => template.tags.includes(tag)) ?? []);

const CATEGORY_LABELS = new Map<string, string>(CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => [tag, label]));

/** A template's own icon and hue, as its front matter names them, drawn the way a Canvas mark is. */
export function CanvasTemplateMark({ template, size = 24 }: { template: CanvasTemplate; size?: number }): React.JSX.Element {
  const { ink, tint } = markColors(template.color);
  return <IdentityTile icon={WORKSTREAM_ICON_COMPONENTS[template.icon]} ink={ink} shape="sheet" size={size} tint={tint} />;
}

/**
 * The Marketplace's templates under an empty Canvas's composer: every group
 * named in one row, Popular first, and a card per template. Picking one hands
 * its prompt to `onStart`, which sends it as the Chat's first message exactly
 * as typed text would be sent.
 */
export function CanvasTemplateStarters({ disabled, onStart }: {
  disabled: boolean;
  onStart: (prompt: string) => void;
}): React.JSX.Element {
  const [group, setGroup] = useState<TemplateGroup>('popular');
  const templates = group === 'popular' ? POPULAR : CANVAS_TEMPLATES.filter((template) => template.tags.includes(group));
  const groups: ReadonlyArray<readonly [TemplateGroup, string]> = [
    ['popular', 'Popular'],
    ...CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => [tag, label] as const),
  ];
  return <section aria-label="Start from a template" className="canvas-starters">
    <div aria-label="Template group" className="canvas-starters-groups" role="group">
      {groups.map(([value, label]) => <button aria-pressed={group === value} key={value} onClick={() => setGroup(value)} type="button">{label}</button>)}
    </div>
    <ul className="canvas-starters-cards">
      {templates.map((template) => {
        const audience = CATEGORY_LABELS.get(template.tags[0] ?? '');
        return <li key={template.name}>
          <button className="canvas-starter-card" disabled={disabled} onClick={() => onStart(template.prompt)} type="button">
            <span className="canvas-starter-name"><CanvasTemplateMark size={22} template={template} />{template.name}</span>
            <span className="canvas-starter-description">{template.description}</span>
            {group === 'popular' && audience && <span className="canvas-starter-audience">For {audience.toLocaleLowerCase()}</span>}
          </button>
        </li>;
      })}
    </ul>
  </section>;
}
