import { regionConfiguration } from '@rally/contracts/regions';
import { NativeCrashUploader } from '../../../src/main/native-crash-uploader.ts';
import { prepareNativeCrashGeneration } from '../../../src/main/native-crash-generation.ts';
import { resolveTelemetryRoute } from '../../../src/main/telemetry-route.ts';

const anonymousEpochId = '00000000-0000-7000-8000-000000000010';
const installationId = '00000000-0000-7000-8000-000000000011';

export async function prepareFixtureGeneration(input) {
  const route = await resolveTelemetryRoute({
    explicitRegion: null,
    anonymousEpochId,
    globalApiBaseUrl: 'https://api.rallywith.ai',
    fetch: async () => new Response(JSON.stringify({
      journeyId: '00000000-0000-7000-8000-000000000012',
      route: input.route,
      routingBasis: 'ip_geolocation',
      capability: 'fixture-capability'.repeat(3),
      expiresAt: '2099-01-01T00:00:00.000Z',
    }), { status: 201, headers: { 'content-type': 'application/json' } }),
  });
  const generation = await prepareNativeCrashGeneration({
    rootDirectory: input.rootDirectory,
    route: route.route,
    now: new Date(input.now),
    generationId: input.generationId,
    runtime: input.runtime,
  });
  return { route, generation };
}

export async function uploadFixtureGeneration(input) {
  const requests = [];
  const uploader = new NativeCrashUploader({
    rootDirectory: input.rootDirectory,
    enabled: () => true,
    identity: () => ({ installationId }),
    authenticatedSession: async () => ({
      apiBaseUrl: regionConfiguration(input.route).apiUrl,
      accessToken: 'fixture-session',
      route: input.route,
    }),
    anonymousSession: () => null,
    globalApiBaseUrl: 'https://api.rallywith.ai',
    fetch: async (url, init) => {
      const metadata = JSON.parse(String(init.body.get('metadata')));
      requests.push({ endpoint: String(url), metadata });
      return new Response(JSON.stringify({
        result: 'accepted',
        uploadId: metadata.uploadId,
      }), { status: 202 });
    },
  });
  await uploader.flush();
  return requests;
}
