import { OnboardingJourneySchema, StoredOnboardingConnectorSelectionsSchema, UpdateOnboardingJourneySchema, type OnboardingJourney, type UpdateOnboardingJourney } from '@rally/contracts';
import { z } from 'zod';

export const ONBOARDING_JOURNEY_SQL = `CREATE TABLE onboarding_journeys (
  user_id TEXT PRIMARY KEY,
  path TEXT NOT NULL CHECK (path IN ('creator', 'member')),
  stage TEXT NOT NULL CHECK (stage IN ('connectors', 'people', 'profile', 'complete')),
  revision INTEGER NOT NULL DEFAULT 0,
  connector_ids TEXT NOT NULL DEFAULT '[]'
) STRICT`;

/** All calls run synchronously inside the owning workspace object. */
export class OnboardingJourneyStore {
  constructor(private readonly sql: SqlStorage) {}

  get(userId: string, path: 'creator' | 'member'): OnboardingJourney {
    z.string().uuid().parse(userId);
    this.sql.exec(`INSERT INTO onboarding_journeys(user_id, path, stage)
      VALUES (?, ?, 'profile') ON CONFLICT(user_id) DO NOTHING`, userId, path);
    const row = this.sql.exec<{ path: string; stage: string; revision: number; connector_ids: string }>(
      'SELECT * FROM onboarding_journeys WHERE user_id = ?', userId).one();
    return OnboardingJourneySchema.parse({ path: row.path, stage: row.stage, revision: row.revision,
      connectorIds: StoredOnboardingConnectorSelectionsSchema.parse(JSON.parse(row.connector_ids)) });
  }

  update(userId: string, path: 'creator' | 'member', raw: UpdateOnboardingJourney): OnboardingJourney | null {
    const input = UpdateOnboardingJourneySchema.parse(raw);
    const current = this.get(userId, path);
    if (current.stage === input.stage) return current;
    if (current.revision !== input.expectedRevision) return null;
    // Personal setup leads to connecting Gmail and Google Drive, and that to
    // adding teammates (a creator) or to the end (a member). Personal setup may
    // still skip the connectors step: a host that cannot connect accounts asks
    // for the next stage directly, as clients built before the step do.
    const after = path === 'creator' ? 'people' : 'complete';
    const next: Record<OnboardingJourney['stage'], OnboardingJourney['stage'][]> = {
      profile: ['connectors', after], connectors: [after], people: path === 'creator' ? ['complete'] : [],
      complete: [],
    };
    if (!next[current.stage].includes(input.stage)) return null;
    this.sql.exec('UPDATE onboarding_journeys SET stage = ?, revision = revision + 1 WHERE user_id = ?', input.stage, userId);
    return this.get(userId, path);
  }

}
