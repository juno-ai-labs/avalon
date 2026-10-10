/**
 * Draws the whole browser host 20% larger on a phone by narrowing the layout
 * viewport: a phone lays out `screen / 1.2` CSS pixels and stretches them over
 * the screen. Every length grows together, including `vh`, `vw` and fixed
 * positioning, and media queries see the narrower width, so the phone layout
 * still applies. Desktop browsers ignore the viewport tag, so they are untouched.
 */
export const PHONE_SCALE = 1.2;

// A phone is a screen whose short side fits the shell's 640px phone layout;
// an iPad's short side (744px and up) does not.
const PHONE_SCREEN_MAX_SHORT_SIDE = 640;

export const DEFAULT_VIEWPORT = "width=device-width, initial-scale=1.0";

/**
 * The viewport tag for a screen `short` by `long` CSS pixels. iOS keeps
 * `screen.width` at the portrait width when the phone turns, so the caller
 * passes the orientation rather than trusting which side is which.
 * `initial-scale` stops iOS keeping the old zoom across a rotation; flooring the
 * width lets the browser resolve it to exactly `screen / 1.2`.
 */
export function viewportContent(short: number, long: number, landscape: boolean): string {
  if (short <= 0 || short > PHONE_SCREEN_MAX_SHORT_SIDE) return DEFAULT_VIEWPORT;
  const width = Math.floor((landscape ? long : short) / PHONE_SCALE);
  return `width=${width}, initial-scale=${PHONE_SCALE}`;
}

export function installPhoneScale(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const orientation = matchMedia("(orientation: landscape)");
  const apply = () => {
    const { width, height } = screen;
    meta.content = viewportContent(Math.min(width, height), Math.max(width, height), orientation.matches);
  };
  apply();
  orientation.addEventListener("change", apply);
}
