/**
 * Read an Ace route's JSON answer and parse it with the contract the page
 * names, or throw the sentence the route gave. Shared by every page that
 * contract-parses its responses.
 */
export async function responseBody<Result>(response: Response, parse: (value: unknown) => Result): Promise<Result> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    const failure = body as { error?: string; message?: string } | null;
    throw new Error(failure?.message ?? failure?.error ?? `Request failed (${response.status})`);
  }
  try {
    return parse(body);
  } catch {
    // A shape this build does not recognise is a sentence, not a dump of the
    // issue list: Ace's Worker already parsed the regional answer, so this
    // fires only when the page and its Worker are on different versions.
    throw new Error('The answer was not in a shape this version of Ace recognises; reload the page.');
  }
}
