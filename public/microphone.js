import { socketUrl } from './ui.js';

export class Microphone {
  constructor(change, report) {
    this.change = change;
    this.report = report;
    this.phase = 'idle';
  }
  setPhase(phase) {
    this.phase = phase;
    this.change();
  }
  async start({ mode = 'debate', deviceId = '' } = {}) {
    if (this.phase !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)
      throw new Error('收音请在后台电脑上打开 localhost 控台，或通过 HTTPS 访问');
    this.queue = [];
    this.input = null;
    this.ready = this.flushed = this.sentEnd = false;
    this.receivedMs = this.sentMs = this.nextSend = this.lastMeter = 0;
    this.levelDb = -96;
    this.setPhase('connecting');
    try {
      this.context = new AudioContext();
      await this.context.resume();
      await this.context.audioWorklet.addModule('/static/pcm-worklet.js');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'pcm-16k', {
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      this.silent = this.context.createGain();
      this.silent.gain.value = 0;
      this.node.connect(this.silent).connect(this.context.destination);
      this.node.port.onmessage = ({ data }) => {
        if (data === 'flushed') this.flushed = true;
        else {
          const samples = new Int16Array(data);
          let power = 0;
          for (const s of samples) power += (s / 32768) ** 2;
          this.levelDb = Math.max(-96, Math.round(10 * Math.log10(power / samples.length || 1e-10)));
          this.receivedMs += data.byteLength / 32;
          this.queue.push(data);
        }
        if (this.receivedMs - this.sentMs > 15000)
          return this.fail('连接延迟已超 15 秒，请核对最后定稿后重新收音');
        this.pump();
        if (performance.now() - this.lastMeter > 250) {
          this.lastMeter = performance.now();
          this.change();
        }
      };
      this.source.connect(this.node);
      this.setPhase('buffering');
      const url = new URL(socketUrl('mic'));
      url.searchParams.set('mode', mode);
      const ws = (this.ws = new WebSocket(url));
      const track = this.stream.getAudioTracks()[0];
      this.input = { label: track.label || '默认麦克风', rate: this.context.sampleRate };
      ws.onopen = () => ws.send(JSON.stringify({ type: 'input', ...this.input }));
      track.onended = () => this.stop();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'ready') {
          this.ready = true;
          if (this.phase !== 'draining') this.setPhase('recording');
          this.pump();
        } else if (m.type === 'error') this.fail(m.message);
        else if (m.type === 'ended') this.release();
      };
      ws.onerror = () => this.fail('收音连接失败，请检查后台连接');
      ws.onclose = () => {
        if (this.phase !== 'idle') this.fail('收音连接已断开，请核对最后一段定稿');
      };
    } catch (e) {
      this.release();
      if (e.name === 'NotAllowedError') throw new Error('麦克风权限未开启，请在浏览器中允许本页使用麦克风');
      if (e.name === 'NotFoundError') throw new Error('没有检测到麦克风，请连接会场音频设备');
      throw e;
    }
  }
  pump() {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN || this.timer || this.sentEnd) return;
    const packet = this.queue[0];
    if (!packet) {
      if (this.flushed) {
        this.ws.send('{"type":"end"}');
        this.sentEnd = true;
      }
      return;
    }
    if (this.ws.bufferedAmount > 64000) return this.fail('控台网络拥堵，收音已停止，请核对最后定稿');
    const wait = this.nextSend - performance.now();
    if (wait > 2) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    this.queue.shift();
    this.ws.send(packet);
    const duration = packet.byteLength / 32;
    this.sentMs += duration;
    this.nextSend = Math.max(this.nextSend, performance.now() - 2) + duration;
    this.pump();
  }
  stop() {
    if (!['buffering', 'recording'].includes(this.phase)) return;
    this.setPhase('draining');
    this.source.disconnect();
    this.node.port.postMessage('flush');
    this.stream.getTracks().forEach((t) => t.stop());
    this.drainTimer = setTimeout(() => this.fail('等待结束确认超时，请核对最后一段定稿'), 33000);
  }
  fail(message) {
    this.report(message);
    this.release();
  }
  release() {
    clearTimeout(this.timer);
    clearTimeout(this.drainTimer);
    this.timer = null;
    this.ready = false;
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      if (this.ws.readyState < 2) this.ws.close();
    }
    if (this.node) this.node.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.context?.close().catch(() => {});
    this.stream = this.context = this.ws = this.node = this.source = this.silent = null;
    this.queue = [];
    this.setPhase('idle');
  }
}
