import { describe, expect, it } from 'vitest';
import { assertSafePublicUrl } from '../src/lib/public-web-url';

describe('public URL literal-address fence', () => {
  it.each(['http://[0:0:0:0:0:0:0:1]/', 'http://[fec0::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/', 'http://127.1/', 'https://host.internal/'])('refuses %s', (url) => {
    expect(() => assertSafePublicUrl(url)).toThrow('Private and local');
  });
  it('accepts public HTTPS without credentials', () => {
    expect(() => assertSafePublicUrl('https://example.com/')).not.toThrow();
  });
});
