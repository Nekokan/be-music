import { isAbortError, throwIfAborted } from '@be-music/utils/core';
import { loadOptionalNodeModule } from '@be-music/utils/optional-node-module';
import { NODE_AUDIO_STREAM_PROCESSOR_NAME, NODE_AUDIO_STREAM_PROCESSOR_SOURCE } from './audio-worklet-source.ts';

// Browser-compatible cooperative-sleep helper. Mirrors what `node:timers/promises.setTimeout` returned (a Promise
// that resolves after `ms` ms) but uses the global `setTimeout` available in both runtimes. Hand-rolled so this
// module stays importable from a browser bundle even though the rest of the file is the Node sink (which only
// runs when the runtime actually invokes `createNodeAudioSink`; see `engine.ts:createAudioSessionIfEnabled`).
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type AudioRuntime = 'node' | 'browser';
export type AudioEngine = 'webaudio';

export interface AudioSink {
  runtime: AudioRuntime;
  engine: AudioEngine;
  label: string;
  write: (chunk: Uint8Array) => boolean;
  writeFloat32?: (left: Float32Array, right: Float32Array, frameCount?: number) => boolean;
  waitWritable: (shouldStop: () => boolean) => Promise<void>;
  end: () => Promise<void>;
  destroy: () => void;
  onError: (listener: () => void) => void;
  getClockState: () => AudioSinkClockState;
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
}

export interface AudioSinkCreateOptions {
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  mode: 'auto' | 'manual';
  signal?: AbortSignal;
}

export interface WebAudioBufferLike {
  getChannelData: (channel: number) => Float32Array;
  copyToChannel?: (source: Float32Array, channelNumber: number, bufferOffset?: number) => void;
}

export interface WebAudioBufferSourceLike {
  buffer: WebAudioBufferLike | null;
  connect: (destination: unknown) => unknown;
  /**
   * Optional in the structural type because not every test fake bothers to model it, but every real Web Audio
   * implementation (browser + `node-web-audio-api`) provides it. Used by the sink to detach the source from the
   * destination once playback ends so the node becomes GC-eligible — without it, idle source nodes accumulate per
   * chunk written.
   */
  disconnect?: () => void;
  start: (when?: number) => void;
  /**
   * Spec-defined `ended` callback. Same optionality reasoning as {@link disconnect}.
   */
  onended?: (() => void) | null;
}

export interface WebAudioScriptProcessorNodeLike {
  connect: (destination: unknown) => unknown;
  disconnect?: () => void;
  onaudioprocess: ((event: { outputBuffer: WebAudioBufferLike }) => void) | null;
}

export interface WebAudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly audioWorklet?: {
    addModule: (moduleUrl: string) => Promise<void>;
  };
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => WebAudioBufferLike;
  createBufferSource: () => WebAudioBufferSourceLike;
  createScriptProcessor?: (
    bufferSize?: number,
    numberOfInputChannels?: number,
    numberOfOutputChannels?: number,
  ) => WebAudioScriptProcessorNodeLike;
  close?: () => Promise<void>;
  suspend?: () => Promise<void>;
  resume?: () => Promise<void>;
}

export interface AudioSinkClockState {
  outputSeconds: number;
  scheduledSeconds: number;
}

interface NodeWebAudioModule {
  AudioContext?: unknown;
  AudioWorkletNode?: unknown;
  default?: {
    AudioContext?: unknown;
    AudioWorkletNode?: unknown;
  };
}

interface NodeWebAudioContextConstructor {
  new (options?: { sampleRate?: number }): WebAudioContextLike;
}

interface NodeWebAudioWorkletNodeLike {
  connect: (destination: unknown) => unknown;
  disconnect?: () => void;
}

interface NodeWebAudioWorkletNodeConstructor {
  new (
    context: WebAudioContextLike,
    name: string,
    options: {
      numberOfInputs: number;
      numberOfOutputs: number;
      outputChannelCount: number[];
      processorOptions: Record<string, unknown>;
    },
  ): NodeWebAudioWorkletNodeLike;
}

