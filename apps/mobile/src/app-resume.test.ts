import { expect, it, vi } from 'vitest';
import { appResumeListener } from './app-resume';

it('refreshes once after backgrounding, preserving warm screens during iOS interruptions', () => {
  const resume = vi.fn();
  const state = appResumeListener('active', resume);
  state('inactive'); state('active'); state('active');
  expect(resume).not.toHaveBeenCalled();
  state('inactive'); state('background'); state('inactive'); state('active'); state('active');
  expect(resume).toHaveBeenCalledTimes(1);
  state('background'); state('active');
  expect(resume).toHaveBeenCalledTimes(2);
});

it('handles a component mounted in the background without treating initial activation as resume', () => {
  const resume = vi.fn();
  appResumeListener(null, resume)('active');
  expect(resume).not.toHaveBeenCalled();
  appResumeListener('background', resume)('active');
  expect(resume).toHaveBeenCalledOnce();
});
