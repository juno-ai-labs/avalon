import type { Region } from "@rally/contracts";
import {
  createRegionRoutedState,
  regionFromRoutedState,
} from "./region-routed-state";

/**
 * The public GitHub App has one setup URL. These are the GitHub-labelled names
 * for the shared region-routed state; Notion's single redirect URI uses the same
 * scheme through `region-routed-state.ts`.
 */
export function createGitHubInstallState(region: Region, randomValue: string): string {
  return createRegionRoutedState(region, randomValue);
}

export function githubRegionFromInstallState(state: string): Region {
  return regionFromRoutedState(state, "GitHub installation");
}
