/** Motion measured in the installed Grok Bot 0.43.0 onboarding scene.
 * See the PRD's motion-reference.md for provenance. This computes our own CSS
 * spring curve rather than bundling competitor renderer code or artwork. */
export function onboardingSpring(stiffness: number, damping: number): { duration: number; easing: string } {
  const duration = Math.round(-Math.log(0.001) / (damping / 2) * 1000);
  const frequency = Math.sqrt(stiffness);
  const ratio = damping / (2 * frequency);
  const points = Array.from({ length: 49 }, (_, index) => {
    const t = index / 48 * duration / 1000;
    const damped = frequency * Math.sqrt(1 - ratio * ratio);
    const progress = ratio < 1
      ? 1 - Math.exp(-ratio * frequency * t) * (Math.cos(damped * t) + ratio * frequency / damped * Math.sin(damped * t))
      : 1 - Math.exp(-frequency * t) * (1 + frequency * t);
    return `${Number(progress.toFixed(4))} ${Number((index / 48 * 100).toFixed(2))}%`;
  });
  return { duration, easing: `linear(${points.join(', ')})` };
}
export const onboardingMotion = {
  standard: onboardingSpring(175, 26), slow: onboardingSpring(100, 20), bounce: onboardingSpring(175, 18.5),
  typeInterval: 35, typeDelay: 700, demoBeat: 900, jobsBeat: 800,
} as const;
