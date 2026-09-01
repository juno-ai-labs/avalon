import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workspace activation authorization', () => {
  it('revalidates every selection through the control plane before committing it', () => {
    const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
    const activation = source.slice(
      source.indexOf('async function activateWorkspace('),
      source.indexOf('async function createWorkspace('),
    );

    expect(activation).toContain("requestOnboardingSession(\n      '/onboarding/workspace/activate'");
    expect(activation).not.toContain('selectStoredWorkspace(');
    expect(activation).not.toContain('storedSessionForCredential(');
  });
});
