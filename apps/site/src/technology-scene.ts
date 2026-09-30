import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix3,
  Matrix4,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';

/**
 * The technology schematic: a starfield that gathers into four nested spheres,
 * each an equal radius step larger than the one inside it, with the octant that
 * faces the camera cut away so every layer shows. Once all four stand, the cut
 * fills in, the stack becomes a tennis ball with a gold seam, spins, and breaks
 * back into the starfield before the loop starts again.
 *
 * Every particle holds three positions (star, schematic, ball) and the vertex
 * shader blends between them from a handful of uniforms, so a frame costs the
 * CPU a few uniform writes and four label projections.
 */

export type Layer = { readonly name: string; readonly color: string };

export const LAYERS: readonly Layer[] = [
  { name: 'LLM routing core', color: '#ffc24a' },
  { name: 'Sidekicks', color: '#3fcf97' },
  { name: 'Authorization', color: '#d266c6' },
  { name: 'Channels & Breakouts', color: '#5b8cff' },
];

/** Seconds. Each layer forms, then holds; the last hold is the long one. */
const REST = 3;
const FORM = 3;
const HOLD = 4;
const FINAL_HOLD = 20;
const FILL = 2.5;
const BALL = 3;
const SPIN_HOLD = 7;
const SCATTER = 3.5;

const layerStart = (index: number): number => REST + index * (FORM + HOLD);
const FINAL_START = layerStart(LAYERS.length - 1) + FORM;
const FILL_START = FINAL_START + FINAL_HOLD;
const BALL_START = FILL_START + FILL;
const SCATTER_START = BALL_START + BALL + SPIN_HOLD;
export const LOOP = SCATTER_START + SCATTER;

/** Named moments in the loop, for anyone who needs to point at one. */
export const MOMENTS = {
  starfield: REST / 2,
  layers: LAYERS.map((_, index) => layerStart(index) + FORM + HOLD / 2),
  final: FINAL_START + FINAL_HOLD / 2,
  filled: BALL_START,
  ball: BALL_START + BALL + SPIN_HOLD / 2,
  scatter: SCATTER_START + SCATTER / 2,
} as const;

const STEP = 0.55;
const OUTER = STEP * LAYERS.length;
const STAR_ONLY = 5200;
const LAYER_POINTS = [1500, 2800, 4000, 5200];
const FILL_POINTS = 450;
const SEAM_POINTS = 1500;
const GROUP_FILL = LAYERS.length;
const GROUP_STAR = LAYERS.length + 1;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const ramp = (time: number, start: number, length: number): number => clamp01((time - start) / length);

/** Deterministic, so every visitor sees the same sky. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inCut = (x: number, y: number, z: number): boolean => x < 0 && y > 0 && z > 0;

function onSphere(rand: () => number, radius: number, keep: (v: Vector3) => boolean): Vector3 {
  const v = new Vector3();
  do {
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    v.set(r * Math.cos(a), r * Math.sin(a), z).multiplyScalar(radius);
  } while (!keep(v));
  return v;
}

/** A point on one of the three quarter-disc walls the cut exposes. */
function onCutWall(rand: () => number, inner: number, outer: number): Vector3 {
  const r = Math.sqrt(rand() * (outer * outer - inner * inner) + inner * inner);
  const a = rand() * Math.PI / 2;
  const u = r * Math.cos(a);
  const w = r * Math.sin(a);
  const wall = Math.floor(rand() * 3);
  if (wall === 0) return new Vector3(-u, w, 0);
  if (wall === 1) return new Vector3(-u, 0, w);
  return new Vector3(0, u, w);
}

/**
 * A tennis-ball seam: with a + b = 1 the curve lies exactly on the unit sphere,
 * since x² + y² + z² = a² + b² + 2ab = 1.
 */
function onSeam(t: number, radius: number): Vector3 {
  const a = 0.7;
  const b = 0.3;
  return new Vector3(
    a * Math.cos(t) + b * Math.cos(3 * t),
    a * Math.sin(t) - b * Math.sin(3 * t),
    2 * Math.sqrt(a * b) * Math.sin(2 * t),
  ).multiplyScalar(radius);
}

/** Where a layer's label points: its band on the back wall of the cut. */
export function layerAnchor(index: number): Vector3 {
  const r = STEP * (index + 0.6);
  const a = (118 * Math.PI) / 180;
  return new Vector3(r * Math.cos(a), r * Math.sin(a), 0);
}

