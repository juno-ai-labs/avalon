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

/** Shared geometry for both browser viewports and raster preview crops. */
export function getIllustration(scene: keyof typeof scenes) {
  const { column, row, label } = scenes[scene];
  const width = artwork.width / 2;
  const height = artwork.height / 2;
  return { ...artwork, label, crop: { left: column * width, top: row * height, width, height } };
}

/** The SVG viewport clips its quadrant; repeating a scene creates no shared IDs. */
export function renderHomeIllustration(scene: keyof typeof scenes): string {
  const { src, width, height, label, crop } = getIllustration(scene);
  return (
    `<svg class="home-illustration" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${crop.width} ${crop.height}" width="860" height="650" overflow="hidden" role="img" aria-label="${label}" focusable="false">` +
    `<image href="${src}" width="${width}" height="${height}" x="${-crop.left}" y="${-crop.top}"/>` +
    "</svg>"
  );
}
