/**
 * What a message may weigh, said once.
 *
 * Its own module rather than a section of `index` because the schemas that
 * spend it are not all downstream of `index`: the substream contracts are
 * imported by the parent-object contract, which `index` imports in turn, and a
 * cap reached for through `index` would close that cycle and be `undefined` in
 * whichever module the cycle was entered from. A constant with no dependencies
 * of its own has no such problem.
 */

/**
 * The most text one message from a person may carry — an opening message that
 * starts a work stream, or a reply sent into one.
 *
 * One number, shared by every schema on the path a composed message travels, so
 * that a message the composer accepted cannot be refused further in. That is not
 * hypothetical tidiness: the opening message was bounded here at 50,000 while
 * the description derived from it was bounded at 4,000, and a paste between the
 * two passed the route, reserved an email address and wrote its D1 rows, then
 * failed inside the Durable Object with `invalid_product_request` — a message
 * about loading, for a create, naming nothing the person could act on.
 *
 * 100,000 characters is roughly 25,000 tokens: large enough for the pasted
 * template or transcript people actually open work streams with, and still a
 * fraction of any model context Avalon runs against. It is a product ceiling
 * rather than a safety one — over it, a person is told to shorten the message,
 * never silently given a shortened one.
 */
export const MESSAGE_MAX_CHARACTERS = 100_000;

/**
 * The one sentence a person is shown when a message is over that ceiling.
 *
 * Lives here so the composer and the API say the same thing: the desktop stops
 * an over-long message before it is sent, and the API refuses one that reaches
 * it anyway, and a person who meets both must not be told two different things.
 *
 * Grouped by hand rather than with `toLocaleString`. This string is a contract
 * evaluated separately in three runtimes — workerd, Electron's renderer, and
 * whichever Node runs the tests — and `toLocaleString` reads ICU data that a
 * runtime is free to have been built without. The failure that would cause is
 * the worst kind for a constant whose whole purpose is that both sides say the
 * same words: not an error, just a client and a server disagreeing by one comma.
 * The digits here are ASCII and the ceiling is a literal, so the sentence is the
 * same everywhere it is read.
 */
export const MESSAGE_TOO_LONG_MESSAGE =
  `This message is over ${String(MESSAGE_MAX_CHARACTERS).replace(/\B(?=(\d{3})+$)/gu, ",")} characters, please shorten it.`;
