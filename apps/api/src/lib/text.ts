/**
 * The canonical implementation lives in `@avalon/contracts`, beside the schemas
 * whose `max()` bounds it enforces, so `@avalon/db` can apply the same bound to
 * the same column. Re-exported here because every existing call site in this app
 * imports it from this path.
 */
export { truncateUtf16Safe } from "@avalon/contracts/text";