interface NodeWebAudioRuntime {
  AudioContext: NodeWebAudioContextConstructor;
  AudioWorkletNode?: NodeWebAudioWorkletNodeConstructor;
}

const WEBAUDIO_HIGH_WATER_MS = 64;
const WEBAUDIO_LOW_WATER_MS = 32;
const WEBAUDIO_STREAM_RING_SECONDS = 0.25;

export function createBrowserAudioSink(context: WebAudioContextLike, options: AudioSinkCreateOptions): AudioSink {
  return createWebAudioSink('browser', context, options);
}

export async function createNodeAudioSink(options: AudioSinkCreateOptions): Promise<AudioSink | undefined> {
  throwIfAborted(options.signal);
  const runtime = await loadNodeWebAudioRuntime(options.signal);
  throwIfAborted(options.signal);
  if (!runtime) {
    return undefined;
  }

  let context: WebAudioContextLike;
  try {
    context = new runtime.AudioContext({
      sampleRate: options.sampleRate,
    });
  } catch {
    try {
      context = new runtime.AudioContext();
    } catch {
      return undefined;
    }
  }
  if (options.signal?.aborted) {
    await closeContextSafely(context);
    throwIfAborted(options.signal);
  }

  // Bun cannot run node-web-audio-api's AudioWorklet worker, while creating an AudioBufferSourceNode for every PCM
  // chunk eventually overwhelms the native graph on long-running charts. ScriptProcessorNode is deprecated in web
  // browsers, but node-web-audio-api implements it as one persistent native node and it does not depend on Bun's
  // incomplete worker_threads implementation. Keep this compatibility backend scoped to Bun.
  if ('Bun' in globalThis && context.createScriptProcessor) {
    try {
      return createNodeWebAudioScriptSink(context, options);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      process.stderr.write(`ScriptProcessor stream unavailable (${message}); using scheduled Web Audio buffers.\n`);
    }
  }

  // node-web-audio-api's AudioWorklet worker depends on worker_threads.markAsUntransferable. Bun currently exposes
  // that API but aborts when it is used, so retain the stable scheduled-buffer backend there.
  if (!('Bun' in globalThis) && runtime.AudioWorkletNode && context.audioWorklet) {
    try {
      return await createNodeWebAudioStreamSink(context, runtime.AudioWorkletNode, options);
    } catch (error) {
      // Fall back to scheduled AudioBufferSourceNodes when a runtime exposes an incomplete AudioWorklet API.
      const message = error instanceof Error && error.message ? error.message : String(error);
      process.stderr.write(`AudioWorklet stream unavailable (${message}); using scheduled Web Audio buffers.\n`);
    }
  }

  return createWebAudioSink('node', context, options);
}

