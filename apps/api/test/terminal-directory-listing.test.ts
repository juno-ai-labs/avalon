import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { directoryListingCommands } from "../src/services/terminal/site-publish";

/**
 * The listing runs as the sandbox runs it, in real bash over real files, with
 * `sha256sum` wrapped to record which files it hashed: what the cache is for
 * is the hashing it skips, which only the calls show.
 */
describe("the sandbox's cached directory listing", () => {
  let root: string;
  let target: string;
  let cache: string;
  let hashed: string;
  let bin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rally-listing-"));
    target = join(root, "feed");
    cache = join(root, "digests");
    hashed = join(root, "hashed.log");
    bin = join(root, "bin");
    mkdirSync(join(target, "episodes"), { recursive: true });
    mkdirSync(bin);
    const real = execFileSync("bash", ["-c", "command -v sha256sum"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\n[ "$1" = "--" ] && printf '%s\\n' "$2" >> '${hashed}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "sha256sum"), 0o755);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const list = () => {
    writeFileSync(hashed, "");
    const stdout = execFileSync("bash", ["-c", [`target='${target}'`, ...directoryListingCommands(cache)].join("\n")], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const files = readFileSync(hashed, "utf8").split("\n").filter(Boolean).map((path) => path.slice(target.length + 1));
    return { lines: stdout.split("\n").filter(Boolean), hashed: files };
  };
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");

  it("hashes each file once, and again only when its bytes may have changed", async () => {
    writeFileSync(join(target, "index.html"), "<h1>Show</h1>");
    writeFileSync(join(target, "episodes", "one episode.mp3"), "episode one");
    const first = list();
    expect(first.lines).toEqual([
      `11 ${digest("episode one")} episodes/one episode.mp3`,
      `13 ${digest("<h1>Show</h1>")} index.html`,
    ]);
    expect(first.hashed.sort()).toEqual(["episodes/one episode.mp3", "index.html"]);

    // Nothing changed: the same listing, and nothing hashed.
    const second = list();
    expect(second.lines).toEqual(first.lines);
    expect(second.hashed).toEqual([]);

    // A new episode is the only file hashed.
    writeFileSync(join(target, "episodes", "two.mp3"), "episode two");
    expect(list().hashed).toEqual(["episodes/two.mp3"]);

    // Same size, and the modified time put back as it was: the change time
    // still moved, so the file is hashed again and its new digest is listed.
    execFileSync("bash", ["-c", `f='${join(target, "index.html")}'; touch -r "$f" "$f.time"; printf '<h1>Shaw</h1>' > "$f"; touch -r "$f.time" "$f"; rm "$f.time"`]);
    const edited = list();
    expect(edited.hashed).toEqual(["index.html"]);
    expect(edited.lines).toContain(`13 ${digest("<h1>Shaw</h1>")} index.html`);

    // A deleted file leaves the cache as well as the listing.
    rmSync(join(target, "episodes", "two.mp3"));
    expect(list().lines).toHaveLength(2);
    const [cacheFile] = readdirSync(cache).filter((name) => !name.includes("."));
    expect(readFileSync(join(cache, cacheFile!), "utf8")).not.toContain("two.mp3");
  });

  it("keeps the digests it computed when the listing is stopped before it finishes", async () => {
    writeFileSync(join(target, "index.html"), "<h1>Show</h1>");
    for (const name of ["a", "b", "c"]) writeFileSync(join(target, "episodes", `${name}.mp3`), `episode ${name}`);
    // Hashing `c` hangs, and the listing is stopped the way its time limit stops it.
    writeFileSync(join(bin, "sha256sum"), readFileSync(join(bin, "sha256sum"), "utf8")
      .replace("exec ", `case "$2" in *c.mp3) [ -n "$RALLY_SLOW" ] && sleep 30;; esac\nexec `));
    writeFileSync(hashed, "");
    try {
      execFileSync("timeout", ["--signal=TERM", "--kill-after=1s", "3s", "bash", "-c",
        [`target='${target}'`, ...directoryListingCommands(cache)].join("\n")],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RALLY_SLOW: "1" }, stdio: "ignore" });
    } catch { /* stopped, as intended */ }
    // The next listing hashes only what the stopped one had not finished.
    const next = list();
    expect(next.hashed.sort()).toEqual(["episodes/c.mp3", "index.html"]);
    expect(next.lines).toHaveLength(4);
  }, 20_000);
});
