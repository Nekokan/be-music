import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createBrowserAudioSink,
  createNodeAudioSink,
  type WebAudioBufferLike,
  type WebAudioContextLike,
} from './audio-sink.ts';

const { loadOptionalNodeModuleMock } = vi.hoisted(() => ({
  loadOptionalNodeModuleMock: vi.fn(),
}));

vi.mock('@be-music/utils/optional-node-module', () => ({
  loadOptionalNodeModule: loadOptionalNodeModuleMock,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMockContext(currentTimeRef: { value: number }) {
  const starts: number[] = [];
  const buffers: Float32Array[][] = [];
  const suspend = vi.fn(async () => undefined);
  const resume = vi.fn(async () => undefined);

  const context: WebAudioContextLike = {
    get currentTime() {
      return currentTimeRef.value;
    },
    destination: {},
    createBuffer: (channels: number, length: number) => {
      const channelData = Array.from({ length: channels }, () => new Float32Array(length));
      buffers.push(channelData);
      return {
        getChannelData: (channel: number) => channelData[channel]!,
        copyToChannel: (source: Float32Array, channel: number) => channelData[channel]!.set(source),
      };
    },
    createBufferSource: () => ({
      buffer: null,
      connect: () => undefined,
      start: (when = 0) => {
        starts.push(when);
      },
    }),
    suspend,
    resume,
  };

  return {
    context,
    starts,
    buffers,
    suspend,
    resume,
  };
}

describe('audio-sink', () => {
  test('tracks output and scheduled clock state across buffered writes', () => {
    const currentTimeRef = { value: 1.25 };
    const { context, starts } = createMockContext(currentTimeRef);
    const sink = createBrowserAudioSink(context, {
      sampleRate: 1_000,
      channels: 2,
      samplesPerFrame: 256,
      mode: 'manual',
    });

    expect(sink.getClockState()).toEqual({
      outputSeconds: 1.25,
      scheduledSeconds: 1.25,
    });

    const chunk = new Uint8Array(new Int16Array(8).buffer);
    sink.write(chunk);

    expect(starts).toEqual([1.25]);
    expect(sink.getClockState()).toEqual({
      outputSeconds: 1.25,
      scheduledSeconds: 1.254,
    });

    currentTimeRef.value = 1.252;
    expect(sink.getClockState()).toEqual({
      outputSeconds: 1.252,
      scheduledSeconds: 1.254,
    });

    currentTimeRef.value = 1.3;
    expect(sink.getClockState()).toEqual({
      outputSeconds: 1.3,
      scheduledSeconds: 1.3,
    });
  });

  test('forwards suspend and resume to the audio context', async () => {
    const currentTimeRef = { value: 0 };
    const { context, suspend, resume } = createMockContext(currentTimeRef);
    const sink = createBrowserAudioSink(context, {
      sampleRate: 44_100,
      channels: 2,
      samplesPerFrame: 256,
      mode: 'auto',
    });

    await sink.suspend();
    await sink.resume();

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test('writes mixed float channels without an Int16 round trip', () => {
    const currentTimeRef = { value: 0 };
    const { context, buffers } = createMockContext(currentTimeRef);
    const sink = createBrowserAudioSink(context, {
      sampleRate: 1_000,
      channels: 2,
      samplesPerFrame: 256,
      mode: 'auto',
    });

    sink.writeFloat32?.(new Float32Array([0.25, -0.5, 0.75]), new Float32Array([-0.25, 0.5, -0.75]), 2);

    expect([...buffers[0]![0]!]).toEqual([0.25, -0.5]);
    expect([...buffers[0]![1]!]).toEqual([-0.25, 0.5]);
    expect(sink.getClockState().scheduledSeconds).toBeCloseTo(0.002);
  });

  test('uses one AudioWorklet node backed by a shared PCM ring for Node output', async () => {
    let processorOptions: Record<string, unknown> | undefined;
    const addModule = vi.fn(async () => undefined);
    const disconnect = vi.fn();
    const close = vi.fn(async () => undefined);

    class MockAudioContext {
      currentTime = 1;
      destination = {};
      audioWorklet = { addModule };
      createBuffer = vi.fn();
      createBufferSource = vi.fn();
      close = close;
    }

    class MockAudioWorkletNode {
      constructor(_context: unknown, _name: string, options: { processorOptions: Record<string, unknown> }) {
        processorOptions = options.processorOptions;
      }
      connect = vi.fn();
      disconnect = disconnect;
    }

    loadOptionalNodeModuleMock.mockResolvedValueOnce({
      AudioContext: MockAudioContext,
      AudioWorkletNode: MockAudioWorkletNode,
    });
    const sink = await createNodeAudioSink({
      sampleRate: 1_000,
      channels: 2,
      samplesPerFrame: 256,
      mode: 'auto',
    });

    expect(sink?.label).toBe('node-webaudio-stream');
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(processorOptions).toBeDefined();
    const state = new Int32Array(processorOptions!.stateBuffer as SharedArrayBuffer);
    const samples = new Float32Array(processorOptions!.sampleBuffer as SharedArrayBuffer);
    const capacity = processorOptions!.capacity as number;

    expect(sink?.writeFloat32?.(new Float32Array([0.25, 0.5]), new Float32Array([-0.25, -0.5]), 2)).toBe(true);
    expect(Atomics.load(state, 0)).toBe(2);
    expect([...samples.subarray(0, 2)]).toEqual([0.25, 0.5]);
    expect([...samples.subarray(capacity, capacity + 2)]).toEqual([-0.25, -0.5]);
    expect(sink?.getClockState()).toEqual({ outputSeconds: 1, scheduledSeconds: 1.002 });

    sink?.destroy();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test('schedules legacy Node Float32 chunks without retaining a pending batch', async () => {
    const currentTimeRef = { value: 0 };
    const mock = createMockContext(currentTimeRef);

    class MockAudioContext {
      get currentTime() {
        return mock.context.currentTime;
      }
      destination = mock.context.destination;
      createBuffer = mock.context.createBuffer;
      createBufferSource = mock.context.createBufferSource;
      close = vi.fn(async () => undefined);
    }

    loadOptionalNodeModuleMock.mockResolvedValueOnce({ AudioContext: MockAudioContext });
    const sink = await createNodeAudioSink({
      sampleRate: 44_100,
      channels: 2,
      samplesPerFrame: 256,
      mode: 'manual',
    });
    const left = new Float32Array(256).fill(0.25);
    const right = new Float32Array(256).fill(-0.25);

    sink?.writeFloat32?.(left, right);
    expect(sink?.label).toBe('node-webaudio-chunked');
    expect(mock.starts).toHaveLength(1);
    expect(mock.buffers[0]![0]).toHaveLength(256);
    expect(mock.buffers[0]![0]![0]).toBe(0.25);
    expect(mock.buffers[0]![1]![255]).toBe(-0.25);
    sink?.destroy();
  });

  test('keeps Bun on the proven self-contained Int16 buffer path', async () => {
    vi.stubGlobal('Bun', {});
    const currentTimeRef = { value: 0 };
    const mock = createMockContext(currentTimeRef);

    class MockAudioContext {
      get currentTime() {
        return mock.context.currentTime;
      }
      destination = mock.context.destination;
      createBuffer = mock.context.createBuffer;
      createBufferSource = mock.context.createBufferSource;
      close = vi.fn(async () => undefined);
    }

    loadOptionalNodeModuleMock.mockResolvedValueOnce({ AudioContext: MockAudioContext });
    const sink = await createNodeAudioSink({
      sampleRate: 44_100,
      channels: 2,
      samplesPerFrame: 256,
      mode: 'manual',
    });
    const pcm = new Int16Array(256 * 2);
    pcm[0] = 8_192;
    pcm[1] = -8_192;
    const chunk = new Uint8Array(pcm.buffer);

    expect(sink?.writeFloat32).toBeUndefined();
    sink?.write(chunk);

    expect(mock.starts).toHaveLength(1);
    expect(mock.buffers[0]![0]![0]).toBe(0.25);
    expect(mock.buffers[0]![1]![0]).toBe(-0.25);
    sink?.destroy();
  });

  test('uses one persistent ScriptProcessor stream for Bun when available', async () => {
    vi.stubGlobal('Bun', {});
    const currentTimeRef = { value: 2 };
    let processor:
      | {
          connect: ReturnType<typeof vi.fn>;
          disconnect: ReturnType<typeof vi.fn>;
          onaudioprocess: ((event: { outputBuffer: WebAudioBufferLike }) => void) | null;
        }
      | undefined;
    const close = vi.fn(async () => undefined);
    const createBufferSource = vi.fn();

    class MockAudioContext {
      get currentTime() {
        return currentTimeRef.value;
      }
      destination = {};
      createBuffer = vi.fn();
      createBufferSource = createBufferSource;
      createScriptProcessor = vi.fn(() => {
        processor = {
          connect: vi.fn(),
          disconnect: vi.fn(),
          onaudioprocess: null,
        };
        return processor;
      });
      close = close;
    }

    loadOptionalNodeModuleMock.mockResolvedValueOnce({ AudioContext: MockAudioContext });
    const sink = await createNodeAudioSink({
      sampleRate: 44_100,
      channels: 2,
      samplesPerFrame: 1_024,
      mode: 'manual',
    });
    const pcm = new Int16Array(1_024 * 2);
    pcm[0] = 8_192;
    pcm[1] = -8_192;

    expect(sink?.label).toBe('node-webaudio-script-stream');
    expect(sink?.writeFloat32).toBeUndefined();
    expect(sink?.write(new Uint8Array(pcm.buffer))).toBe(true);
    expect(createBufferSource).not.toHaveBeenCalled();
    expect(sink?.getClockState().scheduledSeconds).toBeCloseTo(2 + 1_024 / 44_100);

    const outputChannels = [new Float32Array(1_024), new Float32Array(1_024)];
    processor?.onaudioprocess?.({
      outputBuffer: {
        getChannelData: (channel) => outputChannels[channel]!,
      },
    });
    expect(outputChannels[0]![0]).toBe(0.25);
    expect(outputChannels[1]![0]).toBe(-0.25);
    expect(sink?.getClockState().scheduledSeconds).toBe(2);

    sink?.destroy();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(processor?.disconnect).toHaveBeenCalledTimes(1);
  });
});
