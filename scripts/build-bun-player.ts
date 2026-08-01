import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SUPPORTED_TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-darwin-x64-baseline'] as const;
type BunPlayerTarget = (typeof SUPPORTED_TARGETS)[number];

interface CliArgs {
  output?: string;
  target: BunPlayerTarget;
}

interface BunBuildConfig {
  entrypoints: string[];
  conditions: string[];
  compile: {
    target: BunPlayerTarget;
    outfile: string;
    autoloadDotenv: boolean;
    autoloadBunfig: boolean;
    autoloadTsconfig: boolean;
    autoloadPackageJson: boolean;
  };
  plugins: BunBuildPlugin[];
  naming: {
    entry: string;
  };
  banner: string;
  sourcemap: 'none';
}

interface BunBuildResult {
  success: boolean;
  logs: unknown[];
}

interface BunBuildPlugin {
  name: string;
  setup(builder: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string }) => { path: string; namespace?: string } | undefined,
    ): void;
    onLoad(
      options: { filter: RegExp; namespace?: string },
      callback: (args: { path: string }) => { contents: string; loader: 'js' } | undefined,
    ): void;
  }): void;
}

interface BunRuntime {
  build(config: BunBuildConfig): Promise<BunBuildResult>;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(scriptDir, '..');
const playerTuiDir = resolve(repositoryDir, 'packages/player-tui');
const playerDir = resolve(repositoryDir, 'packages/player');
const audioRendererDir = resolve(repositoryDir, 'packages/audio-renderer');

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: bun scripts/build-bun-player.ts [options]',
      '',
      'Options:',
      '  -o, --output <path>       Output executable path',
      '      --target <target>     bun-darwin-x64-baseline (default), bun-darwin-x64, or bun-darwin-arm64',
      '  -h, --help                Show this help',
    ].join('\n') + '\n',
  );
}

