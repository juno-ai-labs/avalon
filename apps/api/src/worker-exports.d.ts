/**
 * Teach `ctx.exports` what this Worker exports.
 *
 * `Cloudflare.Exports` — the type of `ctx.exports`, the loopback bindings for
 * every top-level export — is derived from `GlobalProps["mainModule"]`, which
 * is empty until a project declares it. Without this, minting a loopback stub
 * for `ArtifactAssetLoopback` is an error on a property TypeScript cannot see,
 * and the alternative is a cast that would also silently accept a name no
 * longer exported.
 *
 * `wrangler types` generates this file in other projects. It is written by hand
 * here because the repository does not check in a generated
 * `worker-configuration.d.ts`, and because pointing at the real entry module is
 * what keeps the two in step: delete an export and its loopback stops
 * type-checking.
 */
import type * as MainModule from "./index";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof MainModule;
    }
  }
}
