import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import * as library from '../components/ui';
import { TooltipProvider } from '../components/ui';
import { ComponentExplorerScreen, explorerExempt, explorerSections } from './component-explorer';

/** Every name the explorer claims to show, flattened. */
const covered = new Set<string>(explorerSections.flatMap((section) => [...section.components]));

/**
 * The barrel's runtime exports. Types vanish at runtime, which is what makes
 * this list the right one: a `type` export has nothing to render.
 */
const exported = Object.keys(library);

describe('component explorer', () => {
  /**
   * The rule that keeps the library from becoming a folder.
   *
   * A component nobody can see beside its neighbours is a component somebody
   * writes a second copy of — the renderer had two dropdown surfaces and two
   * copies of the connector icon map for exactly that reason. Failing here
   * makes "show it in the explorer" part of adding a component instead of a
   * thing to remember, and it is checked against the barrel rather than
   * against a list, so it cannot go stale.
   */
  it('shows every export the barrel offers', () => {
    const missing = exported.filter((name) => !covered.has(name) && !(name in explorerExempt));
    expect(missing, `Add these to explorerSections, or to explorerExempt with a reason: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('claims nothing the barrel does not export', () => {
    const stale = [...covered, ...Object.keys(explorerExempt)].filter((name) => !exported.includes(name));
    expect(stale, `These names are no longer exported: ${stale.join(', ')}`).toEqual([]);
  });

  // `App` mounts the one provider; a screen rendered on its own supplies it
  // here for the same reason every other screen test does.
  it('renders every section', () => {
    render(
      <TooltipProvider>
        <ComponentExplorerScreen />
      </TooltipProvider>,
    );
    for (const section of explorerSections) {
      expect(screen.getByRole('region', { name: section.name })).toBeInTheDocument();
    }
  });
});
