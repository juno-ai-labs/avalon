import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOnboarding } from '../lib/onboarding';
import type { OnboardingSpotlight as OnboardingSpotlightConfig } from '../lib/types';
import { Button } from './primitives';

const ANCHOR_ATTRIBUTE = 'data-onboarding-anchor';
const CARD_WIDTH = 272;
const CARD_HEIGHT_ESTIMATE = 168;
const EDGE_PADDING = 12;
const ANCHOR_PADDING = 10;
/** How far the beam leans toward the pointer. Enough to feel lit, not enough
 * to pull the light off the control it is pointing at. */
const POINTER_PARALLAX = 0.06;

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Marks an element as a spotlight target. Steps name anchors in the server
 * catalog, so a new step points at existing UI without new client wiring.
 */
export function onboardingAnchor(name: string): Record<string, string> {
  return { [ANCHOR_ATTRIBUTE]: name };
}

function readAnchorRect(anchor: string): AnchorRect | null {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(anchor) : anchor;
  const element = document.querySelector(`[${ANCHOR_ATTRIBUTE}="${escaped}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/** Tracks the anchor through scrolling, resizing, sidebar drags, and route
 * changes by re-measuring each frame; the measurement is cheap and only
 * re-renders when the rectangle actually moves. */
function useAnchorRect(anchor: string | null): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useEffect(() => {
    if (!anchor) {
      setRect(null);
      return undefined;
    }
    let frame = 0;
    const measure = (): void => {
      setRect((current) => {
        const next = readAnchorRect(anchor);
        if (!next || !current) return next;
        const unchanged = next.top === current.top && next.left === current.left
          && next.width === current.width && next.height === current.height;
        return unchanged ? current : next;
      });
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    return () => window.cancelAnimationFrame(frame);
  }, [anchor]);

  return rect;
}

function usePointerParallax(enabled: boolean): { x: number; y: number } | null {
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let frame = 0;
    const track = (event: PointerEvent): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setPointer({ x: event.clientX, y: event.clientY });
      });
    };
    window.addEventListener('pointermove', track);
    return () => {
      window.removeEventListener('pointermove', track);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return pointer;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clamp(value: number, min: number, max: number): number {
  return max <= min ? min : Math.max(min, Math.min(max, value));
}

function cardPosition(
  rect: AnchorRect,
  placement: OnboardingSpotlightConfig['placement'],
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const centeredLeft = rect.left + rect.width / 2 - CARD_WIDTH / 2;
  const raw = {
    top: { top: rect.top - CARD_HEIGHT_ESTIMATE - ANCHOR_PADDING, left: centeredLeft },
    bottom: { top: rect.top + rect.height + ANCHOR_PADDING, left: centeredLeft },
    left: { top: rect.top, left: rect.left - CARD_WIDTH - ANCHOR_PADDING },
    right: { top: rect.top, left: rect.left + rect.width + ANCHOR_PADDING },
  }[placement];

  return {
    left: clamp(raw.left, EDGE_PADDING, viewport.width - CARD_WIDTH - EDGE_PADDING),
    top: clamp(raw.top, EDGE_PADDING, viewport.height - CARD_HEIGHT_ESTIMATE - EDGE_PADDING),
  };
}

/**
 * The flashlight: everything but the step's target dims, a soft beam breathes
 * over the control, and a coach mark explains it. The overlay never swallows
 * clicks, so a member can ignore the guidance and do something else — including
 * a different step — without dismissing anything first.
 */
export function OnboardingSpotlight(): React.JSX.Element | null {
  const onboarding = useOnboarding();
  const activeStep = onboarding?.activeStep ?? null;
  const checklist = onboarding?.checklist ?? null;
  const spotlight = activeStep?.spotlight ?? null;
  const rect = useAnchorRect(spotlight?.anchor ?? null);
  const [reducedMotion] = useState(prefersReducedMotion);
  const pointer = usePointerParallax(Boolean(rect) && !reducedMotion);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const clearActiveStep = onboarding?.clearActiveStep;
  useEffect(() => {
    if (!activeStep || !clearActiveStep) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clearActiveStep();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeStep, clearActiveStep]);

  // Focus moves to the coach mark once per step, so screen readers announce the
  // guidance without stealing focus back every time the anchor shifts.
  const announcedStepId = useRef<string | null>(null);
  useEffect(() => {
    if (!rect || !activeStep || announcedStepId.current === activeStep.id) return;
    announcedStepId.current = activeStep.id;
    cardRef.current?.focus({ preventScroll: true });
  }, [activeStep, rect]);
  useEffect(() => {
    if (!activeStep) announcedStepId.current = null;
  }, [activeStep]);

  // The anchor lives in whichever window owns it. A window without it simply
  // shows nothing, which is how one active step guides across windows.
  if (!onboarding || !activeStep || !spotlight || !rect || !clearActiveStep) return null;

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const beam = pointer
    ? {
        x: center.x + (pointer.x - center.x) * POINTER_PARALLAX,
        y: center.y + (pointer.y - center.y) * POINTER_PARALLAX,
      }
    : center;
  const position = cardPosition(rect, spotlight.placement, viewport);
  const stepNumber = (checklist?.steps.findIndex((step) => step.id === activeStep.id) ?? -1) + 1;

  return createPortal(
    <div
      className={reducedMotion ? 'onboarding-spotlight is-still' : 'onboarding-spotlight'}
      style={{
        '--beam-x': `${beam.x}px`,
        '--beam-y': `${beam.y}px`,
        '--beam-rx': `${rect.width / 2 + 52}px`,
        '--beam-ry': `${rect.height / 2 + 46}px`,
        // Stated here, not only in the stylesheet: guidance must never be able
        // to block the app it is pointing at.
        pointerEvents: 'none',
      } as React.CSSProperties}
    >
      <div className="onboarding-spotlight-scrim" />
      <div
        className="onboarding-spotlight-ring"
        style={{
          top: rect.top - ANCHOR_PADDING / 2,
          left: rect.left - ANCHOR_PADDING / 2,
          width: rect.width + ANCHOR_PADDING,
          height: rect.height + ANCHOR_PADDING,
        }}
      />
      <div
        aria-describedby="onboarding-spotlight-body"
        aria-labelledby="onboarding-spotlight-title"
        className="onboarding-spotlight-card"
        ref={cardRef}
        role="dialog"
        style={{ top: position.top, left: position.left, pointerEvents: 'auto', width: CARD_WIDTH }}
        tabIndex={-1}
      >
        <header>
          <p className="eyebrow">
            {stepNumber > 0 && checklist ? `Step ${stepNumber} of ${checklist.totalCount}` : 'Getting started'}
          </p>
          <button aria-label="Stop guiding me" onClick={clearActiveStep} type="button">
            <X aria-hidden="true" size={13} />
          </button>
        </header>
        <h2 id="onboarding-spotlight-title">{spotlight.title}</h2>
        <p id="onboarding-spotlight-body">{spotlight.body}</p>
        <div className="onboarding-spotlight-actions">
          <button className="text-button" onClick={clearActiveStep} type="button">Not now</button>
          <Button
            className="button-primary"
            onClick={() => onboarding.setStepState(activeStep.id, 'completed')}
          >
            <Check aria-hidden="true" size={13} /> Mark as done
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
