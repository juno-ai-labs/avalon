import assert from 'node:assert/strict';
import test from 'node:test';

import { provisionSupabaseStorage } from './provision-supabase-storage.mjs';

test('provisions missing buckets and reconciles existing buckets through the Storage API', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const stored = new Map([
    ['connector-ingress', { id: 'connector-ingress', name: 'connector-ingress', public: false, file_size_limit: 536_870_912 }],
    ['exports', { id: 'exports', name: 'exports', public: false, file_size_limit: 536_870_912 }],
  ]);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const match = String(url).match(/\/bucket\/([^/]+)$/u);
    const id = match?.[1];
    if (init.method === 'GET') {
      const bucket = id ? stored.get(id) : undefined;
      return bucket
        ? Response.json(bucket)
        : new Response('', { status: 404 });
    }
    const body = JSON.parse(init.body);
    stored.set(body.id, body);
    return Response.json(body);
  };
  try {
    await provisionSupabaseStorage({
      projectUrl: 'https://regional.example.supabase.co',
      serviceRoleKey: 'test-service-role-key',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.filter(({ init }) => init.method === 'GET').length, 6);
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 1);
  assert.equal(calls.filter(({ init }) => init.method === 'PUT').length, 2);
  for (const { init } of calls) {
    assert.equal(init.headers.apikey, 'test-service-role-key');
    assert.equal(init.headers.authorization, 'Bearer test-service-role-key');
  }
});

for (const method of ['POST', 'PUT']) {
  test(`rejects a ${method} mutation that returns 404`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (init.method === 'GET') {
        const exists = method === 'PUT';
        return exists
          ? Response.json({
            id: 'workspace-content', name: 'workspace-content', public: false,
            file_size_limit: 536_870_912,
          })
          : new Response('', { status: 404 });
      }
      return new Response('wrong route', { status: 404 });
    };
    try {
      await assert.rejects(
        provisionSupabaseStorage({
          projectUrl: 'https://regional.example.supabase.co',
          serviceRoleKey: 'test-service-role-key',
        }),
        /supabase_storage_request_failed:404/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('rejects a bucket whose post-write configuration does not match', async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (_url, init) => {
    if (init.method !== 'GET') return Response.json({});
    reads += 1;
    if (reads === 1) return new Response('', { status: 404 });
    return Response.json({
      id: 'workspace-content', name: 'workspace-content', public: true,
      file_size_limit: 536_870_912,
    });
  };
  try {
    await assert.rejects(
      provisionSupabaseStorage({
        projectUrl: 'https://regional.example.supabase.co',
        serviceRoleKey: 'test-service-role-key',
      }),
      /supabase_storage_bucket_configuration_mismatch:workspace-content/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
