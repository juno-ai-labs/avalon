import type { ProductFeatureFlagKey } from '@avalon/contracts';
import type { AccessEnvironment } from './access';

export interface FlagChangeMessage {
  kind: 'flagship_product_flag_changed';
  flagKey: ProductFeatureFlagKey;
}

export interface Env extends AccessEnvironment {
  ASSETS: Fetcher;
  GLOBAL_DB: D1Database;
  EU_DB: D1Database;
  PRODUCT_FLAG_CHANGE_QUEUE: Queue<FlagChangeMessage>;
  GLOBAL_PRODUCT_FLAG_QUEUE: Queue;
  EU_PRODUCT_FLAG_QUEUE: Queue;
  APP_ENV: 'development' | 'test' | 'staging' | 'production';
  APP_VERSION?: string;
  ACE_DEV_AUTH?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  FLAGSHIP_APP_ID: string;
  CLOUDFLARE_FLAGSHIP_API_TOKEN: string;
}

export function devAuthEnabled(env: Env): boolean {
  return env.APP_ENV === 'development' && env.ACE_DEV_AUTH === 'true';
}
