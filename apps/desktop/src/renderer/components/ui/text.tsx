import type { HTMLAttributes } from 'react';

import { cn } from './cn';

/**
 * The typographic rhythm, as components rather than as whatever heading level
 * was nearest.
 *
 * `Heading` and `Subheading` take a `level` because the *size* of a title and
 * its *place in the outline* are different questions, and answering them with
 * one `<h2>` is how a screen ends up with an `<h4>` that is bigger than the
 * `<h2>` above it. Pick the level from the document; the size comes with the
 * component.
 */
type Level = 1 | 2 | 3 | 4;

interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: Level;
}

export function Heading({ className, level = 1, ...props }: HeadingProps): React.JSX.Element {
  const Tag = `h${level}` as const;
  return <Tag className={cn('m-0 text-title font-strong text-ink', className)} {...props} />;
}

export function Subheading({ className, level = 2, ...props }: HeadingProps): React.JSX.Element {
  const Tag = `h${level}` as const;
  return <Tag className={cn('m-0 text-[11.5px] font-strong text-ink', className)} {...props} />;
}

/**
 * The letterspaced small-capitals label over a group. Its four properties are
 * `sys.label.*` so a theme can trade small capitals for sentence case, which is
 * the kind of thing a theme should be able to decide and a component should not.
 */
export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return (
    <p
      className={cn(
        'm-0 text-[length:var(--av-sys-label-font-size)] uppercase text-brand-ink',
        'font-[number:var(--av-sys-label-weight)] tracking-[var(--av-sys-label-tracking)]',
        className,
      )}
      {...props}
    />
  );
}

export function Text({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn('m-0 text-ink-muted', className)} {...props} />;
}

export function Strong({ className, ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <strong className={cn('font-strong text-ink', className)} {...props} />;
}

export function Code({ className, ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <code className={cn('font-mono text-[0.95em]', className)} {...props} />;
}

/** A key or a chord. `⌘↵` was written as two literal characters in the feed. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <kbd className={cn('font-ui text-[10.5px] font-[500] text-ink-muted', className)} {...props} />
  );
}