function buildGeometry(): BufferGeometry {
  const rand = random(20260930);
  const total = STAR_ONLY + FILL_POINTS + LAYER_POINTS.reduce((sum, n) => sum + n, 0);
  const star = new Float32Array(total * 3);
  const shape = new Float32Array(total * 3);
  const ball = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const ballColor = new Float32Array(total * 3);
  const info = new Float32Array(total * 4);

  // A jittered grid: evenly spread, never regular.
  const box = { x: 20, y: 11, z: 12 };
  const cell = Math.cbrt((box.x * box.y * box.z) / total);
  const nx = Math.ceil(box.x / cell);
  const ny = Math.ceil(box.y / cell);
  const nz = Math.ceil(box.z / cell);
  const cells = Array.from({ length: nx * ny * nz }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }

  const starColor = new Color('#f5f5f2');
  const ballBody = new Color('#dfe4ea');
  const seamGold = new Color('#f2b441');
  let next = 0;
  const innerPoints = LAYER_POINTS.slice(0, -1).reduce((sum, n) => sum + n, 0);

  const put = (group: number, shapeAt: Vector3 | null, ballAt: Vector3 | null, tint: Color, seam: boolean, shell: boolean): void => {
    const c = cells[next]!;
    const gx = c % nx;
    const gy = Math.floor(c / nx) % ny;
    const gz = Math.floor(c / (nx * ny));
    const s = new Vector3(
      (gx + rand()) * cell - box.x / 2,
      (gy + rand()) * cell - box.y / 2,
      (gz + rand()) * cell - box.z * 0.6,
    );
    const at = shapeAt ?? s;
    const to = ballAt ?? at;
    star.set([s.x, s.y, s.z], next * 3);
    shape.set([at.x, at.y, at.z], next * 3);
    ball.set([to.x, to.y, to.z], next * 3);
    color.set([tint.r, tint.g, tint.b], next * 3);
    const bc = seam ? seamGold : shapeAt ? ballBody : starColor;
    ballColor.set([bc.r, bc.g, bc.b], next * 3);
    info.set([group, rand(), seam ? 1 : 0, shell ? 1 : 0], next * 4);
    next += 1;
  };

  LAYERS.forEach((layer, index) => {
    const tint = new Color(layer.color);
    const outer = STEP * (index + 1);
    const inner = STEP * index;
    const shellArea = (7 / 8) * outer * outer;
    const wallArea = (3 / 4) * (outer * outer - inner * inner) * 3;
    const count = LAYER_POINTS[index]!;
    for (let n = 0; n < count; n += 1) {
      const onShell = rand() < shellArea / (shellArea + wallArea);
      const at = onShell
        ? onSphere(rand, outer, (v) => !inCut(v.x, v.y, v.z))
        : onCutWall(rand, inner, outer);
      let to: Vector3;
      let seam = false;
      if (index === LAYERS.length - 1 && onShell) {
        to = at;
      } else if (index < LAYERS.length - 1 && rand() < SEAM_POINTS / innerPoints) {
        const jitter = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.05);
        to = onSeam(rand() * Math.PI * 2, OUTER * 1.01).add(jitter);
        seam = true;
      } else {
        to = onSphere(rand, OUTER, () => true);
      }
      put(index, at, to, tint, seam, onShell);
    }
  });
  const outerTint = new Color(LAYERS[LAYERS.length - 1]!.color);
  for (let n = 0; n < FILL_POINTS; n += 1) {
    const at = onSphere(rand, OUTER, (v) => inCut(v.x, v.y, v.z));
    put(GROUP_FILL, at, at, outerTint, false, true);
  }
  for (let n = 0; n < STAR_ONLY; n += 1) put(GROUP_STAR, null, null, starColor, false, false);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(star, 3));
  geometry.setAttribute('aShape', new BufferAttribute(shape, 3));
  geometry.setAttribute('aBall', new BufferAttribute(ball, 3));
  geometry.setAttribute('aColor', new BufferAttribute(color, 3));
  geometry.setAttribute('aBallColor', new BufferAttribute(ballColor, 3));
  geometry.setAttribute('aInfo', new BufferAttribute(info, 4));
  return geometry;
}

