import { env } from '../../config/env';
import { decodeWav, encodeWav, resample, SPEECH_RATE } from './audio';

/**
 * Replaceable speech engines for AI calls (docs/AI_VOICE_CALLS.md). The conversation logic
 * talks only to these interfaces; each implementation is configured by URL, model and key on
 * the server (never in an app). Self-hosted servers are the primary target:
 * - speech-to-text: any OpenAI-compatible `/audio/transcriptions` server (faster-whisper /
 *   whisper.cpp servers, or a hosted API if you choose one);
 * - text-to-speech: an OpenAI-compatible `/audio/speech` server, or a plain HTTP endpoint that
 *   returns WAV (e.g. a small server around an Urdu MMS/VITS voice).
 */

export interface SpeechToText {
  readonly name: string;
  /** 16 kHz mono PCM of one utterance → text (empty when nothing intelligible was said). */
  transcribe(pcm: Int16Array, opts: { language: string; signal?: AbortSignal }): Promise<{ text: string }>;
}

export interface TextToSpeech {
  readonly name: string;
  /** Text → 16 kHz mono PCM. */
  synthesize(text: string, opts: { language: string; signal?: AbortSignal }): Promise<Int16Array>;
}

export class SpeechEngineError extends Error {
  constructor(
    message: string,
    readonly engine: 'stt' | 'tts',
    readonly kind: 'not_configured' | 'timeout' | 'http' | 'network' | 'invalid_response',
  ) {
    super(message);
  }
}

const headers = (key?: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});
const base = (url: string) => url.replace(/\/+$/, '');

async function request(engine: 'stt' | 'tts', url: string, init: RequestInit, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_CALL_PROVIDER_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok)
      throw new SpeechEngineError(`${engine.toUpperCase()} server answered HTTP ${res.status}`, engine, 'http');
    return res;
  } catch (err) {
    if (err instanceof SpeechEngineError) throw err;
    if (controller.signal.aborted && !signal?.aborted)
      throw new SpeechEngineError(`${engine.toUpperCase()} server did not answer in time`, engine, 'timeout');
    throw new SpeechEngineError(`${engine.toUpperCase()} server could not be reached`, engine, 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** OpenAI-compatible transcription (multipart WAV upload). */
export class OpenAiCompatibleStt implements SpeechToText {
  readonly name: string;
  constructor(private readonly cfg: { url: string; model: string; apiKey?: string }) {
    this.name = `openai_compatible:${cfg.model}`;
  }
  async transcribe(pcm: Int16Array, opts: { language: string; signal?: AbortSignal }) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(encodeWav(pcm, SPEECH_RATE))], { type: 'audio/wav' }),
      'utterance.wav',
    );
    form.append('model', this.cfg.model);
    form.append('language', opts.language);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await request(
      'stt',
      `${base(this.cfg.url)}/audio/transcriptions`,
      {
        method: 'POST',
        headers: headers(this.cfg.apiKey),
        body: form,
      },
      opts.signal,
    );
    const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (!body || typeof body.text !== 'string')
      throw new SpeechEngineError('STT answer has no text', 'stt', 'invalid_response');
    return { text: body.text.trim() };
  }
}

/** OpenAI-compatible speech synthesis, WAV response. */
export class OpenAiCompatibleTts implements TextToSpeech {
  readonly name: string;
  constructor(private readonly cfg: { url: string; model: string; voice: string; apiKey?: string }) {
    this.name = `openai_compatible:${cfg.model}`;
  }
  async synthesize(text: string, opts: { language: string; signal?: AbortSignal }) {
    const res = await request(
      'tts',
      `${base(this.cfg.url)}/audio/speech`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers(this.cfg.apiKey) },
        body: JSON.stringify({
          model: this.cfg.model,
          voice: this.cfg.voice,
          input: text,
          response_format: 'wav',
          language: opts.language,
        }),
      },
      opts.signal,
    );
    return toSpeechRate(Buffer.from(await res.arrayBuffer()));
  }
}

/** Plain HTTP TTS: POST {text, language, voice} → audio/wav (for self-hosted Urdu voices). */
export class HttpWavTts implements TextToSpeech {
  readonly name = 'http_wav';
  constructor(private readonly cfg: { url: string; voice?: string; apiKey?: string }) {}
  async synthesize(text: string, opts: { language: string; signal?: AbortSignal }) {
    const res = await request(
      'tts',
      this.cfg.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/wav', ...headers(this.cfg.apiKey) },
        body: JSON.stringify({ text, language: opts.language, ...(this.cfg.voice ? { voice: this.cfg.voice } : {}) }),
      },
      opts.signal,
    );
    return toSpeechRate(Buffer.from(await res.arrayBuffer()));
  }
}

function toSpeechRate(wav: Buffer): Int16Array {
  try {
    const { pcm, rate } = decodeWav(wav);
    return resample(pcm, rate, SPEECH_RATE);
  } catch (err) {
    throw new SpeechEngineError(
      `TTS answer is not 16-bit PCM WAV (${(err as Error).message})`,
      'tts',
      'invalid_response',
    );
  }
}

let sttOverride: SpeechToText | null = null;
let ttsOverride: TextToSpeech | null = null;
/** Tests only: substitute engines (the real ones need running servers). */
export function setSpeechEnginesForTests(engines: { stt?: SpeechToText | null; tts?: TextToSpeech | null }) {
  if ('stt' in engines) sttOverride = engines.stt ?? null;
  if ('tts' in engines) ttsOverride = engines.tts ?? null;
}

/** The configured speech-to-text engine, or null when none is configured. */
export function speechToText(): SpeechToText | null {
  if (sttOverride) return sttOverride;
  if (env.AI_CALL_STT_PROVIDER === 'openai_compatible' && env.AI_CALL_STT_URL)
    return new OpenAiCompatibleStt({
      url: env.AI_CALL_STT_URL,
      model: env.AI_CALL_STT_MODEL,
      apiKey: env.AI_CALL_STT_API_KEY,
    });
  return null;
}

/** The configured text-to-speech engine, or null when none is configured. */
export function textToSpeech(): TextToSpeech | null {
  if (ttsOverride) return ttsOverride;
  if (env.AI_CALL_TTS_PROVIDER === 'openai_compatible' && env.AI_CALL_TTS_URL)
    return new OpenAiCompatibleTts({
      url: env.AI_CALL_TTS_URL,
      model: env.AI_CALL_TTS_MODEL,
      voice: env.AI_CALL_TTS_VOICE,
      apiKey: env.AI_CALL_TTS_API_KEY,
    });
  if (env.AI_CALL_TTS_PROVIDER === 'http_wav' && env.AI_CALL_TTS_URL)
    return new HttpWavTts({
      url: env.AI_CALL_TTS_URL,
      voice: env.AI_CALL_TTS_VOICE || undefined,
      apiKey: env.AI_CALL_TTS_API_KEY,
    });
  return null;
}
