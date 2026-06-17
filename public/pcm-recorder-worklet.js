// AudioWorklet: captures mic audio and emits 16-bit PCM little-endian frames.
// The AudioContext is created at 24kHz, so `sampleRate` here is 24000 and no
// resampling is needed before sending to OpenAI Realtime (PCM16 @ 24k).
//
// Render quanta (128 samples) are coalesced into ~50ms frames to keep the
// number of postMessage / input_audio_buffer.append messages sane.

class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = []
    this._target = 1200 // ~50ms at 24kHz
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i++) this._buf.push(channel[i])
      if (this._buf.length >= this._target) {
        const samples = this._buf
        this._buf = []
        const pcm = new Int16Array(samples.length)
        for (let i = 0; i < samples.length; i++) {
          let s = samples[i]
          if (s > 1) s = 1
          else if (s < -1) s = -1
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer])
      }
    }
    return true
  }
}

registerProcessor("pcm-recorder", PCMRecorder)
