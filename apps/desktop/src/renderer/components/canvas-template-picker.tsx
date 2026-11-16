import { IdentityTile } from '@rally/ui/components/identity-tile';
import { WORKSTREAM_ICON_COMPONENTS } from '@rally/ui/components/workstream-glyph';
import { markColors } from '@rally/ui/lib/project-palette';
import { ArrowUp } from 'lucide-react';
import { useState } from 'react';

import { CANVAS_TEMPLATE_CATEGORIES } from '../../../../../packages/skills/marketplace-skills/categories';
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
 * One template as a card that starts it: its mark, name and description, and
 * either the composer's Send arrow (the Marketplace page) or, compact, who it
 * is for (under an empty Canvas's composer). One card so a change to how a
 * template is drawn lands in both places.
 */
export function CanvasTemplateCard({ audience, compact = false, disabled = false, onStart, template }: {
  audience?: string | undefined;
  compact?: boolean;
  disabled?: boolean;
  onStart: (prompt: string) => void;
  template: CanvasTemplate;
}): React.JSX.Element {
  return <button className={compact ? 'dashboard-card canvas-template-card is-compact' : 'dashboard-card canvas-template-card'} disabled={disabled} onClick={() => onStart(template.prompt)} type="button">
    <span className="canvas-template-title"><CanvasTemplateMark size={compact ? 22 : 24} template={template} />{template.name}</span>
    {!compact && <span aria-hidden="true" className="canvas-template-send"><ArrowUp size={15} /></span>}
    <span className="canvas-template-description">{template.description}</span>
    {audience && <span className="canvas-template-audience">For {audience.toLocaleLowerCase()}</span>}
  </button>;
}

/**
 * The Marketplace page's catalog: one category at a time, starting on the
 * first, and a card per template. Desktop's Canvases page and the mobile
 * host's create flow both draw it, each with its own heading around it.
 */
export function CanvasMarketplace({ disabled = false, onStart }: { disabled?: boolean; onStart: (prompt: string) => void }): React.JSX.Element {
  const [category, setCategory] = useState<(typeof CANVAS_TEMPLATE_CATEGORIES)[number]['tag']>(CANVAS_TEMPLATE_CATEGORIES[0].tag);
  const templates = CANVAS_TEMPLATES.filter((template) => template.tags.includes(category));
  return <section aria-label="Canvas templates" className="canvas-marketplace">
    <div aria-label="Template category" className="sidekick-filters canvas-template-categories" role="group">
      {CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => <button aria-pressed={category === tag} key={tag} onClick={() => setCategory(tag)} type="button">{label}</button>)}
    </div>
    <ul className="dashboard-grid">
      {templates.map((template) => <li key={template.name}>
        <CanvasTemplateCard disabled={disabled} onStart={onStart} template={template} />
      </li>)}
    </ul>
  </section>;
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
      {templates.map((template) => <li key={template.name}>
        <CanvasTemplateCard
          audience={group === 'popular' ? CATEGORY_LABELS.get(template.tags[0] ?? '') : undefined}
          compact
          disabled={disabled}
          onStart={onStart}
          template={template}
        />
      </li>)}
    </ul>
  </section>;
}
