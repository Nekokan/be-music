import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const seaState = vi.hoisted(() => ({
  getAsset: vi.fn(),
  getRawAsset: vi.fn(),
}));

async function loadModule() {
  vi.resetModules();
  vi.doMock('node:sea', () => ({
    getAsset: seaState.getAsset,
    getRawAsset: seaState.getRawAsset,
  }));
  return await import('./node-web-audio-sea.ts');
}

function toArrayBuffer(source: string): ArrayBuffer {
  return new TextEncoder().encode(source).buffer;
}

afterEach(() => {
  vi.doUnmock('node:sea');
  seaState.getAsset.mockReset();
  seaState.getRawAsset.mockReset();
});

describe('SEA node-web-audio-api loader', () => {
  test('skips loading outside SEA', async () => {
    const { loadSeaNodeWebAudioApi } = await loadModule();

    expect(loadSeaNodeWebAudioApi()).toBeUndefined();
    expect(seaState.getAsset).toHaveBeenCalledWith('@be-music/player/sea-node-web-audio-api/manifest.json', 'utf8');
    expect(seaState.getRawAsset).not.toHaveBeenCalled();
  });

  test('materializes package assets once and loads the extracted CJS entry', async () => {
    const manifest = {
      files: [
        { assetKey: 'test/index.cjs', path: 'index.cjs' },
        { assetKey: 'test/js/context.cjs', path: 'js/context.cjs' },
      ],
    };
    seaState.getAsset.mockReturnValue(JSON.stringify(manifest));
    seaState.getRawAsset.mockImplementation((assetKey: string) => {
      if (assetKey === 'test/index.cjs') {
        return toArrayBuffer("module.exports = require('./js/context.cjs');\n");
      }
      if (assetKey === 'test/js/context.cjs') {
        return toArrayBuffer('exports.AudioContext = class AudioContext {};\n');
      }
      throw new Error(`Unexpected asset: ${assetKey}`);
    });
    const { loadSeaNodeWebAudioApi } = await loadModule();

    const first = loadSeaNodeWebAudioApi() as { AudioContext?: unknown };
    const second = loadSeaNodeWebAudioApi();

    expect(typeof first.AudioContext).toBe('function');
    expect(second).toBe(first);
    expect(seaState.getAsset).toHaveBeenCalledTimes(1);
    expect(seaState.getRawAsset).toHaveBeenCalledTimes(2);

    const indexPath = join(
      process.env.TMPDIR ?? '/tmp',
      `be-music-node-web-audio-api-sea-${process.pid}`,
      'node-web-audio-api',
      'index.cjs',
    );
    expect(readFileSync(indexPath, 'utf8')).toBe("module.exports = require('./js/context.cjs');\n");
  });
});