function createNodeWebAudioScriptSink(context: WebAudioContextLike, options: AudioSinkCreateOptions): AudioSink {
  const channels = Math.max(1, Math.floor(options.channels));
  const bufferSize = resolveScriptProcessorBufferSize(options.samplesPerFrame);
  // node-web-audio-api currently rejects zero input channels even though this source-only node never reads input.
  const node = context.createScriptProcessor!(bufferSize, 1, channels);
  const capacity = Math.max(bufferSize * 8, Math.ceil(options.sampleRate * WEBAUDIO_STREAM_RING_SECONDS));
  const leftRing = new Float32Array(capacity);
  const rightRing = new Float32Array(capacity);
  const errorListeners = new Set<() => void>();
  const highWaterFrames = Math.max(bufferSize, Math.ceil((options.sampleRate * WEBAUDIO_HIGH_WATER_MS) / 1000));
  const lowWaterFrames = Math.max(
    bufferSize,
    Math.min(highWaterFrames - 1, Math.ceil((options.sampleRate * WEBAUDIO_LOW_WATER_MS) / 1000)),
  );
  let readIndex = 0;
  let writeIndex = 0;
  let queuedFrameCount = 0;
  let closed = false;

  const emitError = (): void => {
    for (const listener of errorListeners) {
      listener();
    }
  };

  const copyFromRing = (target: Float32Array, ring: Float32Array, frameCount: number): void => {
    const firstLength = Math.min(frameCount, capacity - readIndex);
    target.set(ring.subarray(readIndex, readIndex + firstLength), 0);
    if (firstLength < frameCount) {
      target.set(ring.subarray(0, frameCount - firstLength), firstLength);
    }
  };

  node.onaudioprocess = (event) => {
    const outputLeft = event.outputBuffer.getChannelData(0);
    const outputRight = channels > 1 ? event.outputBuffer.getChannelData(1) : outputLeft;
    const outputFrames = Math.min(outputLeft.length, outputRight.length);
    const readableFrames = closed ? 0 : Math.min(outputFrames, queuedFrameCount);
    try {
      if (readableFrames > 0) {
        copyFromRing(outputLeft, leftRing, readableFrames);
        if (channels > 1) {
          copyFromRing(outputRight, rightRing, readableFrames);
        }
        readIndex = (readIndex + readableFrames) % capacity;
        queuedFrameCount -= readableFrames;
      }
      if (readableFrames < outputFrames) {
        outputLeft.fill(0, readableFrames);
        if (channels > 1) {
          outputRight.fill(0, readableFrames);
        }
      }
    } catch {
      outputLeft.fill(0);
      if (channels > 1) {
        outputRight.fill(0);
      }
      emitError();
    }
  };
  node.connect(context.destination);

  const writePcm = (chunk: Uint8Array): boolean => {
    if (closed || chunk.byteLength <= 0) {
      return true;
    }
    const bytesPerFrame = channels * 2;
    const frameCount = Math.floor(chunk.byteLength / bytesPerFrame);
    if (frameCount <= 0) {
      return true;
    }
    // The producer observes a 64 ms high-water mark while the ring holds at least 250 ms, so a normal write cannot
    // overflow. Refuse an anomalously large write rather than overwrite audio which has not played yet.
    if (frameCount > capacity - queuedFrameCount) {
      emitError();
      return false;
    }
    try {
      const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, frameCount * channels);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const targetIndex = (writeIndex + frame) % capacity;
        const sourceIndex = frame * channels;
        leftRing[targetIndex] = pcm[sourceIndex]! / 32768;
        rightRing[targetIndex] = channels > 1 ? pcm[sourceIndex + 1]! / 32768 : leftRing[targetIndex]!;
      }
      writeIndex = (writeIndex + frameCount) % capacity;
      queuedFrameCount += frameCount;
      return queuedFrameCount <= highWaterFrames;
    } catch {
      emitError();
      return false;
    }
  };

  const closeContext = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    queuedFrameCount = 0;
    node.onaudioprocess = null;
    errorListeners.clear();
    try {
      node.disconnect?.();
    } catch {
      // noop
    }
    await closeContextSafely(context);
  };

  return {
    runtime: 'node',
    engine: 'webaudio',
    label: 'node-webaudio-script-stream',
    write: writePcm,
    // Keep Bun on the Int16 boundary already proven to work with its N-API Web Audio implementation. The persistent
    // ring still removes all per-chunk native AudioBuffer and AudioBufferSourceNode allocations.
    writeFloat32: undefined,
    waitWritable: async (shouldStop: () => boolean) => {
      while (!shouldStop() && !closed && queuedFrameCount > lowWaterFrames) {
        await delay(1);
      }
    },
    end: async () => {
      while (!closed && queuedFrameCount > 0) {
        await delay(1);
      }
      await closeContext();
    },
    destroy: () => {
      void closeContext();
    },
    onError: (listener: () => void) => {
      errorListeners.add(listener);
    },
    getClockState: () => {
      const outputSeconds = Math.max(0, context.currentTime);
      return {
        outputSeconds,
        scheduledSeconds: outputSeconds + queuedFrameCount / options.sampleRate,
      };
    },
    suspend: async () => {
      if (closed) {
        return;
      }
      try {
        await context.suspend?.();
      } catch {
        emitError();
      }
    },
    resume: async () => {
      if (closed) {
        return;
      }
      try {
        await context.resume?.();
      } catch {
        emitError();
      }
    },
  };
}

