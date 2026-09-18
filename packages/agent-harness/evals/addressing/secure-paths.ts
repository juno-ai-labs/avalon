import { chmod, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function assertProtectedEvaluationPaths(
  inputs: string[],
  outputs: string[],
): Promise<void> {
  const directories = new Set([...inputs, ...outputs].map((path) => dirname(path)));
  if (directories.size !== 1) {
    throw new Error("Evaluation inputs and outputs must share one protected scratch directory");
  }
  const directory = directories.values().next().value as string;
  const directoryMode = (await stat(directory)).mode & 0o777;
  if ((directoryMode & 0o077) !== 0) {
    throw new Error(`Evaluation scratch directory must be owner-only (0700); received ${directoryMode.toString(8)}`);
  }
  for (const input of inputs) {
    const inputMode = (await stat(input)).mode & 0o777;
    if ((inputMode & 0o077) !== 0) {
      throw new Error(`Evaluation input must be owner-only (0600); received ${inputMode.toString(8)}`);
    }
  }
}

export async function writePrivateFile(path: string, contents: string): Promise<void> {
  await chmod(path, 0o600).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
