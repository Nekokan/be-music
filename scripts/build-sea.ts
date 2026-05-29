import { chmod, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';

const execFileAsync = promisify(execFile);

const SEA_WORKER_BANNER = [
  "globalThis.Worker ??= (() => { try { return require('node:worker_threads').Worker; } catch { return undefined; } })();",
  'globalThis.FileList ??= class FileList {};',
  'globalThis.ImageData ??= class ImageData {};',
].join('\n');

interface CliArgs {
  packageName: SeaTargetName;
  output?: string;
  nodeBinary?: string;
  bundleOnly: boolean;
}

interface SeaTargetConfig {
  packageDir: string;
  outputBaseName: string;
  optionalExternalModules?: string[];
  bundleBanner?: string;
  aliases?: Record<string, string>;
  workerAssets?: SeaWorkerAssetConfig[];
  nodeWebAudioAssets?: SeaNodeWebAudioAssetConfig;
}

interface SeaWorkerAssetConfig {
  assetKey: string;
  entry: string;
  fileName: string;
}

interface SeaNodeWebAudioAssetConfig {
  assetPrefix: string;
}

interface SeaAssetFile {
  packagePath: string;
  sourcePath: string;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  name?: string;
  version?: string;
}

const TARGET_NAMES = ['player', 'audio-renderer'] as const;
type SeaTargetName = (typeof TARGET_NAMES)[number];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(scriptDir, '..');
const requireFromScript = createRequire(import.meta.url);

const SEA_TARGETS: Record<SeaTargetName, SeaTargetConfig> = {
  player: {
    packageDir: resolve(repositoryDir, 'packages/player-tui'),
    outputBaseName: 'be-music-player',
    optionalExternalModules: ['node-web-audio-api', '@uwx/libav.js-fat'],
    bundleBanner: SEA_WORKER_BANNER,
    aliases: {
      '@be-music/audio-renderer/triggers': resolve(repositoryDir, 'packages/audio-renderer/src/core/triggers.ts'),
      '@be-music/audio-renderer': resolve(repositoryDir, 'packages/audio-renderer/src/index.ts'),
      '@be-music/chart': resolve(repositoryDir, 'packages/chart/src/index.ts'),
      '@be-music/json': resolve(repositoryDir, 'packages/json/src/index.ts'),
      '@be-music/parser': resolve(repositoryDir, 'packages/parser/src/index.ts'),
      '@be-music/player/playable-notes': resolve(repositoryDir, 'packages/player/src/playable-notes.ts'),
      '@be-music/player/audio-sink': resolve(repositoryDir, 'packages/player/src/audio-sink.ts'),
      '@be-music/player/image-resize-algorithm': resolve(
        repositoryDir,
        'packages/player/src/image-resize-algorithm.ts',
      ),
      '@be-music/player/state-signals': resolve(repositoryDir, 'packages/player/src/state-signals.ts'),
      '@be-music/player/utils': resolve(repositoryDir, 'packages/player/src/utils.ts'),
      '@be-music/player/core': resolve(repositoryDir, 'packages/player/src/core'),
      '@be-music/player': resolve(repositoryDir, 'packages/player/src/index.ts'),
      // Subpath aliases must come before the package-root alias — Vite picks the first matching entry, so a
      // bare `@be-music/utils` alias would shadow `@be-music/utils/core` (= `packages/utils/src/index.ts/core`,
      // invalid). Each subpath here mirrors a `package.json` `exports` entry plus the in-tree TS source.
      '@be-music/utils/cli-path': resolve(repositoryDir, 'packages/utils/src/cli-path.ts'),
      '@be-music/utils/core': resolve(repositoryDir, 'packages/utils/src/core.ts'),
      '@be-music/utils/log': resolve(repositoryDir, 'packages/utils/src/log.ts'),
      '@be-music/utils/path': resolve(repositoryDir, 'packages/utils/src/path.ts'),
      '@be-music/utils/pcm': resolve(repositoryDir, 'packages/utils/src/pcm.ts'),
      '@be-music/utils/workerize': resolve(repositoryDir, 'packages/utils/src/workerize.ts'),
      '@be-music/utils': resolve(repositoryDir, 'packages/utils/src/index.ts'),
    },
    workerAssets: [
      {
        assetKey: '@be-music/player-tui/sea-worker/node-gameplay-worker.cjs',
        entry: resolve(repositoryDir, 'packages/player-tui/src/node/node-gameplay-worker.ts'),
        fileName: 'node-gameplay-worker.cjs',
      },
      {
        assetKey: '@be-music/player-tui/sea-worker/node-ui-worker.cjs',
        entry: resolve(repositoryDir, 'packages/player-tui/src/node/node-ui-worker.ts'),
        fileName: 'node-ui-worker.cjs',
      },
      {
        assetKey: '@be-music/player-tui/sea-worker/bga-video-worker.cjs',
        entry: resolve(repositoryDir, 'packages/player-tui/src/bga-video-worker.ts'),
        fileName: 'bga-video-worker.cjs',
      },
    ],
    nodeWebAudioAssets: {
      assetPrefix: '@be-music/player/sea-node-web-audio-api/',
    },
  },
  'audio-renderer': {
    packageDir: resolve(repositoryDir, 'packages/audio-renderer'),
    outputBaseName: 'be-music-audio-render',
    bundleBanner: SEA_WORKER_BANNER,
    aliases: {
      '@be-music/chart': resolve(repositoryDir, 'packages/chart/src/index.ts'),
      '@be-music/json': resolve(repositoryDir, 'packages/json/src/index.ts'),
      '@be-music/parser': resolve(repositoryDir, 'packages/parser/src/index.ts'),
      // Same subpath-before-root order as the player target above. audio-renderer imports `@be-music/utils/
      // core` for `extname` / `isAbortError` and `@be-music/utils/path` for `resolveFirstExistingPath`.
      '@be-music/utils/cli-path': resolve(repositoryDir, 'packages/utils/src/cli-path.ts'),
      '@be-music/utils/core': resolve(repositoryDir, 'packages/utils/src/core.ts'),
      '@be-music/utils/log': resolve(repositoryDir, 'packages/utils/src/log.ts'),
      '@be-music/utils/path': resolve(repositoryDir, 'packages/utils/src/path.ts'),
      '@be-music/utils/pcm': resolve(repositoryDir, 'packages/utils/src/pcm.ts'),
      '@be-music/utils/workerize': resolve(repositoryDir, 'packages/utils/src/workerize.ts'),
      '@be-music/utils': resolve(repositoryDir, 'packages/utils/src/index.ts'),
    },
  },
};

function printUsage() {
  process.stdout.write(
    [
      'Usage: tsx scripts/build-sea.ts --package <player|audio-renderer> [options]',
      '',
      'Essential options:',
      '  -p, --package <name>      Target package to build SEA for',
      '  -o, --output <path>       Output executable path',
      '',
      'Advanced options:',
      '      --node-binary <path>  Node executable used for SEA build (default: current node)',
      '      --bundle-only         Build only the SEA bundle and config file',
      '',
      'Developer options:',
      '  -h, --help                Show this help',
      '',
      'Requirements:',
      '  Node.js 25.5+ with built-in `--build-sea` support',
    ].join('\n') + '\n',
  );
}

function parseArgs(argv: string[]): CliArgs {
  let packageName: SeaTargetName | undefined;
  let output: string | undefined;
  let nodeBinary: string | undefined;
  let bundleOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    }

    if (token === '--bundle-only') {
      bundleOnly = true;
      continue;
    }

    if (token === '--package' || token === '-p') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${token}`);
      }
      if (!TARGET_NAMES.includes(value as SeaTargetName)) {
        throw new Error(`Unknown package: ${value}`);
      }
      packageName = value as SeaTargetName;
      index += 1;
      continue;
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

    if (token === '--node-binary') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${token}`);
      }
      nodeBinary = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!packageName) {
    throw new Error('Missing required option: --package <player|audio-renderer>');
  }

  return {
    packageName,
    output,
    nodeBinary,
    bundleOnly,
  };
}

