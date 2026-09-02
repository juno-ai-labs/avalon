import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(desktopDirectory, '../..');
const contractDirectory = join(repositoryDirectory, 'packages/contracts');

// These are the non-contract inputs admitted by the workflow's push filter.
// Contract source files are deliberately absent: their membership is derived
// from the production desktop import graph below instead of copied by hand.
export const FIXED_DESKTOP_RELEASE_INPUTS = Object.freeze([
  'apps/desktop/**',
  'packages/contracts/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  '.github/workflows/release-desktop-macos.yml',
]);

const ignoredDesktopDirectories = new Set(['coverage', 'dist', 'node_modules', 'out']);

async function filesBelow(directory, ignoredDirectories = new Set()) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await filesBelow(path, ignoredDirectories));
      continue;
    }
    files.push(path);
  }
  return files;
}

// The release planner runs before dependencies are installed, so this scanner
// intentionally uses only Node. It recognizes every static ESM form used in
// the tree plus literal dynamic imports. release-workflow.test.mjs derives the
// same graph with the TypeScript parser and requires both results to be equal;
// new syntax therefore fails ordinary CI rather than silently shrinking this
// classifier.
async function moduleSpecifiers(path) {
  const source = await readFile(path, 'utf8');
  const specifiers = new Set();
  for (const expression of [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']/gu,
  ]) {
    for (const match of source.matchAll(expression)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

async function firstFile(paths) {
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch { /* Try the next TypeScript module-resolution shape. */ }
  }
  return null;
}

export async function resolveContractImport(importer, specifier) {
  const unresolved = resolve(dirname(importer), specifier);
  const jsExtension = specifier.match(/\.(?<extension>[cm]?)js$/u)?.groups?.extension;
  const sourceExtension = jsExtension === undefined ? null : `${jsExtension}ts`;
  const withoutJsExtension = sourceExtension === null ? null : unresolved.slice(0, -(`.${jsExtension}js`.length));
  const path = await firstFile([
    unresolved,
    ...(withoutJsExtension ? [`${withoutJsExtension}.${sourceExtension}`] : []),
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${unresolved}.mts`,
    `${unresolved}.cts`,
    join(unresolved, 'index.ts'),
    join(unresolved, 'index.tsx'),
  ]);
  if (!path) throw new Error(`Cannot resolve contract import ${specifier} from ${relative(repositoryDirectory, importer)}`);
  return path;
}

export function resolveContractPackageImport(packageJson, specifier) {
  if (specifier !== '@rally/contracts' && !specifier.startsWith('@rally/contracts/')) return null;
  const exportKey = specifier === '@rally/contracts'
    ? '.'
    : `./${specifier.slice('@rally/contracts/'.length)}`;
  const target = packageJson.exports[exportKey];
  if (typeof target !== 'string') throw new Error(`Desktop contract import ${specifier} is absent from package exports`);
  return resolve(contractDirectory, target);
}

export async function resolveContractSpecifier(importer, specifier, packageJson) {
  if (specifier.startsWith('.')) return resolveContractImport(importer, specifier);
  return resolveContractPackageImport(packageJson, specifier);
}

export async function desktopContractSourceClosure() {
  const packageJson = JSON.parse(await readFile(join(contractDirectory, 'package.json'), 'utf8'));
  const entryPoints = new Set();

  for (const path of await filesBelow(desktopDirectory, ignoredDesktopDirectories)) {
    if (!/\.[cm]?[jt]sx?$/u.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) continue;
    for (const specifier of await moduleSpecifiers(path)) {
      const entryPoint = resolveContractPackageImport(packageJson, specifier);
      if (entryPoint) entryPoints.add(entryPoint);
    }
  }

  const closure = new Set();
  const pending = [...entryPoints];
  while (pending.length > 0) {
    const path = pending.pop();
    if (closure.has(path)) continue;
    closure.add(path);
    for (const specifier of await moduleSpecifiers(path)) {
      const imported = await resolveContractSpecifier(path, specifier, packageJson);
      if (!imported) continue;
      if (!closure.has(imported)) pending.push(imported);
    }
  }

  return [...closure]
    .map((path) => relative(repositoryDirectory, path).replaceAll('\\', '/'))
    .sort();
}

function matchesFixedInput(path) {
  // Git emits repository-relative names with `/` even when this runs on Windows.
  return FIXED_DESKTOP_RELEASE_INPUTS.some((pattern) => (pattern.endsWith('/**')
    ? path.startsWith(pattern.slice(0, -2))
    : path === pattern));
}

export async function desktopReleaseInputPaths(changedPaths) {
  const contractSources = new Set(await desktopContractSourceClosure());
  return changedPaths.filter((path) => matchesFixedInput(path) || contractSources.has(path));
}