function parseArgs(argv: string[]): CliArgs {
  let output: string | undefined;
  let target: BunPlayerTarget = 'bun-darwin-x64-baseline';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    }
    if (token === '--output' || token === '-o') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${token}`);
      }
      output = value;
      index += 1;
      continue;
    }
    if (token === '--target') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --target');
      }
      if (!SUPPORTED_TARGETS.includes(value as BunPlayerTarget)) {
        throw new Error(`Unsupported Bun player target: ${value}`);
      }
      target = value as BunPlayerTarget;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { output, target };
}

function toAbsolutePath(pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue);
}

async function resolvePackageDir(name: string, fromDir: string): Promise<string> {
  const requireFromBase = createRequire(join(fromDir, 'package.json'));
  try {
    return dirname(await realpath(requireFromBase.resolve(`${name}/package.json`)));
  } catch {
    let dir = dirname(await realpath(requireFromBase.resolve(name)));
    while (true) {
      try {
        const manifest = requireFromBase(join(dir, 'package.json')) as { name?: string };
        if (manifest.name === name) {
          return dir;
        }
      } catch {
        // Keep walking until the package root is found.
      }
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error(`Cannot locate the package directory of ${name}`);
      }
      dir = parent;
    }
  }
}

async function createBunPlayerPlugin(target: BunPlayerTarget): Promise<BunBuildPlugin> {
  const targetArch = target === 'bun-darwin-arm64' ? 'arm64' : 'x64';
  const audioPackageDir = await resolvePackageDir('node-web-audio-api', playerDir);
  const audioAddonPath = resolve(audioPackageDir, `node-web-audio-api.darwin-${targetArch}.node`);
  const oggVorbisPackageDir = await resolvePackageDir('@wasm-audio-decoders/ogg-vorbis', audioRendererDir);
  const mpegPackageDir = await resolvePackageDir('mpg123-decoder', audioRendererDir);
  const oggOpusPackageDir = await resolvePackageDir('ogg-opus-decoder', audioRendererDir);
  const libAvPackageDir = await resolvePackageDir('@uwx/libav.js-fat', playerTuiDir);
  const libAvManifest = JSON.parse(await readFile(resolve(libAvPackageDir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof libAvManifest.version !== 'string' || libAvManifest.version.length === 0) {
    throw new Error('Cannot resolve the installed @uwx/libav.js-fat version.');
  }
  const libAvVersion = libAvManifest.version;
  const libAvFrontendPath = resolve(libAvPackageDir, 'dist/libav-fat.mjs');
  const libAvFactoryPath = resolve(libAvPackageDir, `dist/libav-${libAvVersion}-fat.wasm.mjs`);
  const libAvWasmPath = resolve(libAvPackageDir, `dist/libav-${libAvVersion}-fat.wasm.wasm`);

  return {
    name: 'be-music-bun-player-runtime',
    setup(builder): void {
      builder.onResolve({ filter: /^node:sea$/ }, () => ({
        path: 'node:sea',
        namespace: 'be-music-bun-sea-shim',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'be-music-bun-sea-shim' }, () => ({
        contents: [
          'export function isSea() { return false; }',
          "export function getAsset() { throw new Error('Node SEA assets are unavailable in a Bun executable'); }",
        ].join('\n'),
        loader: 'js',
      }));

      // isoworker's browser worker protocol starts emitting before it installs the first callback under Bun's
      // worker_threads bridge. SEA already runs these small decode helpers inline; use the same execution model in
      // the Bun executable while the player-owned gameplay/UI/video workers remain real worker threads.
      builder.onResolve({ filter: /^isoworker$/ }, () => ({
        path: 'isoworker',
        namespace: 'be-music-bun-isoworker',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'be-music-bun-isoworker' }, () => ({
        contents: [
          'export function workerize(fn) {',
          '  return Object.assign((...args) => {',
          '    const callback = args.pop();',
          '    Promise.resolve().then(() => fn(...args)).then(',
          '      (result) => callback(undefined, result),',
          '      (error) => callback(error, undefined),',
          '    );',
          '  }, { close() {} });',
          '}',
        ].join('\n'),
        loader: 'js',
      }));

      // node-web-audio-api selects its addon through createRequire(import.meta.url), which Bun cannot trace when
      // compiling. Replace only that loader with a static target-matching import so the addon is embedded.
      builder.onLoad({ filter: /node-web-audio-api\/load-native\.js$/ }, () => ({
        contents: `import nativeBinding from ${JSON.stringify(audioAddonPath)};\nexport default nativeBinding;\n`,
        loader: 'js',
      }));

      // Bun 1.3 tree-shakes the unused WebWorker decoder class from these package entrypoints but leaves the
      // package's assignNames() call behind, producing a startup ReferenceError. The player only imports the
      // direct decoders, so expose exactly those classes in the Bun build.
      const directDecoderEntries = [
        {
          filter: /@wasm-audio-decoders\/ogg-vorbis\/index\.js$/,
          source: resolve(oggVorbisPackageDir, 'src/OggVorbisDecoder.js'),
          exportName: 'OggVorbisDecoder',
        },
        {
          filter: /mpg123-decoder\/index\.js$/,
          source: resolve(mpegPackageDir, 'src/MPEGDecoder.js'),
          exportName: 'MPEGDecoder',
        },
        {
          filter: /ogg-opus-decoder\/index\.js$/,
          source: resolve(oggOpusPackageDir, 'src/OggOpusDecoder.js'),
          exportName: 'OggOpusDecoder',
        },
      ];
      for (const decoder of directDecoderEntries) {
        builder.onLoad({ filter: decoder.filter }, () => ({
          contents: [
            `import Decoder from ${JSON.stringify(decoder.source)};`,
            `const ${decoder.exportName} = Decoder;`,
            `export { ${decoder.exportName} };`,
          ].join('\n'),
          loader: 'js',
        }));
      }

      // libav.js constructs both the factory-module URL and wasm URL at runtime. Pin the non-threaded factory
      // already used by the player and pass the embedded wasm path explicitly.
      builder.onResolve({ filter: /^@uwx\/libav\.js-fat$/ }, () => ({
        path: '@uwx/libav.js-fat',
        namespace: 'be-music-bun-libav',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'be-music-bun-libav' }, () => ({
        contents: [
          `import LibAV from ${JSON.stringify(libAvFrontendPath)};`,
          `import LibAVFactory from ${JSON.stringify(libAvFactoryPath)};`,
          `import wasmPath from ${JSON.stringify(libAvWasmPath)} with { type: 'file' };`,
          'const BunLibAV = {',
          '  ...LibAV,',
          '  LibAV(options = {}) {',
          '    return LibAV.LibAV({ ...options, factory: LibAVFactory, wasmurl: wasmPath });',
          '  },',
          '};',
          'export default BunLibAV;',
        ].join('\n'),
        loader: 'js',
      }));
    },
  };
}

async function maybeAdhocSignMacBinary(outputPath: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    await execFileAsync('codesign', ['--sign', '-', '--force', outputPath]);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : String(error);
    process.stderr.write(
      `Warning: ad-hoc code signing failed (${message.trim()}).\n` +
        `Sign the generated executable manually with:\n  codesign --sign - --force ${outputPath}\n`,
    );
  }
}

async function main(): Promise<void> {
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!bun) {
    throw new Error('This build script must be run with Bun.');
  }

  const args = parseArgs(process.argv.slice(2));
  const defaultOutputName = args.target === 'bun-darwin-arm64' ? 'be-music-player-arm64' : 'be-music-player';
  const outputPath = args.output ? toAbsolutePath(args.output) : resolve(playerTuiDir, 'dist-bun', defaultOutputName);
  await mkdir(dirname(outputPath), { recursive: true });

  process.stdout.write(`Building Bun player executable (${args.target})...\n`);
  const result = await bun.build({
    entrypoints: [
      resolve(playerTuiDir, 'src/cli/runner.ts'),
      resolve(playerTuiDir, 'src/node/node-gameplay-worker.ts'),
      resolve(playerTuiDir, 'src/node/node-ui-worker.ts'),
      resolve(playerTuiDir, 'src/bga-video-worker.ts'),
    ],
    conditions: ['source'],
    compile: {
      target: args.target,
      outfile: outputPath,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    plugins: [await createBunPlayerPlugin(args.target)],
    naming: {
      entry: '[name].[ext]',
    },
    banner: [
      "globalThis.Worker ??= (() => { try { return require('node:worker_threads').Worker; } catch { return undefined; } })();",
      'globalThis.FileList ??= class FileList {};',
      'globalThis.ImageData ??= class ImageData {};',
    ].join('\n'),
    sourcemap: 'none',
  });
  if (!result.success) {
    for (const log of result.logs) {
      process.stderr.write(`${String(log)}\n`);
    }
    throw new Error('Bun player build failed.');
  }
  await maybeAdhocSignMacBinary(outputPath);
  process.stdout.write(`Bun player executable generated: ${outputPath}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error && error.message ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