function toAbsolutePath(pathValue?: string): string | undefined {
  if (!pathValue) {
    return undefined;
  }
  return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue);
}

function buildExternalModules(optionalExternalModules: string[]): string[] {
  const modules = new Set(optionalExternalModules);
  for (const builtin of builtinModules) {
    modules.add(builtin);
    modules.add(`node:${builtin}`);
  }
  return [...modules];
}

function createWorkspaceAliasPlugin(aliases?: Record<string, string>) {
  if (!aliases) {
    return undefined;
  }

  // Iterate longest-prefix-first so a request like `@be-music/player/core/ui-options` matches the
  // `@be-music/player/core` alias before the shorter `@be-music/player` one. Object iteration order
  // already preserves the order specified in `SEA_TARGETS`, but sorting by length makes the contract
  // explicit and survives a future map literal reorder.
  const entries = Object.entries(aliases).sort(([a], [b]) => b.length - a.length);
  // The plugin needs `this.resolve` access (provided by Rollup at call time) so the `async resolveId`
  // method can delegate extension / index resolution to Rollup's downstream resolvers. Returning a bare
  // path like `packages/player/src/core/ui-options` would otherwise fail because `@rollup/plugin-alias`
  // bypasses the rest of the resolution pipeline once a plugin returns a string from `resolveId`.
  return {
    name: 'be-music-sea-workspace-alias',
    async resolveId(
      this: {
        resolve: (id: string, importer?: string, options?: { skipSelf?: boolean }) => Promise<{ id: string } | null>;
      },
      source: string,
    ): Promise<string | null> {
      for (const [find, replacement] of entries) {
        let target: string | undefined;
        if (source === find) {
          target = replacement;
        } else if (source.startsWith(`${find}/`)) {
          target = `${replacement}/${source.slice(find.length + 1)}`;
        }
        if (target !== undefined) {
          // Delegate extension resolution (`.ts`, `.js`, `.tsx`, etc.) and index lookup to Rollup's
          // built-in resolver. `skipSelf: true` prevents infinite recursion through this plugin.
          const resolved = await this.resolve(target, undefined, { skipSelf: true });
          return resolved?.id ?? target;
        }
      }
      return null;
    },
  };
}

