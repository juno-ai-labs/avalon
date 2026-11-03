/**
 * The wrapper both execution paths put in front of the `ASSETS` loopback.
 *
 * The binding that crosses into an artifact's isolate is an RPC stub for
 * `ArtifactAssetLoopback`, and a stub's `fetch` is the runtime's own Fetcher:
 * it requires an absolute URL and throws `Invalid URL: /signups.json` on the
 * relative string the skill teaches for reading a published data file
 * server-side. The declared contract is `fetch(request: Request | string)`, so
 * something has to accept the string and hand the stub a Request.
 *
 * That something is Rally's, and it runs *inside* the artifact's isolate —
 * there is nowhere else for it to run, because the throw happens in the caller
 * before the stub is dialled. It is a source string for the same reason the
 * facet host is: it is loaded into the artifact's worker, not compiled with
 * this one.
 *
 * The placeholder origin is discarded. `ArtifactAssetLoopback` reads only the
 * pathname and resolves it against the published file list, so nothing here can
 * name a file the supervisor did not put in the stub's props.
 *
 * See `docs/live-web-artifacts.md`.
 */
import { artifactIsolateId } from "@rally/contracts";

export const ASSET_SHIM_MODULE = "__rally_assets.js";

export const ASSET_SHIM_SOURCE = `
export function wrapAssets(binding) {
  return {
    fetch(request) {
      if (typeof request !== "string") return binding.fetch(request);
      let url;
      try {
        url = new URL(request, "https://artifact.invalid");
      } catch {
        url = new URL("/" + request.replace(/^\\/+/, ""), "https://artifact.invalid");
      }
      return binding.fetch(new Request(url.toString()));
    },
  };
}
`;

/** The module Rally runs in front of a stateless active site's own. */
export const LOADER_ENTRY_MODULE = "__rally_entry.js";

/**
 * A stateless active site's module is imported rather than run directly.
 *
 * It stays the site's own handler — this only replaces `env.ASSETS` with the
 * wrapped one before delegating, which is the same thing the facet host does
 * for a stateful site. Doing it here rather than teaching the model to cope
 * keeps one contract for both modes.
 */
export const LOADER_ENTRY_SOURCE = `
import handler from "./index.js";
import { wrapAssets } from "./${ASSET_SHIM_MODULE}";

export default {
  fetch(request, env, ctx) {
    return handler.fetch(request, { ...env, ASSETS: wrapAssets(env.ASSETS) }, ctx);
  },
};
`;

/**
 * The compatibility date model-authored artifact code runs under.
 *
 * Pinned rather than tracking the platform's newest, because an artifact is
 * published once and served for as long as anyone opens it: a date that moved
 * underneath it would change the runtime semantics of code nobody is going to
 * revisit. Advancing it is a deliberate change with its own reason.
 */
export const ARTIFACT_COMPATIBILITY_DATE = "2026-08-01";

/**
 * A short fingerprint of the Rally code an isolate runs, for its loader id.
 *
 * The Worker Loader caches an isolate by its id, and the artifact's version
 * names only the model's code. Without this, an isolate cached before a
 * deploy could answer with Rally's old modules or compatibility date: a host
 * missing a method added since, such as `rallySchema`. Pass every Rally-written
 * module the isolate loads, and the compatibility date.
 */
export function rallyCodeRevision(...parts: string[]): string {
  let hash = 5381;
  const text = parts.join("\0");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

/** The loader id of a stateless active site's isolate. */
export function statelessLoaderId(artifactId: string, version: number): string {
  return `${artifactIsolateId(artifactId, version)}:${STATELESS_REVISION}`;
}

const STATELESS_REVISION = rallyCodeRevision(LOADER_ENTRY_SOURCE, ASSET_SHIM_SOURCE, ARTIFACT_COMPATIBILITY_DATE);
