// Generates local-only Worker configs for Linux/CI sandboxes that hold no
// Cloudflare credentials. The `ai` binding has no local implementation, so
// Wrangler opens a remote proxy session for it during startup and that session
// requires CLOUDFLARE_API_TOKEN. Removing only that binding lets D1, R2, Durable
// Objects, Queues, Workflows, and Images run entirely in local workerd.
//
// Vectorize is left in place. Wrangler reports it as `not supported` locally,
// which does not block startup; its calls fail at runtime instead.
//
// The generated files are ignored by Git. Never deploy from them: the Workers
// they describe are missing a binding the API depends on in production.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const apiDirectory = resolve(root, "apps/api");

const removedBindings = [/\n {2}"ai": \{[^}]*\},/];

for (const region of ["global", "eu"]) {
  const sourcePath = resolve(apiDirectory, `wrangler.${region}.jsonc`);
  const targetPath = resolve(apiDirectory, `wrangler.sandbox.${region}.jsonc`);
  const source = await readFile(sourcePath, "utf8");
  let generated = source;
  for (const pattern of removedBindings) {
    if (!pattern.test(generated)) {
      throw new Error(`${sourcePath} no longer contains ${pattern}; update this generator`);
    }
    generated = generated.replace(pattern, "");
  }
  await writeFile(targetPath, generated, { encoding: "utf8", mode: 0o600 });
  console.log(`Wrote ${targetPath} without the AI binding.`);
}
