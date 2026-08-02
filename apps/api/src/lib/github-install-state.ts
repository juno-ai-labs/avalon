import type { Region } from "@avalon/contracts";
import { ApiError } from "./api-error";

export function createGitHubInstallState(region: Region, randomValue: string): string {
  if (!/^[A-Za-z0-9_-]{20,}$/u.test(randomValue)) {
    throw new Error("GitHub installation state entropy is invalid");
  }
  return `${region}.${randomValue}`;
}

export function githubRegionFromInstallState(state: string): Region {
  const match = /^(global|eu)\.[A-Za-z0-9_-]{20,}$/u.exec(state);
  if (!match) {
    throw new ApiError(401, "invalid_oauth_state", "GitHub installation state is invalid or expired");
  }
  return match[1] as Region;
}
