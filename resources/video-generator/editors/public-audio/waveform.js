/**
 * 波形表示モジュール
 * Web Audio API でMP3をデコードし、Canvas に波形を描画する
 */

class WaveformViewer {
  constructor(canvas, audioUrl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.audioUrl = audioUrl;
    this.audioBuffer = null;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.sourceNode = null;
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.duration = 0;
    this.cursorPosition = 0; // 0-1
    this.silences = []; // { startSec, endSec, durationMs }
    this.onPositionChange = null;
    this.animFrameId = null;
  }

  async load() {
    const response = await fetch(this.audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    this.duration = this.audioBuffer.duration;
    this.detectSilences();
    this.draw();
  }

  detectSilences() {
    if (!this.audioBuffer) return;
    const data = this.audioBuffer.getChannelData(0);
    const sampleRate = this.audioBuffer.sampleRate;
    const windowSize = Math.floor(sampleRate * 0.02); // 20ms windows
    const threshold = 0.01;
    const minSilenceMs = 150;

    this.silences = [];
    let silenceStart = -1;

    for (let i = 0; i < data.length; i += windowSize) {
      let rms = 0;
      const end = Math.min(i + windowSize, data.length);
      for (let j = i; j < end; j++) {
        rms += data[j] * data[j];
      }
      rms = Math.sqrt(rms / (end - i));

      if (rms < threshold) {
        if (silenceStart === -1) silenceStart = i;
      } else {
        if (silenceStart !== -1) {
          const startSec = silenceStart / sampleRate;
          const endSec = i / sampleRate;
          const durationMs = (endSec - startSec) * 1000;
          if (durationMs >= minSilenceMs) {
            this.silences.push({ startSec, endSec, durationMs: Math.round(durationMs) });
          }
          silenceStart = -1;
        }
      }
    }
  }

  draw() {
    if (!this.audioBuffer) return;

    const { width, height } = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.scale(dpr, dpr);
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;

    this.ctx.fillStyle = "#222244";
    this.ctx.fillRect(0, 0, cw, ch);

    // 無音区間をハイライト
    for (const s of this.silences) {
      const x1 = (s.startSec / this.duration) * cw;
      const x2 = (s.endSec / this.duration) * cw;
      this.ctx.fillStyle = "rgba(233, 69, 96, 0.15)";
      this.ctx.fillRect(x1, 0, x2 - x1, ch);
    }

    // 波形を描画
    const data = this.audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / cw);
    const mid = ch / 2;

    this.ctx.strokeStyle = "#1a6fb5";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();

    for (let i = 0; i < cw; i++) {
      let min = 1, max = -1;
      const start = Math.floor(i * step);
      const end = Math.min(start + step, data.length);
      for (let j = start; j < end; j++) {
        if (data[j] < min) min = data[j];
        if (data[j] > max) max = data[j];
      }
      this.ctx.moveTo(i, mid + min * mid * 0.9);
      this.ctx.lineTo(i, mid + max * mid * 0.9);
    }
    this.ctx.stroke();

    // カーソル
    if (this.cursorPosition >= 0) {
      const cx = this.cursorPosition * cw;
      this.ctx.strokeStyle = "#e94560";
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, 0);
      this.ctx.lineTo(cx, ch);
      this.ctx.stroke();
    }
  }

  play() {
    if (this.isPlaying) this.stop();
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.audioContext.destination);
    this.sourceNode.start(0, this.pauseOffset);
    this.startTime = this.audioContext.currentTime - this.pauseOffset;
    this.isPlaying = true;
    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pauseOffset = 0;
        this.cursorPosition = 0;
        this.draw();
      }
    };
    this._animate();
  }

  stop() {
    if (this.sourceNode) {
      this.sourceNode.onended = null;
      try { this.sourceNode.stop(); } catch {}
    }
    if (this.isPlaying) {
      this.pauseOffset = this.audioContext.currentTime - this.startTime;
    }
    this.isPlaying = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
  }

  seekTo(fraction) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.stop();
    this.pauseOffset = fraction * this.duration;
    this.cursorPosition = fraction;
    this.draw();
    if (wasPlaying) this.play();
    if (this.onPositionChange) {
      this.onPositionChange(this.pauseOffset, this.duration);
    }
  }

  getCurrentTime() {
    if (this.isPlaying) {
      return this.audioContext.currentTime - this.startTime;
    }
    return this.pauseOffset;
  }

  _animate() {
    if (!this.isPlaying) return;
    const currentTime = this.audioContext.currentTime - this.startTime;
    this.cursorPosition = Math.min(currentTime / this.duration, 1);
    this.draw();
    if (this.onPositionChange) {
      this.onPositionChange(currentTime, this.duration);
    }
    this.animFrameId = requestAnimationFrame(() => this._animate());
  }
}

window.WaveformViewer = WaveformViewer;
