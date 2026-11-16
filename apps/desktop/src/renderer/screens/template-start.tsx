import { useEffect, useRef } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { LoadingState } from '../components/primitives';
import { CANVAS_TEMPLATES } from '../lib/canvas-templates';
import { useCreateCanvas } from '../lib/canvases';
import { useShellCapabilities } from '../lib/collaboration-session';

/**
 * `/marketplace/:slug`: start a Canvas from one Marketplace template, as
 * picking its card does, then stand aside. A template link from the public
 * site (`/app/templates/<slug>`) lands here once the person has signed in and
 * picked an Organization. The Canvas replaces this route, so Back never
 * returns here to start a second one. A guest makes no Canvas, and a slug the
 * catalog does not hold names nothing, so both open the Canvases home.
 */
export function TemplateStartScreen(): React.JSX.Element {
  const { slug } = useParams();
  const { guest } = useShellCapabilities();
  const create = useCreateCanvas();
  const template = CANVAS_TEMPLATES.find((candidate) => candidate.slug === slug);
  const started = useRef(false);
  useEffect(() => {
    if (guest || !template || started.current) return;
    started.current = true;
    create(template.prompt, { replace: true });
  }, [create, guest, template]);
  if (guest || !template) return <Navigate replace to="/canvases" />;
  return <LoadingState label={`Starting ${template.name}…`} />;
}
