export interface Env {
  /** The browser app's origin, which serves the consent page at `/oauth/authorize`. */
  BROWSER_APP_ORIGIN: string;
  /** The Global API Worker; other deployments add `<bindingPrefix>_API`. */
  GLOBAL_API: Fetcher;
  [binding: `${string}_API`]: Fetcher | undefined;
}
