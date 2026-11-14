/** iOS passes through inactive for sheets and interruptions as well as resume. */
export function appResumeListener(initialState: string | null, resume: () => void) {
  let backgrounded = initialState === 'background';
  return (state: string) => {
    if (state === 'background') backgrounded = true;
    if (state === 'active' && backgrounded) { backgrounded = false; resume(); }
  };
}
