import type { ProductFeatureFlagKey } from '@rally/contracts';
import type { AccessEnvironment } from './access';

export interface FlagChangeMessage {
  kind: 'flagship_product_flag_changed';
  flagKey: ProductFeatureFlagKey;
}

export interface Env extends AccessEnvironment {
  ASSETS: Fetcher;
  GLOBAL_DB: D1Database;
  [binding: `${string}_DB`]: D1Database;
  PRODUCT_FLAG_CHANGE_QUEUE: Queue<FlagChangeMessage>;
  GLOBAL_PRODUCT_FLAG_QUEUE: Queue;
  [binding: `${string}_PRODUCT_FLAG_QUEUE`]: Queue;
  APP_ENV: 'development' | 'test' | 'staging' | 'production';
  APP_VERSION?: string;
  ACE_DEV_AUTH?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  FLAGSHIP_APP_ID: string;
  /** Historical name; the dedicated Ace token also holds Queues Edit. */
  CLOUDFLARE_FLAGSHIP_API_TOKEN: string;
  /**
   * The regional API Workers Ace's operator pages call, and the operator
   * token presented to each. One token per region, held by that
   * region's operator configuration in the `demos` role (the stored name of
   * Ace's operator role) and by nobody else's:
   * an operator credential never crosses regions, so a leak of one is
   * destructive authority in one jurisdiction rather than both. The base URLs
   * are configuration, never derived from a request. See `docs/ace.md`.
   */
  RALLY_API_BASE_URL: string;
  [binding: `RALLY_${string}_API_BASE_URL`]: string;
  RALLY_OPERATOR_TOKEN: string;
  [binding: `RALLY_${string}_OPERATOR_TOKEN`]: string;
}

export function devAuthEnabled(env: Env): boolean {
  return env.APP_ENV === 'development' && env.ACE_DEV_AUTH === 'true';
}
