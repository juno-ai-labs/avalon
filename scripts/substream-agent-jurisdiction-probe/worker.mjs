/**
 * Remote-development-only Durable Object ID classifier.
 *
 * Parsing an ID through an unrestricted external namespace binding does not
 * open or create its object. It exposes the jurisdiction Cloudflare encoded in
 * the ID so the one-off fleet migration can avoid sending legacy unrestricted
 * IDs to a regional binding that cannot address them.
 */
export default {
  async fetch(request, environment) {
    if (request.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
    const input = await request.json();
    const namespace = input.region === 'global'
      ? environment.GLOBAL_SUBSTREAM_AGENTS
      : input.region === 'eu'
        ? environment.EU_SUBSTREAM_AGENTS
        : null;
    if (!namespace) {
      return new Response('invalid_request', { status: 400 });
    }
    if (input.operation === 'resolve') {
      if (!Array.isArray(input.objectNames)) {
        return new Response('invalid_request', { status: 400 });
      }
      const regionalNamespace = namespace.jurisdiction(input.region === 'global' ? 'us' : 'eu');
      return Response.json({
        objects: input.objectNames.map((objectName) => {
          try {
            if (typeof objectName !== 'string' || objectName.length === 0) {
              throw new Error('invalid_object_name');
            }
            return { objectName, objectId: regionalNamespace.idFromName(objectName).toString() };
          } catch (error) {
            return { objectName, error: error instanceof Error ? error.message : 'unknown' };
          }
        }),
      });
    }
    if (!Array.isArray(input.objectIds)) {
      return new Response('invalid_request', { status: 400 });
    }
    if ((input.operation ?? 'classify') === 'classify') {
      return Response.json({
        objects: input.objectIds.map((objectId) => {
          try {
            const id = namespace.idFromString(objectId);
            return { objectId, jurisdiction: id.jurisdiction ?? null };
          } catch (error) {
            return { objectId, error: error instanceof Error ? error.message : 'unknown' };
          }
        }),
      });
    }
    return new Response('invalid_operation', { status: 400 });
  },
};
