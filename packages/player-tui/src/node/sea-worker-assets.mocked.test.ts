import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

const seaState = vi.hoisted(() => ({
  isSea: false,
  getAsset: vi.fn(),
  getRawAsset: vi.fn(),
}));

async function loadModule() {
  vi.resetModules();
  vi.doMock('node:sea', () => ({
    isSea: () => seaState.isSea,
    getAsset: seaState.getAsset,
    getRawAsset: seaState.getRawAsset,
  }));
  return await import('./sea-worker-assets.ts');
}

afterEach(() => {
  vi.doUnmock('node:sea');
  seaState.isSea = false;
  seaState.getAsset.mockReset();
  seaState.getRawAsset.mockReset();
});

describe('SEA worker assets', () => {
  test('resolves source and built worker URLs outside SEA', async () => {
    const { resolveNodeWorkerUrl } = await loadModule();

    expect(resolveNodeWorkerUrl('./worker.ts', './worker.js', 'file:///repo/src/runtime.ts', 'asset').href).toBe(
      'file:///repo/src/worker.ts',
    );
    expect(resolveNodeWorkerUrl('./worker.ts', './worker.js', 'file:///repo/dist/runtime.js', 'asset').href).toBe(
      'file:///repo/dist/worker.js',
    );
  });

  test('materializes SEA worker assets once and returns a file URL', async () => {
    seaState.isSea = true;
    seaState.getAsset.mockReturnValue('console.log("worker");\n');
    const { resolveNodeWorkerUrl } = await loadModule();

    const firstUrl = resolveNodeWorkerUrl('./worker.ts', './worker.js', undefined, 'test/worker.cjs');
    const secondUrl = resolveNodeWorkerUrl('./worker.ts', './worker.js', undefined, 'test/worker.cjs');

    expect(firstUrl.href).toBe(secondUrl.href);
    expect(readFileSync(fileURLToPath(firstUrl), 'utf8')).toBe('console.log("worker");\n');
    expect(seaState.getAsset).toHaveBeenCalledTimes(1);
    expect(seaState.getAsset).toHaveBeenCalledWith('test/worker.cjs', 'utf8');
  });

  test('materializes SEA node-web-audio-api assets and caches the package directory', async () => {
    seaState.isSea = true;
    const manifest = {
      files: [
        { assetKey: 'test/index.cjs', path: 'index.cjs' },
        { assetKey: 'test/js/context.cjs', path: 'js/context.cjs' },
      ],
    };
    seaState.getAsset.mockImplementation((assetKey: string) => {
      if (assetKey === '@be-music/player/sea-node-web-audio-api/manifest.json') {
        return JSON.stringify(manifest);
      }
      return 'console.log("worker");\n';
    });
    seaState.getRawAsset.mockImplementation(
      (assetKey: string) => new TextEncoder().encode(`asset:${assetKey}\n`).buffer,
    );
    const { resolveSeaNodeWebAudioPackageDir } = await loadModule();

    const firstDir = resolveSeaNodeWebAudioPackageDir();
    const secondDir = resolveSeaNodeWebAudioPackageDir();

    expect(firstDir).toBe(secondDir);
    expect(firstDir).toContain('be-music-node-web-audio-api-sea-');
    expect(readFileSync(`${firstDir}/index.cjs`, 'utf8')).toBe('asset:test/index.cjs\n');
    expect(readFileSync(`${firstDir}/js/context.cjs`, 'utf8')).toBe('asset:test/js/context.cjs\n');
    expect(seaState.getRawAsset).toHaveBeenCalledTimes(2);
  });
});
