import assert from 'node:assert/strict';
import test from 'node:test';

import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import {
  R2ReleaseLockHeldError,
  createR2ReleaseLockClient,
  withR2ReleaseLock,
} from './release-r2-lock.mjs';

class FakeR2Client {
  etagCounter = 0;

  failRelease = false;

  exists = false;

  lockBody;

  lockEtag;

  lockState;

  lockOwner;

  events = [];

  async send(command) {
    if (command instanceof PutObjectCommand) {
      if (command.input.IfNoneMatch === '*') {
        this.events.push(['acquire', command.input.Body]);
        if (this.exists) {
          const error = new Error('conflict');
          error.name = 'PreconditionFailed';
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
      } else {
        this.events.push([
          command.input.Metadata?.state ?? 'unknown',
          command.input.Body,
          command.input.IfMatch,
        ]);
        if (
          command.input.IfMatch !== undefined
          && (!this.exists || command.input.IfMatch !== this.lockEtag)
        ) {
          const error = new Error('generation changed');
          error.name = 'PreconditionFailed';
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
        if (this.failRelease && command.input.Metadata?.state === 'released') {
          throw new Error('release marker failed');
        }
      }
      this.exists = true;
      this.lockBody = command.input.Body;
      this.lockOwner = command.input.Metadata?.owner;
      this.lockState = command.input.Metadata?.state;
      this.etagCounter += 1;
      this.lockEtag = `etag-${this.etagCounter}`;
      return { ETag: this.lockEtag };
    }
    assert.ok(command instanceof HeadObjectCommand, 'Expected a lock metadata read');
    this.events.push(['head']);
    if (!this.exists) throw new Error('lock missing');
    return {
      ETag: this.lockEtag,
      Metadata: { owner: this.lockOwner, state: this.lockState },
    };
  }

  recoverAbandonedLock() {
    if (!this.exists) throw new Error('No abandoned lock to recover');
    this.exists = false;
    this.lockBody = undefined;
    this.lockEtag = undefined;
    this.lockOwner = undefined;
    this.lockState = undefined;
    this.events.push(['manual-recovery']);
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
    (error) => {
      assert.ok(error instanceof R2ReleaseLockHeldError);
      assert.match(error.message, /Another desktop release publisher holds .* owner="first"/u);
      return true;
    },
  );
  assert.equal(secondEntered, false);

  releaseFirst();
  await first;
  assert.deepEqual(client.events, [
    ['acquire', 'first'],
    ['acquire', 'second'],
    ['head'],
    ['released', 'released:first', 'etag-1'],
  ]);
  assert.equal(client.lockState, 'released');
});

test('the next publisher atomically acquires the persistent released generation', async () => {
  const client = new FakeR2Client();
  const cleanupReports = [];
  await withR2ReleaseLock({
    bucket: 'releases',
    client,
    key: 'stable/release-publish.lock',
    owner: 'first',
    operation: async () => undefined,
    reportCleanupFailure: (message) => cleanupReports.push(message),
  });
  let secondEntered = false;
  await withR2ReleaseLock({
    bucket: 'releases',
    client,
    key: 'stable/release-publish.lock',
    owner: 'second',
    operation: async () => { secondEntered = true; },
    reportCleanupFailure: (message) => cleanupReports.push(message),
  });
  assert.equal(secondEntered, true);
  assert.deepEqual(cleanupReports, []);
  assert.deepEqual(client.events, [
    ['acquire', 'first'],
    ['released', 'released:first', 'etag-1'],
    ['acquire', 'second'],
    ['head'],
    ['active', 'second', 'etag-2'],
    ['released', 'released:second', 'etag-3'],
  ]);
});

test('a resumed old owner cannot delete a newer publisher lock after manual recovery', async () => {
  const client = new FakeR2Client();
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const firstReports = [];
  const first = withR2ReleaseLock({
    bucket: 'releases',
    client,
    key: 'stable/release-publish.lock',
    owner: 'first',
    operation: async () => { await firstCanFinish; },
    reportCleanupFailure: (message) => firstReports.push(message),
  });
  await new Promise((resolve) => setImmediate(resolve));

  client.recoverAbandonedLock();
  let releaseSecond;
  const secondCanFinish = new Promise((resolve) => { releaseSecond = resolve; });
  const second = withR2ReleaseLock({
    bucket: 'releases',
    client,
    key: 'stable/release-publish.lock',
    owner: 'second',
    operation: async () => { await secondCanFinish; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lockBody, 'second');

  releaseFirst();
  await first;
  assert.equal(firstReports.length, 1);
  assert.equal(client.lockBody, 'second');

  releaseSecond();
  await second;
  assert.equal(client.lockState, 'released');
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
  assert.equal(client.lockState, 'released');
});

test('a cleanup failure reports the shipped release and lets tag and record steps continue', async () => {
  const client = new FakeR2Client();
  client.failRelease = true;
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
    'Desktop release publication completed, but its remote lock could not be marked released at r2://releases/stable/release-publish.lock; confirm no publisher is active and recover only that lock before the next release',
  ]);
  assert.equal(client.lockState, 'active');
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
        result: { id: 'ABCDEF0123456789ABCDEF0123456789', status: 'active' },
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
