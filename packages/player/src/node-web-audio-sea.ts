import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { getAsset, getRawAsset } from 'node:sea';

const SEA_NODE_WEB_AUDIO_ASSET_PREFIX = '@be-music/player/sea-node-web-audio-api/';
const SEA_NODE_WEB_AUDIO_MANIFEST_ASSET = `${SEA_NODE_WEB_AUDIO_ASSET_PREFIX}manifest.json`;
const SEA_NODE_WEB_AUDIO_PACKAGE_DIR_ENV = 'BE_MUSIC_SEA_NODE_WEB_AUDIO_API_DIR';

interface SeaNodeWebAudioFileAsset {
  assetKey: string;
  path: string;
}

interface SeaNodeWebAudioManifest {
  files: SeaNodeWebAudioFileAsset[];
}

let extractedPackageDir: string | undefined;

export function loadSeaNodeWebAudioApi(): unknown | undefined {
  let packageDir = process.env[SEA_NODE_WEB_AUDIO_PACKAGE_DIR_ENV];
  try {
    packageDir ??= materializeSeaNodeWebAudioPackage();
  } catch {
    return undefined;
  }

  const packageEntry = join(packageDir, 'index.cjs');
  try {
    return createRequire(packageEntry)(packageEntry);
  } catch {
    return undefined;
  }
}

function materializeSeaNodeWebAudioPackage(): string {
  if (extractedPackageDir) {
    return extractedPackageDir;
  }

  const manifest = readManifest();
  const packageDir = join(tmpdir(), `be-music-node-web-audio-api-sea-${process.pid}`, 'node-web-audio-api');

  for (const file of manifest.files) {
    const filePath = resolvePackageFilePath(packageDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(getRawAsset(file.assetKey)), { mode: 0o600 });
  }

  extractedPackageDir = packageDir;
  return packageDir;
}

function readManifest(): SeaNodeWebAudioManifest {
  const source = getAsset(SEA_NODE_WEB_AUDIO_MANIFEST_ASSET, 'utf8');
  if (typeof source !== 'string') {
    throw new Error('SEA node-web-audio-api manifest is unavailable');
  }

  const parsed = JSON.parse(source) as Partial<SeaNodeWebAudioManifest>;
  if (!Array.isArray(parsed.files)) {
    throw new Error('SEA node-web-audio-api manifest is invalid');
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
