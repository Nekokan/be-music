import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAsset, getRawAsset, isSea } from 'node:sea';

const SEA_WORKER_ASSET_PREFIX = '@be-music/player-tui/sea-worker/';
const SEA_NODE_WEB_AUDIO_ASSET_PREFIX = '@be-music/player/sea-node-web-audio-api/';
const SEA_NODE_WEB_AUDIO_MANIFEST_ASSET = `${SEA_NODE_WEB_AUDIO_ASSET_PREFIX}manifest.json`;
const SEA_LIBAV_ASSET_PREFIX = '@be-music/player-tui/sea-libav-js-fat/';
const SEA_LIBAV_MANIFEST_ASSET = `${SEA_LIBAV_ASSET_PREFIX}manifest.json`;
export const SEA_NODE_WEB_AUDIO_PACKAGE_DIR_ENV = 'BE_MUSIC_SEA_NODE_WEB_AUDIO_API_DIR';
const seaWorkerAssetCache = new Map<string, URL>();
let seaNodeWebAudioPackageDir: string | undefined;
let seaLibAvPackageDir: string | undefined;

interface SeaPackageFileAsset {
  assetKey: string;
  path: string;
}

interface SeaPackageManifest {
  files: SeaPackageFileAsset[];
}

export const SEA_WORKER_ASSETS = {
  gameplay: `${SEA_WORKER_ASSET_PREFIX}node-gameplay-worker.cjs`,
  ui: `${SEA_WORKER_ASSET_PREFIX}node-ui-worker.cjs`,
  bgaVideo: `${SEA_WORKER_ASSET_PREFIX}bga-video-worker.cjs`,
} as const;

export function resolveNodeWorkerUrl(
  sourceWorkerPath: string,
  builtWorkerPath: string,
  importMetaUrl: string | undefined,
  seaAssetKey: string,
): URL {
  if (isSea()) {
    return materializeSeaWorkerAsset(seaAssetKey);
  }
  if (typeof importMetaUrl !== 'string' || importMetaUrl.length === 0) {
    throw new Error('Worker module URL is unavailable');
  }
  return new URL(isSourceModuleUrl(importMetaUrl) ? sourceWorkerPath : builtWorkerPath, importMetaUrl);
}

export function isSourceModuleUrl(importMetaUrl: string | undefined): boolean {
  return typeof importMetaUrl === 'string' && importMetaUrl.endsWith('.ts');
}

export function resolveSeaNodeWebAudioPackageDir(): string | undefined {
  if (!isSea()) {
    return undefined;
  }
  return materializeSeaNodeWebAudioPackage();
}

export function resolveSeaLibAvPackageDir(): string | undefined {
  if (!isSea()) {
    return undefined;
  }
  return materializeSeaLibAvPackage();
}

function materializeSeaWorkerAsset(assetKey: string): URL {
  const cached = seaWorkerAssetCache.get(assetKey);
  if (cached) {
    return cached;
  }

  const source = getAsset(assetKey, 'utf8');
  if (typeof source !== 'string') {
    throw new Error(`SEA worker asset is unavailable: ${assetKey}`);
  }

  const dir = join(tmpdir(), `be-music-player-tui-sea-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, basename(assetKey));
  writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o600 });

  const url = pathToFileURL(filePath);
  seaWorkerAssetCache.set(assetKey, url);
  return url;
}

function materializeSeaNodeWebAudioPackage(): string {
  if (seaNodeWebAudioPackageDir) {
    return seaNodeWebAudioPackageDir;
  }

  const manifest = readSeaPackageManifest(SEA_NODE_WEB_AUDIO_MANIFEST_ASSET, 'node-web-audio-api');
  const packageDir = join(tmpdir(), `be-music-node-web-audio-api-sea-${process.pid}`, 'node-web-audio-api');
  materializeSeaPackageFiles(packageDir, manifest);

  seaNodeWebAudioPackageDir = packageDir;
  return packageDir;
}

function materializeSeaLibAvPackage(): string {
  if (seaLibAvPackageDir) {
    return seaLibAvPackageDir;
  }

  const manifest = readSeaPackageManifest(SEA_LIBAV_MANIFEST_ASSET, 'libav.js-fat');
  const packageDir = join(tmpdir(), `be-music-libav-js-fat-sea-${process.pid}`, 'libav.js-fat');
  materializeSeaPackageFiles(packageDir, manifest);

  seaLibAvPackageDir = packageDir;
  return packageDir;
}

function materializeSeaPackageFiles(packageDir: string, manifest: SeaPackageManifest): void {
  for (const file of manifest.files) {
    const filePath = resolvePackageFilePath(packageDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(getRawAsset(file.assetKey)), { mode: 0o600 });
  }
}

function readSeaPackageManifest(assetKey: string, name: string): SeaPackageManifest {
  const source = getAsset(assetKey, 'utf8');
  if (typeof source !== 'string') {
    throw new Error(`SEA ${name} manifest is unavailable`);
  }

  const parsed = JSON.parse(source) as Partial<SeaPackageManifest>;
  if (!Array.isArray(parsed.files)) {
    throw new Error(`SEA ${name} manifest is invalid`);
  }
  return { files: parsed.files };
}

function resolvePackageFilePath(packageDir: string, relativePath: string): string {
  const parts = relativePath.split('/').filter((part) => part.length > 0);
  if (isAbsolute(relativePath) || parts.some((part) => part === '..')) {
    throw new Error(`Invalid SEA node-web-audio-api asset path: ${relativePath}`);
  }
  return join(packageDir, ...parts);
}
