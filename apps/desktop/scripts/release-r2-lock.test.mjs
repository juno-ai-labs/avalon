import assert from 'node:assert/strict';
import test from 'node:test';

import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { createR2ReleaseLockClient, withR2ReleaseLock } from './release-r2-lock.mjs';

class FakeR2Client {
  failDelete = false;

  locked = false;

  events = [];

  async send(command) {
    if (command instanceof PutObjectCommand) {
      this.events.push(['put', command.input.IfNoneMatch]);
      if (this.locked) {
        const error = new Error('conflict');
        error.name = 'PreconditionFailed';
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      this.locked = true;
      return { ETag: 'lock-etag' };
    }
    assert.ok(command instanceof DeleteObjectCommand);
    this.events.push(['delete']);
    if (this.failDelete) throw new Error('delete failed');
    this.locked = false;
    return {};
  }
}

test('a second publisher cannot enter while the first holds the remote lock', async () => {
  const client = new FakeR2Client();
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered = false;
  const first = withR2ReleaseLock({
    bucket: 'releases',
    client,
    key: 'stable/release-publish.lock',
    owner: 'first',
    operation: async () => {
      firstEntered = true;
      await firstCanFinish;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstEntered, true);

  let secondEntered = false;
  await assert.rejects(
    withR2ReleaseLock({
      bucket: 'releases',
      client,
      key: 'stable/release-publish.lock',
      owner: 'second',
      operation: async () => { secondEntered = true; },
    }),
    /Another desktop release publisher holds/u,
  );
  assert.equal(secondEntered, false);

  releaseFirst();
  await first;
  assert.deepEqual(client.events, [['put', '*'], ['put', '*'], ['delete']]);
});

test('the remote lock is released when publication fails', async () => {
  const client = new FakeR2Client();
  await assert.rejects(
    withR2ReleaseLock({
      bucket: 'releases',
      client,
      key: 'stable/release-publish.lock',
      operation: async () => { throw new Error('publish failed'); },
    }),
    /publish failed/u,
  );
  assert.equal(client.locked, false);
});

test('a cleanup failure reports the shipped release and lets tag and record steps continue', async () => {
  const client = new FakeR2Client();
  client.failDelete = true;
  const reports = [];
  const result = await withR2ReleaseLock({
    bucket: 'releases',
    client,
    key: 'stable/release-publish.lock',
    operation: async () => 'published',
    reportCleanupFailure: (message) => reports.push(message),
  });
  assert.equal(result, 'published');
  assert.deepEqual(reports, [
    'Desktop release publication completed, but its remote lock could not be released at r2://releases/stable/release-publish.lock; confirm no publisher is active and remove only that lock before the next release',
  ]);
  assert.equal(client.locked, true);
});

test('account token verification derives an R2 S3 client without exposing the token', async () => {
  let request;
  const client = await createR2ReleaseLockClient({
    accountId: '0123456789abcdef0123456789abcdef',
    apiToken: 'parent-token-value',
    fetchImplementation: async (url, init) => {
      request = { url, init };
      return Response.json({
        success: true,
        errors: [],
        result: { id: 'abcdef0123456789abcdef0123456789', status: 'active' },
      });
    },
  });
  assert.ok(client);
  client.destroy();
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/tokens/verify');
  assert.equal(request.init.headers.authorization, 'Bearer parent-token-value');
});

test('legacy user-owned release tokens fall back to the user verification endpoint', async () => {
  const urls = [];
  const client = await createR2ReleaseLockClient({
    accountId: '0123456789abcdef0123456789abcdef',
    apiToken: 'user-token-value',
    fetchImplementation: async (url) => {
      urls.push(url);
      if (url.includes('/accounts/')) {
        return Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 403 });
      }
      return Response.json({
        success: true,
        errors: [],
        result: { id: '0123456789abcdef0123456789abcdef', status: 'active' },
      });
    },
  });
  client.destroy();
  assert.deepEqual(urls, [
    'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/tokens/verify',
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
  ]);
});

test('credential-resolution failures do not expose the API token', async () => {
  const apiToken = 'release-token-must-not-leak';
  await assert.rejects(
    createR2ReleaseLockClient({
      accountId: '0123456789abcdef0123456789abcdef',
      apiToken,
      fetchImplementation: async () => { throw new Error(`transport rejected ${apiToken}`); },
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(apiToken, 'u'));
      assert.match(error.message, /transport failure/u);
      return true;
    },
  );
});
