/**
 * The `ASSETS` binding a model-authored artifact module holds.
 *
 * **A dynamically loaded worker's `env` is a plain object whose values the
 * loader serializes, and it rejects a JavaScript object carrying a function
 * with `DataCloneError`** — a plain `{ fetch }`, an `RpcTarget`, and an R2
 * bucket binding each fail. What does cross is a stub minted from
 * `ctx.exports`: an RPC reference to a real exported entrypoint rather than a
 * value being cloned.
 *
 * So the reader lives here, as an entrypoint of the API Worker, parameterized
 * by props naming one artifact version and its published files. The artifact's
 * isolate holds a reference that can do exactly one thing; the bucket behind it
 * stays in this Worker and never enters the isolate.
 *
 * The props carry the asset list rather than the manifest key, so serving a
 * file is one R2 read rather than two, and so this class needs no authority to
 * decide *which* files an artifact may read — the supervisor decided that when
 * it minted the stub.
 *
 * See `docs/reactive-web-artifacts.md`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";


import type { Env } from "../env";
import { resolveAssetPath } from "./serving-policy";
import { storedObjectResponse } from "./stored-object-response";

export interface ArtifactAssetLoopbackProps {
  artifactId: string;
  version: number;
  /** Every published file of this version, the type it was stored as, and its stored key. */
  assets: { path: string; contentType: string; key: string }[];
}

export class ArtifactAssetLoopback extends WorkerEntrypoint<Env, ArtifactAssetLoopbackProps> {
  override async fetch(request: Request): Promise<Response> {
    const { assets } = this.ctx.props;
    const paths = new Set(assets.map((asset) => asset.path));
    const resolved = resolveAssetPath(new URL(request.url).pathname, paths);
    if (!resolved) return new Response("Not found", { status: 404 });
    const asset = assets.find((entry) => entry.path === resolved);
    if (!asset) return new Response("Not found", { status: 404 });
    // The site's code passes its visitor's request on, so a player's range
    // reaches the stored file through it as it does through a static site.
    // HTML comes back whole: the serving Worker may inject into it afterwards,
    // and nothing seeks within a page.
    const served = await storedObjectResponse(this.env.PAYLOADS, asset.key, request,
      { "content-type": asset.contentType }, { ranges: !asset.contentType.toLowerCase().startsWith("text/html") });
    return served ?? new Response("Temporarily unavailable", { status: 503 });
  }
}