async function buildSeaBundle(
  config: SeaTargetConfig,
  seaDir: string,
  entry: string,
  fileName: string,
  emptyOutDir: boolean,
): Promise<void> {
  const workspaceAliasPlugin = createWorkspaceAliasPlugin(config.aliases);
  await build({
    configFile: false,
    resolve: {
      alias: config.aliases,
      conditions: ['source', 'node'],
      mainFields: ['source', 'module', 'main'],
    },
    build: {
      target: 'node25',
      outDir: seaDir,
      emptyOutDir,
      codeSplitting: false,
      minify: false,
      sourcemap: false,
      lib: {
        entry,
        formats: ['cjs'],
        fileName: () => fileName,
      },
      rollupOptions: {
        plugins: workspaceAliasPlugin ? [workspaceAliasPlugin] : undefined,
        external: buildExternalModules(config.optionalExternalModules ?? []),
        output: {
          banner: config.bundleBanner,
          entryFileNames: fileName,
        },
      },
    },
  });
}

async function buildSeaEntryBundle(config: SeaTargetConfig, seaDir: string): Promise<void> {
  await buildSeaBundle(config, seaDir, resolve(config.packageDir, 'src/cli.ts'), 'sea-entry.cjs', true);
}

async function buildSeaWorkerAssets(
  config: SeaTargetConfig,
  seaDir: string,
): Promise<Record<string, string> | undefined> {
  if (!config.workerAssets || config.workerAssets.length === 0) {
    return undefined;
  }

  const assets: Record<string, string> = {};
  for (const worker of config.workerAssets) {
    await buildSeaBundle(config, seaDir, worker.entry, worker.fileName, false);
    assets[worker.assetKey] = resolve(seaDir, worker.fileName);
  }
  return assets;
}