function resolveScriptProcessorBufferSize(requestedFrames: number): number {
  const validSizes = [256, 512, 1_024, 2_048, 4_096, 8_192, 16_384] as const;
  const safeRequested = Number.isFinite(requestedFrames) ? Math.max(256, Math.floor(requestedFrames)) : 1_024;
  return validSizes.find((size) => size >= safeRequested) ?? 16_384;
}

async function createNodeWebAudioStreamSink(
  context: WebAudioContextLike,
  AudioWorkletNode: NodeWebAudioWorkletNodeConstructor,
  options: AudioSinkCreateOptions,
): Promise<AudioSink> {
  const moduleUrl = URL.createObjectURL(new Blob([NODE_AUDIO_STREAM_PROCESSOR_SOURCE], { type: 'text/javascript' }));
  try {
    await context.audioWorklet!.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  const capacity = Math.max(2_048, Math.ceil(options.sampleRate * WEBAUDIO_STREAM_RING_SECONDS));
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3));
  const samples = new Float32Array(new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity * 2));
  const node = new AudioWorkletNode(context, NODE_AUDIO_STREAM_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      stateBuffer: state.buffer,
      sampleBuffer: samples.buffer,
      capacity,
    },
  });
  node.connect(context.destination);

  const errorListeners = new Set<() => void>();
  const highWaterFrames = Math.max(256, Math.ceil((options.sampleRate * WEBAUDIO_HIGH_WATER_MS) / 1000));
  const lowWaterFrames = Math.max(
    128,
    Math.min(highWaterFrames - 1, Math.ceil((options.sampleRate * WEBAUDIO_LOW_WATER_MS) / 1000)),
  );
  let closed = false;

  const queuedFrames = (): number => {
    const writeIndex = Atomics.load(state, 0);
    const readIndex = Atomics.load(state, 1);
    return writeIndex >= readIndex ? writeIndex - readIndex : capacity - readIndex + writeIndex;
  };

  const emitError = (): void => {
    for (const listener of errorListeners) {
      listener();
    }
  };

  const writeFloat32 = (left: Float32Array, right: Float32Array, requestedFrameCount?: number): boolean => {
    if (closed) {
      return true;
    }
    const availableFrames = Math.min(left.length, right.length);
    const requestedFrames =
      typeof requestedFrameCount === 'number' && Number.isFinite(requestedFrameCount)
        ? Math.min(availableFrames, Math.max(0, Math.floor(requestedFrameCount)))
        : availableFrames;
    const writableFrames = Math.min(requestedFrames, capacity - queuedFrames() - 1);
    if (writableFrames <= 0) {
      emitError();
      return false;
    }
    let writeIndex = Atomics.load(state, 0);
    for (let frame = 0; frame < writableFrames; frame += 1) {
      samples[writeIndex] = left[frame]!;
      samples[capacity + writeIndex] = right[frame]!;
      writeIndex += 1;
      if (writeIndex === capacity) {
        writeIndex = 0;
      }
    }
    Atomics.store(state, 0, writeIndex);
    return writableFrames === requestedFrames && queuedFrames() <= highWaterFrames;
  };

  const closeContext = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    Atomics.store(state, 2, 1);
    errorListeners.clear();
    try {
      node.disconnect?.();
    } catch {
      // noop
    }
    await closeContextSafely(context);
  };

  return {
    runtime: 'node',
    engine: 'webaudio',
    label: 'node-webaudio-stream',
    write: (chunk: Uint8Array) => {
      const frameCount = Math.floor(chunk.byteLength / 4);
      if (frameCount <= 0) {
        return true;
      }
      const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, frameCount * 2);
      const left = new Float32Array(frameCount);
      const right = new Float32Array(frameCount);
      for (let frame = 0; frame < frameCount; frame += 1) {
        left[frame] = pcm[frame * 2]! / 32768;
        right[frame] = pcm[frame * 2 + 1]! / 32768;
      }
      return writeFloat32(left, right, frameCount);
    },
    writeFloat32,
    waitWritable: async (shouldStop: () => boolean) => {
      while (!shouldStop() && !closed && queuedFrames() > lowWaterFrames) {
        await delay(1);
      }
    },
    end: async () => {
      while (!closed && queuedFrames() > 0) {
        await delay(1);
      }
      await closeContext();
    },
    destroy: () => {
      void closeContext();
    },
    onError: (listener: () => void) => {
      errorListeners.add(listener);
    },
    getClockState: () => {
      const outputSeconds = Math.max(0, context.currentTime);
      return {
        outputSeconds,
        scheduledSeconds: outputSeconds + queuedFrames() / options.sampleRate,
      };
    },
    suspend: async () => {
      try {
        await context.suspend?.();
      } catch {
        emitError();
      }
    },
    resume: async () => {
      try {
        await context.resume?.();
      } catch {
        emitError();
      }
    },
  };
}