const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uForm[${LAYERS.length + 1}];
uniform float uBall;
uniform float uScatter;
uniform mat3 uSpin;
uniform float uStarTurn;
uniform float uPixel;
uniform vec3 uEye;
uniform vec3 uOuterColor;
attribute vec3 aShape;
attribute vec3 aBall;
attribute vec3 aColor;
attribute vec3 aBallColor;
attribute vec4 aInfo;
varying vec3 vColor;
varying float vAlpha;

float ease(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
float stagger(float progress, float seed) { return ease(clamp(progress * 1.6 - seed * 0.6, 0.0, 1.0)); }
vec3 turnY(vec3 p, float a) { float c = cos(a); float s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }

void main() {
  int group = int(aInfo.x + 0.5);
  float seed = aInfo.y;
  float seam = aInfo.z;
  vec3 star = turnY(position, uStarTurn + seed * 0.02);
  star.y += sin(uTime * 0.3 + seed * 40.0) * 0.04;

  float form = 0.0;
  for (int i = 0; i < ${LAYERS.length + 1}; i++) { if (i == group) form = uForm[i]; }
  form = stagger(form, seed);
  vec3 swirl = normalize(cross(aShape + vec3(0.001), vec3(0.0, 1.0, 0.0))) * sin(form * 3.14159) * 0.9;
  vec3 p = mix(star, aShape, form) + swirl;

  // Filling the cut: every structure point settles onto the outer sphere, which
  // is what makes it read as whole. The ball then only recolors, lifts the seam
  // and spins, so the spin starting from identity never jumps.
  bool structural = group <= ${GROUP_FILL};
  float fillT = structural ? stagger(uForm[${GROUP_FILL}], seed) : 0.0;
  float ballT = structural ? stagger(uBall, seed) : 0.0;
  p = mix(p, uSpin * aBall, fillT);
  float scatter = stagger(uScatter, fract(seed * 7.31));
  p = mix(p, star, scatter);

  vec3 c = mix(vec3(0.96), aColor, form);
  c = mix(c, uOuterColor, fillT);
  c = mix(c, aBallColor, ballT);
  c = mix(c, vec3(0.96), scatter);
  vColor = c;

  float structure = max(form, fillT) * (1.0 - scatter);
  float twinkle = 0.55 + 0.45 * sin(uTime * (0.6 + seed * 1.7) + seed * 90.0);
  // Points on the far side of a sphere fade, so the near surface and the cut
  // walls read as solid bands rather than a haze of overlapping layers.
  float facing = dot(normalize(p + vec3(0.0001)), normalize(uEye));
  float front = smoothstep(-0.4, 0.8, facing);
  float shellAlpha = aInfo.w > 0.5 ? mix(0.18, 0.7, front) : 1.0;
  float sphereAlpha = mix(0.08, 0.55, front);
  float seamAlpha = mix(0.3, 1.0, front);
  float alpha = mix(shellAlpha, sphereAlpha, fillT);
  alpha = mix(alpha, seam > 0.5 ? seamAlpha : sphereAlpha, ballT);
  float size = mix(1.4, mix(2.0, 2.4, 1.0 - aInfo.w), structure) + seam * ballT * (1.0 - scatter) * 2.6;
  vAlpha = mix(0.3 + 0.35 * twinkle, alpha, structure);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(size * uPixel * (10.0 / -mv.z), mix(2.4, 8.0, structure) * uPixel);
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.1, d));
}
`;

export type SceneState = {
  readonly form: readonly number[];
  readonly labels: readonly number[];
  readonly ball: number;
  readonly scatter: number;
  readonly spin: number;
};

/** What the scene looks like `time` seconds into the loop. */
export function stateAt(time: number): SceneState {
  const t = ((time % LOOP) + LOOP) % LOOP;
  const fadeLabels = 1 - ramp(t, FILL_START, 0.8);
  return {
    form: [...LAYERS.map((_, index) => ramp(t, layerStart(index), FORM)), ramp(t, FILL_START, FILL)],
    labels: LAYERS.map((_, index) => ramp(t, layerStart(index) + FORM - 0.6, 0.8) * fadeLabels),
    ball: ramp(t, BALL_START, BALL),
    scatter: ramp(t, SCATTER_START, SCATTER),
    spin: Math.max(0, t - BALL_START) * 0.55,
  };
}

export type Schematic = {
  render(time: number): void;
  resize(): void;
  dispose(): void;
};

export function createSchematic(canvas: HTMLCanvasElement, overlay: SVGSVGElement): Schematic {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 60);
  camera.position.set(-0.52, 0.5, 1).normalize().multiplyScalar(11.5);
  camera.lookAt(0, 0, 0);

  const uniforms = {
    uTime: { value: 0 },
    uForm: { value: new Array<number>(LAYERS.length + 1).fill(0) },
    uBall: { value: 0 },
    uScatter: { value: 0 },
    uSpin: { value: new Matrix3() },
    uStarTurn: { value: 0 },
    uPixel: { value: 1 },
    uEye: { value: new Vector3() },
    uOuterColor: { value: new Color(LAYERS[LAYERS.length - 1]!.color) },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  uniforms.uEye.value.copy(camera.position);
  const geometry = buildGeometry();
  scene.add(new Points(geometry, material));

  const svg = 'http://www.w3.org/2000/svg';
  const labels = LAYERS.map((layer) => {
    const group = document.createElementNS(svg, 'g');
    group.setAttribute('class', 'tech-label');
    const text = document.createElementNS(svg, 'text');
    text.textContent = layer.name;
    const line = document.createElementNS(svg, 'polyline');
    const dot = document.createElementNS(svg, 'circle');
    dot.setAttribute('r', '3');
    group.append(line, dot, text);
    overlay.append(group);
    return { group, text, line, dot, width: 0 };
  });

  const spinAxis = new Vector3(0.35, 1, 0.2).normalize();
  const spin = new Matrix4();
  const projected = new Vector3();
  let width = 1;
  let height = 1;
  let narrow = false;

  const resize = (): void => {
    const box = canvas.getBoundingClientRect();
    width = Math.max(1, box.width);
    height = Math.max(1, box.height);
    narrow = width < 640;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Labels need their own room: on wide layouts the sphere moves right, on
    // narrow ones it shrinks and moves down.
    camera.zoom = narrow ? 0.78 : 1;
    if (narrow) camera.setViewOffset(width, height, 0, -height * 0.16, width, height);
    else camera.setViewOffset(width, height, -width * 0.14, 0, width, height);
    camera.updateProjectionMatrix();
    uniforms.uPixel.value = renderer.getPixelRatio() * Math.min(1.4, Math.max(0.8, height / 560));
    overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
    labels.forEach((label) => { label.width = label.text.getComputedTextLength(); });
  };

  const placeLabels = (state: SceneState): void => {
    const anchors = LAYERS.map((_, index) => {
      projected.copy(layerAnchor(index)).project(camera);
      return { x: (projected.x + 1) / 2 * width, y: (1 - projected.y) / 2 * height };
    });
    const left = narrow ? 12 : Math.max(16, width * 0.04);
    const gap = narrow ? 30 : 46;
    const top = narrow ? 28 : anchors[LAYERS.length - 1]!.y - 90;
    // Elbows step right as the labels step down, so the leader lines fan out
    // toward anchors that step inward without crossing or overlapping.
    const elbow = left + Math.max(...labels.map((label) => label.width)) + 12;
    labels.forEach((label, index) => {
      const slot = LAYERS.length - 1 - index;
      const y = top + slot * gap;
      const end = elbow + slot * (narrow ? 14 : 20);
      const anchor = anchors[index]!;
      label.text.setAttribute('x', String(left));
      label.text.setAttribute('y', String(y - 7));
      label.line.setAttribute('points', `${left},${y} ${end},${y} ${anchor.x},${anchor.y}`);
      label.dot.setAttribute('cx', String(anchor.x));
      label.dot.setAttribute('cy', String(anchor.y));
      label.group.setAttribute('opacity', state.labels[index]!.toFixed(3));
    });
  };

  const render = (time: number): void => {
    const state = stateAt(time);
    uniforms.uTime.value = time;
    state.form.forEach((value, index) => { uniforms.uForm.value[index] = value; });
    uniforms.uBall.value = state.ball;
    uniforms.uScatter.value = state.scatter;
    uniforms.uStarTurn.value = time * 0.012;
    uniforms.uSpin.value.setFromMatrix4(spin.makeRotationAxis(spinAxis, state.spin));
    renderer.render(scene, camera);
    placeLabels(state);
  };

  resize();
  return {
    render,
    resize,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
