import { useEffect, useRef, type CSSProperties } from 'react';
import { onboardingMotion } from '../lib/onboarding-motion';
import type { PersonalPresentation } from '@rally/contracts';

export const personalColorTokens = {
  blue: 'blue', teal: 'cyan', green: 'green', amber: 'yellow', orange: 'orange', rose: 'pink', violet: 'purple', slate: 'gray',
} as const;
export function personalColor(color: PersonalPresentation['color']): string {
  return `var(--av-sys-color-project-${personalColorTokens[color]})`;
}
export function PersonalAvatar({ color = 'blue', avatar = 'circle', className = '', style, motion, land = false, initials }: {
  initials?: string;
  motion?: 'idle' | 'listening' | 'working' | 'excited' | 'happy'; land?: boolean;
  color?: PersonalPresentation['color']; avatar?: PersonalPresentation['avatar']; className?: string; style?: CSSProperties;
}): React.JSX.Element {
  const root = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let movement: Animation | undefined;
    let arrival: Animation | undefined;
    const animate = () => {
      movement?.cancel(); arrival?.cancel();
      if (media?.matches) return;
      if (motion && body.current) {
        const period = motion === 'working' ? 625 : motion === 'excited' ? 1000 / 2.2 : motion === 'happy' ? Math.PI / 1.2 * 1000 : 2 * Math.PI / .85 * 1000;
        const frames = Array.from({ length: 49 }, (_, index) => {
          const t = index / 48 * period / 1000;
          const beat = Math.sin(t * Math.PI * 2 * 1.6);
          const y = motion === 'working' ? 1.5 + Math.max(0, beat) * 3 : motion === 'excited' ? -Math.sin((t * 2.2 % 1) * Math.PI) * 10 + 2 : motion === 'happy' ? -Math.abs(Math.sin(t * 2.4)) * 3 : motion === 'listening' ? -2 + Math.sin(t * .8) * .8 : Math.sin(t * .85) * 1.2;
          const scale = motion === 'working' ? 1 - Math.max(0, beat) * .02 : motion === 'happy' ? 1 + Math.sin(t * 2.4) * .02 : motion === 'listening' ? 1.015 : 1 + Math.sin(t * .85) * .007;
          return { transform: `translateY(${y}px) scale(${scale})` };
        });
        movement = body.current.animate(frames, { duration: period, iterations: Infinity });
      }
      if (land && root.current) {
        const target = root.current.getBoundingClientRect();
        arrival = root.current.animate([
          { transform: `translate(${window.innerWidth / 2 + 246 - target.x - target.width / 2}px, ${window.innerHeight / 2 - 275 - target.y - target.height / 2}px) scale(.5)` },
          { transform: 'translate(0, 0) scale(1)' },
        ], { duration: onboardingMotion.standard.duration, easing: onboardingMotion.standard.easing });
      }
    };
    animate(); media?.addEventListener('change', animate);
    return () => { movement?.cancel(); arrival?.cancel(); media?.removeEventListener('change', animate); };
  }, [motion, land]);
  return <span ref={root} aria-hidden="true" className={`personal-avatar personal-avatar-${avatar} ${className}`} style={{ ...style, color: personalColor(color) }}>
    <span ref={body} className="personal-avatar-body"><svg viewBox="0 0 100 100" fill="currentColor">
      {avatar === 'circle' && <circle cx="50" cy="50" r="45" />}
      {avatar === 'rounded' && <rect x="7" y="7" width="86" height="86" rx="26" />}
      {avatar === 'diamond' && <path d="M42 5 Q50 0 58 5 L94 42 Q100 50 94 58 L58 94 Q50 100 42 94 L6 58 Q0 50 6 42Z" />}
      {avatar === 'flower' && <path d="M50 13 C78 -8 103 21 85 45 C110 70 82 100 57 85 C30 110 0 82 15 57 C-10 30 18 0 43 15Z" />}
      {avatar === 'spark' && <path d="M50 2 L63 27 L91 15 L79 43 L98 57 L72 66 L77 95 L50 81 L23 95 L28 66 L2 57 L21 43 L9 15 L37 27Z" />}
      {avatar === 'arch' && <path d="M7 50 A43 43 0 0 1 93 50 V84 Q93 93 84 93 H16 Q7 93 7 84Z" />}
      {initials ? <text x="50" y="52" dominantBaseline="middle" textAnchor="middle" fill="var(--personal-ink-light)" fontSize={Math.min(36, 70 / Math.max(1, [...initials].length))} fontWeight="600">{initials}</text> : <g fill="var(--personal-ink-light)" transform="rotate(-14 50 60)"><rect x="34" y="56" width="7" height="17" rx="3.5" /><rect x="56" y="56" width="7" height="17" rx="3.5" /></g>}
    </svg></span>
  </span>;
}