function createWebAudioSink(
  runtime: AudioRuntime,
  context: WebAudioContextLike,
  options: AudioSinkCreateOptions,
): AudioSink {
  const errorListeners = new Set<() => void>();
  const highWaterFrames = Math.max(256, Math.ceil((options.sampleRate * WEBAUDIO_HIGH_WATER_MS) / 1000));
  const lowWaterFrames = Math.max(
    128,
    Math.min(highWaterFrames - 1, Math.ceil((options.sampleRate * WEBAUDIO_LOW_WATER_MS) / 1000)),
  );
  let closed = false;
  let scheduledUntilSeconds = Math.max(0, context.currentTime);

  const emitError = (): void => {
    for (const listener of errorListeners) {
      listener();
    }
  };

  const scheduleBuffer = (buffer: WebAudioBufferLike, frameCount: number): boolean => {
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        try {
          source.disconnect?.();
        } catch {
          // Already disconnected or context closed — both terminal states for this node.
        }
      };
      const now = Math.max(0, context.currentTime);
      const startAt = Math.max(now, scheduledUntilSeconds);
      source.start(startAt);
      scheduledUntilSeconds = startAt + frameCount / options.sampleRate;
    } catch {
      emitError();
      return false;
    }
    return queuedFrames() <= highWaterFrames;
  };

  const queuedFrames = (): number => {
    if (closed) {
      return 0;
    }
    const now = Math.max(0, context.currentTime);
    return Math.max(0, Math.ceil((scheduledUntilSeconds - now) * options.sampleRate));
  };

  const closeContext = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // Drop the error-listener registry first so anything still holding the
    // sink alive (e.g. an upstream player loop) can't accidentally call into
    // a torn-down context. Listeners that already fired stay invoked; the
    // clear only affects re-entrant emits after the sink is closed.
    errorListeners.clear();
    try {
      await context.close?.();
    } catch {
      // noop
    }
  };

  return {
    runtime,
    engine: 'webaudio',
    label: runtime === 'node' ? 'node-webaudio-chunked' : 'browser-webaudio',
    write: (chunk: Uint8Array) => {
      if (closed || chunk.byteLength <= 0) {
        return true;
      }

      const channels = Math.max(1, options.channels);
      const bytesPerFrame = channels * 2;
      if (chunk.byteLength < bytesPerFrame) {
        return true;
      }
      const frameCount = Math.floor(chunk.byteLength / bytesPerFrame);
      if (frameCount <= 0) {
        return true;
      }

      try {
        const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, frameCount * channels);
        const buffer = context.createBuffer(channels, frameCount, options.sampleRate);
        for (let channel = 0; channel < channels; channel += 1) {
          const channelData = buffer.getChannelData(channel);
          let pcmIndex = channel;
          for (let frame = 0; frame < frameCount; frame += 1) {
            channelData[frame] = pcm[pcmIndex]! / 32768;
            pcmIndex += channels;
          }
        }
        return scheduleBuffer(buffer, frameCount);
      } catch {
        emitError();
        return false;
      }
    },
    writeFloat32:
      runtime === 'node' && 'Bun' in globalThis
        ? undefined
        : (left: Float32Array, right: Float32Array, requestedFrameCount?: number) => {
            if (closed) {
              return true;
            }
            const availableFrames = Math.min(left.length, right.length);
            const frameCount =
              typeof requestedFrameCount === 'number' && Number.isFinite(requestedFrameCount)
                ? Math.min(availableFrames, Math.max(0, Math.floor(requestedFrameCount)))
                : availableFrames;
            if (frameCount <= 0) {
              return true;
            }
            try {
              const buffer = context.createBuffer(2, frameCount, options.sampleRate);
              const leftFrames = left.subarray(0, frameCount);
              const rightFrames = right.subarray(0, frameCount);
              if (buffer.copyToChannel) {
                buffer.copyToChannel(leftFrames, 0);
                buffer.copyToChannel(rightFrames, 1);
              } else {
                buffer.getChannelData(0).set(leftFrames);
                buffer.getChannelData(1).set(rightFrames);
              }
              return scheduleBuffer(buffer, frameCount);
            } catch {
              emitError();
              return false;
            }
          },
    waitWritable: async (shouldStop: () => boolean) => {
      while (!shouldStop() && !closed && queuedFrames() > lowWaterFrames) {
        await delay(1);
      }
    },
    end: async () => {
      if (closed) {
        return;
      }
      while (!closed && queuedFrames() > 0) {
        await delay(1);
      }
      await closeContext();
    },
    destroy: () => {
      void closeContext();
    },
    onError: (listener: () => void) => {
      errorListeners.add(listener);
    },
    getClockState: () => {
      const outputSeconds = Math.max(0, context.currentTime);
      return {
        outputSeconds,
        scheduledSeconds: Math.max(outputSeconds, scheduledUntilSeconds),
      };
    },
    suspend: async () => {
      if (closed) {
        return;
      }
      try {
        await context.suspend?.();
      } catch {
        emitError();
      }
    },
    resume: async () => {
      if (closed) {
        return;
      }
      try {
        await context.resume?.();
      } catch {
        emitError();
      }
    },
  };
}

