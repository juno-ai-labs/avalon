import {
  ProductAnalyticsPreferenceSchema,
  type ProductAnalyticsPreference,
} from '@rally/contracts/telemetry';

type PreferenceRequest = (path: string, options: {
  method: 'GET' | 'PATCH';
  schema: typeof ProductAnalyticsPreferenceSchema;
  body?: { enabled: boolean; expectedVersion: number };
  signal?: AbortSignal;
}) => Promise<ProductAnalyticsPreference>;

/** One account-preference protocol over native bearer or browser cookie transport. */
export class ProductAnalyticsPreferenceClient {
  constructor(private readonly request: PreferenceRequest) {}

  read(signal?: AbortSignal): Promise<ProductAnalyticsPreference> {
    return this.request('/telemetry/preference', {
      method: 'GET', schema: ProductAnalyticsPreferenceSchema, signal,
    });
  }

  async update(enabled: boolean, expectedVersion: number): Promise<ProductAnalyticsPreference> {
    try {
      return await this.request('/telemetry/preference', {
        method: 'PATCH', schema: ProductAnalyticsPreferenceSchema,
        body: { enabled, expectedVersion },
      });
    } catch (error) {
      // Another device won the compare-and-set. Read its choice; never replay
      // a stale write over the current account preference.
      if (error instanceof Error && 'status' in error && error.status === 409) return this.read();
      throw error;
    }
  }
}
