/** Disposable measurement Worker. Bind only AUTHORIZATION_CACHE and a temporary PROBE_TOKEN.
 * Deploy separate copies with placement.region hints. Never serve product authorization records.
 */
export default {
  async fetch(request, env) {
    if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`) return new Response(null, { status: 401 });
    const id = new URL(request.url).pathname.slice(1);
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(id)) return new Response(null, { status: 400 });
    const key = `measurement:kv-visibility:${id}`;
    const startedAt = Date.now();
    let value;
    if (request.method === 'POST') {
      value = { version: crypto.randomUUID(), mutationAt: startedAt };
      await env.AUTHORIZATION_CACHE.put(key, JSON.stringify(value));
    } else if (request.method === 'DELETE') {
      await env.AUTHORIZATION_CACHE.delete(key);
      return new Response(null, { status: 204 });
    } else if (request.method === 'GET') {
      value = await env.AUTHORIZATION_CACHE.get(key, 'json');
    } else return new Response(null, { status: 405 });
    return Response.json({ value, completedAt: Date.now(), kvMs: Date.now() - startedAt,
      executionPlacement: request.headers.get('cf-placement'), ingressColo: request.cf?.colo ?? null, placement: env.PROBE_PLACEMENT ?? 'default' },
    { headers: { 'cache-control': 'no-store' } });
  },
};
