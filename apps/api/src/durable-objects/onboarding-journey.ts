import { OnboardingJourneySchema, UpdateOnboardingJourneySchema, type OnboardingJourney, type UpdateOnboardingJourney } from '@rally/contracts';
import { z } from 'zod';
import { uuidV7 } from '../lib/uuid-v7';

export const ONBOARDING_JOURNEY_SQL = `CREATE TABLE onboarding_journeys (
  user_id TEXT PRIMARY KEY,
  path TEXT NOT NULL CHECK (path IN ('creator', 'member')),
  stage TEXT NOT NULL CHECK (stage IN ('connectors', 'people', 'profile', 'example', 'complete', 'skipped')),
  revision INTEGER NOT NULL DEFAULT 0,
  starter_workstream_id TEXT,
  starter_message_id TEXT NOT NULL,
  starter_prompt TEXT
) STRICT`;

/** All calls run synchronously inside the owning workspace object. */
export class OnboardingJourneyStore {
  constructor(private readonly sql: SqlStorage) {}

  get(userId: string, path: 'creator' | 'member'): OnboardingJourney {
    z.string().uuid().parse(userId);
    this.sql.exec(`INSERT INTO onboarding_journeys(user_id, path, stage, starter_message_id)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`, userId, path,
    path === 'creator' ? 'connectors' : 'profile', uuidV7());
    const row = this.sql.exec<{ path: string; stage: string; revision: number; starter_workstream_id: string | null; starter_message_id: string; connector_ids: string }>(
      'SELECT * FROM onboarding_journeys WHERE user_id = ?', userId).one();
    return OnboardingJourneySchema.parse({ path: row.path, stage: row.stage, revision: row.revision,
      starterWorkstreamId: row.starter_workstream_id, starterMessageId: row.starter_message_id, connectorIds: JSON.parse(row.connector_ids) });
  }

  update(userId: string, path: 'creator' | 'member', raw: UpdateOnboardingJourney): OnboardingJourney | null {
    const input = UpdateOnboardingJourneySchema.parse(raw);
    const current = this.get(userId, path);
    if ((!input.connectorIds || JSON.stringify(input.connectorIds) === JSON.stringify(current.connectorIds)) && current.stage === input.stage && (!input.starterWorkstreamId || current.starterWorkstreamId === input.starterWorkstreamId)) return current;
    if (current.revision !== input.expectedRevision) return null;
    const next: Record<OnboardingJourney['stage'], OnboardingJourney['stage'][]> = {
      connectors: path === 'creator' ? ['connectors', 'profile'] : [], people: path === 'creator' ? ['complete'] : [], profile: path === 'creator' ? ['people'] : ['complete'],
      example: ['example', 'complete', 'skipped'], complete: [], skipped: ['complete'],
    };
    if (!next[current.stage].includes(input.stage)) return null;
    if (input.starterWorkstreamId && current.starterWorkstreamId && current.starterWorkstreamId !== input.starterWorkstreamId) return null;
    this.sql.exec(`UPDATE onboarding_journeys SET stage = ?, revision = revision + 1,
      starter_workstream_id = COALESCE(starter_workstream_id, ?), connector_ids = ? WHERE user_id = ?`,
    input.stage, input.starterWorkstreamId ?? null, JSON.stringify(input.connectorIds ?? current.connectorIds), userId);
    return this.get(userId, path);
  }

}