async function buildSeaNodeWebAudioAssets(
  config: SeaTargetConfig,
  seaDir: string,
): Promise<Record<string, string> | undefined> {
  if (!config.nodeWebAudioAssets) {
    return undefined;
  }

  const packageEntry = requireFromScript.resolve('node-web-audio-api', { paths: [config.packageDir] });
  const packageDir = dirname(packageEntry);
  const nativeFileName = getNodeWebAudioNativeFileName();
  const assetFiles = [
    { packagePath: 'package.json', sourcePath: resolve(packageDir, 'package.json') },
    { packagePath: 'index.cjs', sourcePath: resolve(packageDir, 'index.cjs') },
    { packagePath: 'load-native.cjs', sourcePath: resolve(packageDir, 'load-native.cjs') },
    ...(await collectPackageFileNames(resolve(packageDir, 'js'))).map((fileName) => ({
      packagePath: `js/${fileName}`,
      sourcePath: resolve(packageDir, 'js', fileName),
    })),
    { packagePath: nativeFileName, sourcePath: resolve(packageDir, nativeFileName) },
    ...(await collectPackageDependencyFiles(packageDir)),
  ];

  const assetPrefix = config.nodeWebAudioAssets.assetPrefix;
  const manifestPath = resolve(seaDir, 'node-web-audio-api-manifest.json');
  const manifest = {
    files: assetFiles.map((file) => ({
      path: file.packagePath,
      assetKey: `${assetPrefix}files/${file.packagePath}`,
    })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const assets: Record<string, string> = {
    [`${assetPrefix}manifest.json`]: manifestPath,
  };
  for (const file of assetFiles) {
    assets[`${assetPrefix}files/${file.packagePath}`] = file.sourcePath;
  }
  return assets;
}

async function collectPackageDependencyFiles(
  packageDir: string,
  destinationNodeModulesDir = 'node_modules',
  seenPackageJsonPaths = new Set<string>(),
): Promise<SeaAssetFile[]> {
  const packageJsonPath = resolve(packageDir, 'package.json');
  const packageJson = await readPackageJson(packageJsonPath);
  const dependencies = Object.keys(packageJson.dependencies ?? {}).sort();
  const files: SeaAssetFile[] = [];

  for (const dependencyName of dependencies) {
    const dependencyPackageJsonPath = await resolveDependencyPackageJsonPath(dependencyName, packageDir);
    if (seenPackageJsonPaths.has(dependencyPackageJsonPath)) {
      continue;
    }
    seenPackageJsonPaths.add(dependencyPackageJsonPath);

    const dependencyPackageDir = dirname(dependencyPackageJsonPath);
    const destinationPackageDir = `${destinationNodeModulesDir}/${dependencyName}`;
    files.push(...(await collectPackageFiles(dependencyPackageDir, destinationPackageDir)));
    files.push(
      ...(await collectPackageDependencyFiles(
        dependencyPackageDir,
        `${destinationPackageDir}/node_modules`,
        seenPackageJsonPaths,
      )),
    );
  }

  return files;
}

async function resolveDependencyPackageJsonPath(dependencyName: string, packageDir: string): Promise<string> {
  try {
    return requireFromScript.resolve(`${dependencyName}/package.json`, {
      paths: [packageDir],
    });
  } catch {
    const entryPath = requireFromScript.resolve(dependencyName, { paths: [packageDir] });
    return await findPackageJsonForEntry(dependencyName, entryPath);
  }
}

async function findPackageJsonForEntry(packageName: string, entryPath: string): Promise<string> {
  let dir = dirname(entryPath);
  while (true) {
    const packageJsonPath = resolve(dir, 'package.json');
    try {
      const packageJson = await readPackageJson(packageJsonPath);
      if (packageJson.name === packageName) {
        return packageJsonPath;
      }
    } catch {
      // Keep walking upward until the package root is found.
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Unable to locate package.json for dependency: ${packageName}`);
    }
    dir = parent;
  }
}

async function collectPackageFiles(packageDir: string, destinationPackageDir: string): Promise<SeaAssetFile[]> {
  return (await collectPackageFileNames(packageDir)).filter(isRuntimePackageFile).map((fileName) => ({
    packagePath: `${destinationPackageDir}/${fileName}`,
    sourcePath: resolve(packageDir, fileName),
  }));
}

function isRuntimePackageFile(fileName: string): boolean {
  const parts = fileName.split('/');
  if (parts.includes('node_modules') || parts.some((part) => part.startsWith('.'))) {
    return false;
  }
  if (fileName === 'package.json') {
    return true;
  }
  if (fileName.endsWith('.map') || fileName.endsWith('.d.ts')) {
    return false;
  }
  return /\.(?:cjs|mjs|js|json|node|wasm)$/.test(fileName);
}

async function readPackageJson(pathValue: string): Promise<PackageJson> {
  return JSON.parse(await readFile(pathValue, 'utf8')) as PackageJson;
}

async function collectPackageFileNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const fileNames: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      for (const childFileName of await collectPackageFileNames(entryPath)) {
        fileNames.push(`${entry.name}/${childFileName}`);
      }
      continue;
    }
    if (entry.isFile()) {
      fileNames.push(relative(dir, entryPath).split('\\').join('/'));
    }
  }

  return fileNames.sort();
}

function getNodeWebAudioNativeFileName(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') {
    if (arch === 'x64' || arch === 'arm64') {
      return `node-web-audio-api.darwin-${arch}.node`;
    }
  }
  if (platform === 'linux') {
    if (arch === 'x64') {
      return 'node-web-audio-api.linux-x64-gnu.node';
    }
    if (arch === 'arm64') {
      return 'node-web-audio-api.linux-arm64-gnu.node';
    }
    if (arch === 'arm') {
      return 'node-web-audio-api.linux-arm-gnueabihf.node';
    }
  }
  if (platform === 'win32') {
    if (arch === 'x64' || arch === 'arm64') {
      return `node-web-audio-api.win32-${arch}-msvc.node`;
    }
  }
  throw new Error(`node-web-audio-api does not provide a bundled native binary for ${platform}-${arch}`);
}

const LOCAL_CHUNK_REQUIRE_PATTERN = /require\((['"])(\.\/[^'"]+)\1\)/g;

function findLocalChunkRequireIds(code: string): string[] {
  return [...code.matchAll(LOCAL_CHUNK_REQUIRE_PATTERN)].map((match) => match[2]).filter((id) => id !== undefined);
}

function replaceLocalChunkRequires(code: string, localChunkIds: Set<string>): string {
  return code.replace(LOCAL_CHUNK_REQUIRE_PATTERN, (match, _quote, id) =>
    localChunkIds.has(id) ? `__sea_require(${JSON.stringify(id)})` : match,
  );
}

function indentBlock(code: string): string {
  return code
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : ''))
    .join('\n');
}

async function collectLocalChunkFileNames(
  seaDir: string,
  entryFileName: string,
  entryFileNames: Set<string>,
): Promise<string[]> {
  const seaFiles = await readdir(seaDir);
  const chunkFileNames = new Set(
    seaFiles.filter((fileName) => fileName.endsWith('.cjs') && !entryFileNames.has(fileName)),
  );
  const collected = new Set<string>();

  const visitRequires = async (fileName: string): Promise<void> => {
    const code = await readFile(resolve(seaDir, fileName), 'utf8');
    for (const id of findLocalChunkRequireIds(code)) {
      const requiredFileName = id.slice('./'.length);
      if (!chunkFileNames.has(requiredFileName) || collected.has(requiredFileName)) {
        continue;
      }
      collected.add(requiredFileName);
      await visitRequires(requiredFileName);
    }
  };

  await visitRequires(entryFileName);
  return [...collected];
}

async function inlineSeaRelativeChunksForEntry(
  seaDir: string,
  entryFileName: string,
  localChunkFileNames: string[],
): Promise<void> {
  if (localChunkFileNames.length === 0) {
    return;
  }

  const localChunkIds = new Set(localChunkFileNames.map((fileName) => `./${fileName}`));
  const localChunkSources = await Promise.all(
    localChunkFileNames.map(async (fileName) => {
      const chunkPath = resolve(seaDir, fileName);
      const chunkCode = await readFile(chunkPath, 'utf8');
      return {
        fileName,
        code: replaceLocalChunkRequires(chunkCode, localChunkIds),
      };
    }),
  );

  const entryPath = resolve(seaDir, entryFileName);
  const entryCode = replaceLocalChunkRequires(await readFile(entryPath, 'utf8'), localChunkIds);
  const inlinedRuntime = [
    'const __sea_modules = Object.create(null);',
    'const __sea_module_cache = Object.create(null);',
    'function __sea_require(id) {',
    '  const cached = __sea_module_cache[id];',
    '  if (cached) {',
    '    return cached.exports;',
    '  }',
    '  const factory = __sea_modules[id];',
    '  if (!factory) {',
    '    return require(id);',
    '  }',
    '  const module = { exports: {} };',
    '  __sea_module_cache[id] = module;',
    '  factory(module, module.exports, __sea_require);',
    '  return module.exports;',
    '}',
    ...localChunkSources.flatMap(({ fileName, code }) => [
      `__sea_modules[${JSON.stringify(`./${fileName}`)}] = (module, exports, __sea_require) => {`,
      indentBlock(code),
      '};',
    ]),
    '',
  ].join('\n');

  await writeFile(entryPath, `${inlinedRuntime}${entryCode}`, 'utf8');
}

async function inlineSeaRelativeChunks(seaDir: string, entryFileNames: readonly string[]): Promise<void> {
  const entryFileNameSet = new Set(entryFileNames);
  const removableChunkFileNames = new Set<string>();

  for (const entryFileName of entryFileNames) {
    const localChunkFileNames = await collectLocalChunkFileNames(seaDir, entryFileName, entryFileNameSet);
    for (const fileName of localChunkFileNames) {
      removableChunkFileNames.add(fileName);
    }
    await inlineSeaRelativeChunksForEntry(seaDir, entryFileName, localChunkFileNames);
  }

  await Promise.all([...removableChunkFileNames].map((fileName) => unlink(resolve(seaDir, fileName))));
}

async function supportsNodeFlag(nodeBinaryPath: string, cwd: string, flag: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(nodeBinaryPath, ['--help'], { cwd });
    const text = `${stdout}\n${stderr}`;
    return text.includes(flag);
  } catch {
    return false;
  }
}

async function runSeaBuild(nodeBinaryPath: string, cwd: string, configFilePath: string): Promise<void> {
  try {
    await execFileAsync(nodeBinaryPath, ['--build-sea', configFilePath], { cwd });
  } catch (error) {
    const stdout =
      typeof (error as { stdout?: unknown })?.stdout === 'string' ? (error as { stdout: string }).stdout : '';
    const stderr =
      typeof (error as { stderr?: unknown })?.stderr === 'string' ? (error as { stderr: string }).stderr : '';
    const output = `${stdout}\n${stderr}`;

    if (output.includes('--build-sea') && output.toLowerCase().includes('unknown')) {
      throw new Error(
        `The selected Node executable does not support --build-sea: ${nodeBinaryPath}. ` +
          'Use Node.js 25.5+ with built-in SEA support.',
      );
    }

    throw new Error(`SEA build failed.\n${output}`.trim());
  }
}

async function maybeAdhocSignMacBinary(cwd: string, pathValue: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    await execFileAsync('codesign', ['--sign', '-', '--force', pathValue], { cwd });
  } catch {
    // Ad-hoc signing is best-effort for local execution.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targetConfig = SEA_TARGETS[args.packageName];
  const seaDir = resolve(targetConfig.packageDir, 'dist-sea');
  const bundlePath = resolve(seaDir, 'sea-entry.cjs');
  const configPath = resolve(seaDir, 'sea-config.json');
  const nodeBinaryPath = toAbsolutePath(args.nodeBinary) ?? process.execPath;
  const defaultOutputName =
    process.platform === 'win32' ? `${targetConfig.outputBaseName}.exe` : targetConfig.outputBaseName;
  const outputPath = toAbsolutePath(args.output) ?? resolve(seaDir, defaultOutputName);

  await mkdir(seaDir, { recursive: true });

  process.stdout.write('Building SEA bundle...\n');
  await buildSeaEntryBundle(targetConfig, seaDir);
  const workerAssets = await buildSeaWorkerAssets(targetConfig, seaDir);
  const nodeWebAudioAssets = await buildSeaNodeWebAudioAssets(targetConfig, seaDir);
  const assets = {
    ...(workerAssets ?? {}),
    ...(nodeWebAudioAssets ?? {}),
  };
  await inlineSeaRelativeChunks(seaDir, [
    'sea-entry.cjs',
    ...(targetConfig.workerAssets?.map((asset) => asset.fileName) ?? []),
  ]);

  const seaConfig = {
    main: bundlePath,
    mainFormat: 'commonjs',
    output: outputPath,
    executable: nodeBinaryPath,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
  };
  await writeFile(configPath, `${JSON.stringify(seaConfig, null, 2)}\n`, 'utf8');

  if (args.bundleOnly) {
    process.stdout.write(`SEA bundle generated:\n  entry: ${bundlePath}\n  config: ${configPath}\n`);
    return;
  }

  const hasBuildSea = await supportsNodeFlag(nodeBinaryPath, targetConfig.packageDir, '--build-sea');
  if (!hasBuildSea) {
    throw new Error(
      `The selected Node executable does not support --build-sea: ${nodeBinaryPath}. ` +
        'Use Node.js 25.5+ with built-in SEA support.',
    );
  }

  process.stdout.write('Building SEA executable...\n');
  await runSeaBuild(nodeBinaryPath, targetConfig.packageDir, configPath);

  if (process.platform !== 'win32') {
    await chmod(outputPath, 0o755);
  }

  await maybeAdhocSignMacBinary(targetConfig.packageDir, outputPath);
  process.stdout.write(`SEA executable generated: ${outputPath}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error && error.message ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
