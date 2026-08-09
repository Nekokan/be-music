export const NODE_AUDIO_STREAM_PROCESSOR_NAME = 'be-music-pcm-stream';

export const NODE_AUDIO_STREAM_PROCESSOR_SOURCE = `
class BeMusicPcmStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions;
    this.state = new Int32Array(processorOptions.stateBuffer);
    this.samples = new Float32Array(processorOptions.sampleBuffer);
    this.capacity = processorOptions.capacity;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    let readIndex = Atomics.load(this.state, 1);
    const writeIndex = Atomics.load(this.state, 0);
    const available = writeIndex >= readIndex
      ? writeIndex - readIndex
      : this.capacity - readIndex + writeIndex;
    const frameCount = Math.min(left.length, available);

    for (let frame = 0; frame < frameCount; frame += 1) {
      left[frame] = this.samples[readIndex];
      right[frame] = this.samples[this.capacity + readIndex];
      readIndex += 1;
      if (readIndex === this.capacity) readIndex = 0;
    }
    for (let frame = frameCount; frame < left.length; frame += 1) {
      left[frame] = 0;
      right[frame] = 0;
    }
    Atomics.store(this.state, 1, readIndex);
    return Atomics.load(this.state, 2) === 0;
  }
}

registerProcessor('${NODE_AUDIO_STREAM_PROCESSOR_NAME}', BeMusicPcmStreamProcessor);
`;
