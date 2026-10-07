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
    // Every journey now starts at personal setup. Connecting tools left the
    // journey for Settings; a journey stored at that retired stage moves on
    // to the next one, which a creator reached from it before.
    this.sql.exec(`INSERT INTO onboarding_journeys(user_id, path, stage)
      VALUES (?, ?, 'profile') ON CONFLICT(user_id) DO UPDATE SET stage = 'profile', revision = revision + 1
      WHERE onboarding_journeys.stage = 'connectors'`, userId, path);
    const row = this.sql.exec<{ path: string; stage: string; revision: number; connector_ids: string }>(
      'SELECT * FROM onboarding_journeys WHERE user_id = ?', userId).one();
    return OnboardingJourneySchema.parse({ path: row.path, stage: row.stage, revision: row.revision,
      connectorIds: StoredOnboardingConnectorSelectionsSchema.parse(JSON.parse(row.connector_ids)) });
  }

  update(userId: string, path: 'creator' | 'member', raw: UpdateOnboardingJourney): OnboardingJourney | null {
    const input = UpdateOnboardingJourneySchema.parse(raw);
    const current = this.get(userId, path);
    if ((!input.connectorIds || JSON.stringify(input.connectorIds) === JSON.stringify(current.connectorIds)) && current.stage === input.stage) return current;
    if (current.revision !== input.expectedRevision) return null;
    const next: Record<OnboardingJourney['stage'], OnboardingJourney['stage'][]> = {
      connectors: [], people: path === 'creator' ? ['complete'] : [], profile: path === 'creator' ? ['people'] : ['complete'],
      complete: [],
    };
    if (!next[current.stage].includes(input.stage)) return null;
    this.sql.exec(`UPDATE onboarding_journeys SET stage = ?, revision = revision + 1,
      connector_ids = ? WHERE user_id = ?`,
    input.stage, JSON.stringify(input.connectorIds ?? current.connectorIds), userId);
    return this.get(userId, path);
  }

}
