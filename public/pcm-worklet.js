// Average each source interval into a 16 kHz sample, including fractional boundaries.
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.left = this.ratio;
    this.sum = 0;
    this.packet = new Int16Array(640);
    this.position = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        const covered = this.ratio - this.left;
        if (covered > 1e-8) {
          const v = Math.max(-1, Math.min(1, this.sum / covered));
          this.packet[this.position++] = Math.round(v * (v < 0 ? 32768 : 32767));
        }
        if (this.position) this.port.postMessage(this.packet.slice(0, this.position).buffer);
        this.position = 0;
        this.stopped = true;
        this.port.postMessage('flushed');
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      let width = 1;
      while (width > 1e-8) {
        const take = Math.min(width, this.left);
        this.sum += sample * take;
        this.left -= take;
        width -= take;
        if (this.left > 1e-8) continue;
        const v = Math.max(-1, Math.min(1, this.sum / this.ratio));
        this.packet[this.position++] = Math.round(v * (v < 0 ? 32768 : 32767));
        this.sum = 0;
        this.left = this.ratio;
        if (this.position === this.packet.length) {
          this.port.postMessage(this.packet.buffer, [this.packet.buffer]);
          this.packet = new Int16Array(640);
          this.position = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-16k', Pcm16k);
