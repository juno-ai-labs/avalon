/**
 * Materializing a published site back into the sandbox, so it can be revised.
 *
 * This is the other half of the revision loop. A published artifact's *source*
 * lives in the region's payload bucket keyed by version, and the sandbox is
 * recycled between runs — so a run asked to change a site it did not build, or
 * built in a session that has since ended, has to bring the files back before
 * it can edit them.
 *
 * **`index.js` is materialized here even though a viewer's request for it
 * 404s.** "Module, not asset" is a rule about the *serving* path — it keeps a
 * site's own source from being handed to its viewers — and it says nothing
 * about the sandbox. A model that could not see its own server could not revise
 * it.
 *
 * See `docs/live-web-artifacts.md`.
 */
import { artifactAssetKey, type ArtifactManifest } from "@rally/contracts";

import type { Env } from "../../env";
import { TerminalToolError } from "./tools";

export interface SiteFile {
  /** Directory-relative, as it will be written beneath the destination root. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Read every file of one artifact version out of the bucket.
 *
 * The manifest is the index, and the server module is added to it here because
 * it is deliberately absent from `assets` — the one place the two views of a
 * published version differ, and the reason this function exists rather than the
 * caller looping over `manifest.assets` itself.
 */
export async function readArtifactVersionFiles(
  env: Pick<Env, "PAYLOADS">,
  manifest: ArtifactManifest,
): Promise<SiteFile[]> {
  const artifactId = manifest.artifactId;
  const version = manifest.artifactVersion;
  const generatedPreviewPath = manifest.socialPreview?.image.generated
    ? manifest.socialPreview.image.path
    : null;
  const wanted = [
    ...manifest.assets
      .map((asset) => asset.path)
      .filter((path) => path !== generatedPreviewPath),
    ...(manifest.mode === "active" ? ["index.js"] : []),
  ];
  const files: SiteFile[] = [];
  for (const path of wanted) {
    const object = await env.PAYLOADS.get(artifactAssetKey(artifactId, version, path));
    if (!object) {
      // A version whose bytes are gone is not something to materialize
      // partially: a half tree republishes as a site missing files, under the
      // same identity, and nothing would say which ones went.
      throw new TerminalToolError(
        "resource_not_importable",
        "Part of this site's source is temporarily unavailable. Retry the import; if it persists, the site can still be revised by publishing a fresh directory at its path.",
        { reason: "Retry the import once; the site keeps serving its current version either way." },
      );
    }
    files.push({ path, bytes: new Uint8Array(await object.arrayBuffer()) });
  }
  return files;
}

/**
 * The shell that writes one materialized tree, atomically enough to be safe.
 *
 * **`overwrite` is whole-tree replacement, never a merge**, and that is the
 * dangerous default this rules out: merging would leave behind files a later
 * version deleted, and the next publish would silently ship them back as though
 * they had been restored on purpose.
 *
 * The tree is staged beside the destination and moved into place, so a failure
 * partway leaves the previous tree intact rather than a half-replaced one.
 */
export function materializeTreeCommand(input: {
  destination: string;
  staging: string;
  overwrite: boolean;
}): string {
  const destination = shellQuote(input.destination);
  const staging = shellQuote(input.staging);
  return [
    `destination=${destination}`,
    `staging=${staging}`,
    // 44: the destination exists and holds something, and no overwrite was
    // asked for. Refused rather than merged.
    input.overwrite
      ? ':'
      : 'if [ -e "$destination" ] && [ -n "$(ls -A "$destination" 2>/dev/null)" ]; then exit 44; fi',
    // 45: something is there that is not a directory Rally may replace.
    'if [ -e "$destination" ] && [ ! -d "$destination" ]; then exit 45; fi',
    'rm -rf -- "$destination" || exit 46',
    'mkdir -p -- "$(dirname -- "$destination")" || exit 46',
    'mv -- "$staging" "$destination" || exit 46',
    'printf "%s\\n" "$(find "$destination" -type f | wc -l)"',
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Turn the shell's exit code into something the model can act on.
 *
 * Each code names a different repair, which is the whole reason they are
 * distinguished rather than collapsed into one failure.
 */
export function importTreeFailure(exitCode: number): TerminalToolError | null {
  if (exitCode === 0) return null;
  if (exitCode === 44) {
    return new TerminalToolError(
      "destination_exists",
      "That directory already holds files. Choose another destinationPath, or retry with overwrite: true — which replaces the whole tree rather than merging into it.",
      { reason: "Choose another destinationPath, or use overwrite: true to replace the tree." },
    );
  }
  if (exitCode === 45) {
    return new TerminalToolError(
      "destination_not_regular",
      "The destination exists but is not a directory Rally can safely replace. Choose a different destinationPath and retry.",
      { reason: "Choose a destinationPath that is absent or names a directory." },
    );
  }
  return new TerminalToolError(
    "resource_import_failed",
    "The site's files could not be written. Retry the import.",
    { reason: "Retry the import." },
  );
}
