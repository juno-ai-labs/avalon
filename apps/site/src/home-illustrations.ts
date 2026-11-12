/** Three views of one coordinated pencil drawing; see docs/site-design-system.md. */
const artwork = {
  src: "/illustrations/rally-pencil-master.webp",
  width: 1448,
  height: 1086,
};

const scenes = {
  canvas: {
    column: 0,
    row: 0,
    label:
      "Two pencil-drawn colleagues leaning over a shared plan, with a small studio behind them.",
  },
  sidekick: {
    column: 1,
    row: 0,
    label:
      "A colleague handing an envelope to a blue, hexagonal-headed Sidekick at a work table.",
  },
  together: {
    column: 0,
    row: 1,
    label:
      "Two pencil-drawn colleagues walking together with a pencil and a rolled plan.",
  },
} as const;

/** Each SVG clips its own quadrant while the browser downloads the artwork once. */
export function renderHomeIllustration(scene: keyof typeof scenes): string {
  const { column, row, label } = scenes[scene];
  const width = artwork.width / 2;
  const height = artwork.height / 2;
  const clip = `home-illustration-${scene}-clip`;

  return (
    `<svg class="home-illustration" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="860" height="650" role="img" aria-label="${label}" focusable="false">` +
    `<defs><clipPath id="${clip}"><rect width="${width}" height="${height}"/></clipPath></defs>` +
    `<g clip-path="url(#${clip})"><image href="${artwork.src}" width="${artwork.width}" height="${artwork.height}" x="${-column * width}" y="${-row * height}"/></g>` +
    "</svg>"
  );
}
