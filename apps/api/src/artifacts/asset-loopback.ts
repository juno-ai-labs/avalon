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
 * See `docs/live-web-artifacts.md`.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

import { artifactAssetKey } from "@rally/contracts";

import type { Env } from "../env";
import { resolveAssetPath } from "./serving-policy";

export interface ArtifactAssetLoopbackProps {
  artifactId: string;
  version: number;
  /** Every published file of this version, and the type it was stored as. */
  assets: { path: string; contentType: string }[];
}

export class ArtifactAssetLoopback extends WorkerEntrypoint<Env, ArtifactAssetLoopbackProps> {
  override async fetch(request: Request): Promise<Response> {
    const { artifactId, version, assets } = this.ctx.props;
    const paths = new Set(assets.map((asset) => asset.path));
    const resolved = resolveAssetPath(new URL(request.url).pathname, paths);
    if (!resolved) return new Response("Not found", { status: 404 });
    const asset = assets.find((entry) => entry.path === resolved);
    if (!asset) return new Response("Not found", { status: 404 });
    const object = await this.env.PAYLOADS.get(artifactAssetKey(artifactId, version, resolved));
    if (!object) return new Response("Temporarily unavailable", { status: 503 });
    return new Response(object.body, {
      status: 200,
      headers: { "content-type": asset.contentType },
    });
  }
}
