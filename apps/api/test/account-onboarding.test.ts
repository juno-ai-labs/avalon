import { RegionalOnboardingService } from '../src/services/platform-onboarding-service';
import { describe, expect, it } from 'vitest';
import { asUserId } from '@rally/contracts';
import { AccountOnboardingService } from '../src/services/account-onboarding-service';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestEnv } from './helpers/cloudflare-test';

const userId = asUserId('00000000-0000-7000-8000-000000000001');
const auth = { userId, sessionId: 'onboarding-test', workspaceId: null, region: 'global' as const, role: null };

describe('account onboarding authority', () => {
  it('persists appearance across sessions and rejects stale overwrites', async () => {
    const db = migratedSqliteDatabase();
    db.prepare(`INSERT INTO users(id, google_subject, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, 'new-google-user', 'new@example.com', 'New user', new Date().toISOString(), new Date().toISOString());
    const env = createTestEnv({ DB: sqliteD1(db), AVALON_REGION: 'global' });
    const first = new AccountOnboardingService(env, auth);
    expect(await first.get()).toMatchObject({ eligible: true, introduced: false, revision: 0, presentation: null });
    await first.update({ expectedRevision: 0, introduced: true });
    const saved = await first.update({ expectedRevision: 1, presentation: { color: 'rose', avatar: 'flower', displayName: 'Alex Rivera', initials: 'AR' } });
    expect(db.prepare('SELECT name FROM users WHERE id = ?').get(userId)).toMatchObject({ name: 'Alex Rivera' });
    const second = new AccountOnboardingService(env, { ...auth, sessionId: 'second-session' });
    expect(await second.get()).toEqual(saved);
    expect(await second.update({ expectedRevision: 1, presentation: { color: 'rose', avatar: 'flower', displayName: 'Alex Rivera', initials: 'AR' } })).toEqual(saved);
    await expect(second.update({ expectedRevision: 1, presentation: { color: 'blue', avatar: 'circle' } })).rejects.toMatchObject({ code: 'profile_revision_conflict' });
    expect((await first.get()).presentation).toMatchObject({ color: 'rose', avatar: 'flower', displayName: 'Alex Rivera', initials: 'AR' });
    await first.update({ expectedRevision: saved.revision, presentation: { color: 'blue', avatar: 'circle' } });
    expect((await second.get()).presentation).toMatchObject({ color: 'blue', displayName: 'Alex Rivera', initials: 'AR' });
    db.close();
  });
});

it('projects identity appearance into EU without letting older revisions overwrite it', async () => {
  const db = migratedSqliteDatabase();
  const env = createTestEnv({ DB: sqliteD1(db), AVALON_REGION: 'eu' });
  const service = new RegionalOnboardingService(env);
  const identity = { platformUserId: userId, googleSubject: 'global-person', email: 'person@example.com',
    name: 'Person', avatarUrl: null, timezone: 'Europe/Paris', createdAt: new Date().toISOString() };
  await service.discover({ ...identity, accountOnboarding: { eligible: false, introduced: true, revision: 0, presentation: null } });
  expect(db.prepare('SELECT onboarding_eligible FROM users WHERE platform_user_id = ?').get(userId)).toMatchObject({ onboarding_eligible: 0 });
  const presentation = { displayName: 'Chosen Name', initials: 'CN', color: 'violet' as const, avatar: 'flower' as const, revision: 2 };
  await service.discover({ ...identity, accountOnboarding: { eligible: true, introduced: true, revision: 2, presentation } });
  await service.discover({ ...identity, accountOnboarding: { eligible: true, introduced: true, revision: 1, presentation: { color: 'blue', avatar: 'circle', revision: 1 } } });
  db.exec(`CREATE TRIGGER reject_repeated_projection BEFORE UPDATE OF onboarding_revision ON users BEGIN SELECT RAISE(FAIL, 'duplicate projection'); END;`);
  await service.discover({ ...identity, accountOnboarding: { eligible: true, introduced: true, revision: 2, presentation } });
  const row = db.prepare('SELECT name, onboarding_revision, presentation_json FROM users WHERE platform_user_id = ?').get(userId);
  expect(row).toMatchObject({ name: 'Chosen Name', onboarding_revision: 2, presentation_json: JSON.stringify(presentation) });
  db.close();
});
