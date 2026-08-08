// Generates local-only Worker configs for Linux/CI sandboxes that hold no
// Cloudflare credentials. Wrangler starts a remote proxy session for the AI,
// Vectorize, and Images bindings, and that session requires CLOUDFLARE_API_TOKEN
// even in local dev. Removing exactly those three bindings lets D1, R2, Durable
// Objects, Queues, and Workflows run entirely in local workerd.
//
// The generated files are ignored by Git. Never deploy from them: the Workers
// they describe are missing bindings the API depends on in production.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const apiDirectory = resolve(root, "apps/api");

const removedBindings = [
  /\n {2}"ai": \{[^}]*\},/,
  /\n {2}"images": \{[^}]*\},/,
  /\n {2}"vectorize": \[[^\]]*\],/
];

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
  console.log(`Wrote ${targetPath} without the AI, Images, and Vectorize bindings.`);
}
