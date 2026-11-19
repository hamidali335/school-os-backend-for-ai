/**
 * Audio helpers for AI calls: 16-bit mono PCM, sample-rate conversion between WebRTC's 48 kHz
 * (Opus) and the 16 kHz speech engines use, WAV encoding/decoding, and an energy-based voice
 * activity detector that turns the parent's audio into utterances. Audio only ever lives in
 * memory for one turn; it is never written to disk or stored.
 */

export const OPUS_RATE = 48_000;
export const SPEECH_RATE = 16_000;
/** 20 ms frames, the WebRTC/Opus norm. */
export const FRAME_MS = 20;

/** Linear-interpolation resampler (adequate for speech; both directions). */
export function resample(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return input;
  const outLength = Math.floor((input.length * to) / from);
  const out = new Int16Array(outLength);
  const ratio = from / to;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

export function pcmFromBuffer(buf: Buffer): Int16Array {
  const copy = Buffer.from(buf); // aligned copy
  return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2));
}

export function bufferFromPcm(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** RIFF/WAVE container for 16-bit mono PCM (what speech-to-text servers accept). */
export function encodeWav(pcm: Int16Array, rate: number): Buffer {
  const data = bufferFromPcm(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * 16-bit PCM WAV (as TTS servers return) to mono samples and rate. Other formats are rejected so
 * a misconfigured engine fails clearly instead of playing noise.
 */
export function decodeWav(buf: Buffer): { pcm: Int16Array; rate: number } {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Not a WAV file');
  let offset = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  let format = 1;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
      const end = Math.min(buf.length, body + (size || buf.length - body));
      const all = pcmFromBuffer(buf.subarray(body, end));
      if (channels === 1) return { pcm: all, rate };
      const mono = new Int16Array(Math.floor(all.length / channels));
      for (let i = 0; i < mono.length; i++) mono[i] = all[i * channels];
      return { pcm: mono, rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

function rms(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export interface VadOptions {
  /** Silence after speech that ends an utterance. */
  endSilenceMs?: number;
  /** Shorter sounds are noise (a cough, a click). */
  minSpeechMs?: number;
  /** An utterance is cut here even without a pause. */
  maxUtteranceMs?: number;
  /** Frames this much louder than the noise floor count as speech. */
  ratio?: number;
  /** Absolute minimum level for speech (16-bit RMS). */
  minLevel?: number;
}

/**
 * Energy-based voice activity detection on 16 kHz frames. It adapts to the line's noise floor,
 * reports when speech starts (for barge-in) and emits each finished utterance.
 */
export class VoiceActivityDetector {
  private noise = 200;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private chunks: Int16Array[] = [];
  private lastFrameAt = 0;
  private readonly o: Required<VadOptions>;

  constructor(
    private readonly onUtterance: (pcm: Int16Array) => void,
    private readonly onSpeechStart: () => void = () => undefined,
    options: VadOptions = {},
  ) {
    this.o = { endSilenceMs: 800, minSpeechMs: 250, maxUtteranceMs: 15_000, ratio: 3, minLevel: 500, ...options };
  }

  /** Feed one frame of 16 kHz PCM (any length; 20 ms frames are typical). */
  push(frame: Int16Array) {
    this.lastFrameAt = Date.now();
    const ms = (frame.length / SPEECH_RATE) * 1000;
    const level = rms(frame);
    const voiced = level > Math.max(this.o.minLevel, this.noise * this.o.ratio);
    if (!voiced && !this.speaking) this.noise = this.noise * 0.95 + level * 0.05; // track the floor
    if (voiced) {
      if (!this.speaking) {
        this.speaking = true;
        this.speechMs = 0;
        this.chunks = [];
        this.onSpeechStart();
      }
      this.silenceMs = 0;
      this.speechMs += ms;
      this.chunks.push(frame);
    } else if (this.speaking) {
      this.silenceMs += ms;
      this.chunks.push(frame);
      if (this.silenceMs >= this.o.endSilenceMs) this.finish();
    }
    if (this.speaking && this.speechMs + this.silenceMs >= this.o.maxUtteranceMs) this.finish();
  }

  /**
   * Ends an utterance when audio stops arriving (a phone may send nothing during silence).
   * Call it periodically.
   */
  checkIdle(now = Date.now()) {
    if (this.speaking && now - this.lastFrameAt >= this.o.endSilenceMs) this.finish();
  }

  /** Discard anything in progress (the AI is speaking and the echo should not count). */
  reset() {
    this.speaking = false;
    this.chunks = [];
    this.speechMs = 0;
    this.silenceMs = 0;
  }

  private finish() {
    const enough = this.speechMs >= this.o.minSpeechMs;
    const chunks = this.chunks;
    this.reset();
    if (!enough) return;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let at = 0;
    for (const c of chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    this.onUtterance(pcm);
  }
}