async function loadNodeWebAudioRuntime(signal?: AbortSignal): Promise<NodeWebAudioRuntime | undefined> {
  try {
    throwIfAborted(signal);
    // In a SEA binary the bare-specifier import always fails; the helper retries from a `node_modules`
    // directory next to the executable (or the working directory) before giving up.
    const imported = await loadOptionalNodeModule<NodeWebAudioModule>(
      'node-web-audio-api',
      () => import('node-web-audio-api') as Promise<NodeWebAudioModule>,
    );
    throwIfAborted(signal);
    if (!imported) {
      return undefined;
    }
    const AudioContext = imported.AudioContext ?? imported.default?.AudioContext ?? imported.default;
    if (typeof AudioContext !== 'function') {
      return undefined;
    }
    const AudioWorkletNode = imported.AudioWorkletNode ?? imported.default?.AudioWorkletNode;
    return {
      AudioContext: AudioContext as NodeWebAudioContextConstructor,
      AudioWorkletNode:
        typeof AudioWorkletNode === 'function' ? (AudioWorkletNode as NodeWebAudioWorkletNodeConstructor) : undefined,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return undefined;
  }
}

async function closeContextSafely(context: WebAudioContextLike): Promise<void> {
  try {
    await context.close?.();
  } catch {
    // noop
  }
}
