import crypto from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { SchoolContext, SystemContext } from '../../types/context';
import { oid } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { callAi } from '../ai/ai.service';
import { callHub, type CallEvent, type SignalingConnection } from '../calls/calls.hub';
import { iceServersFor } from '../calls/calls.ice';
import { finalize, markAiCallConnected, relaySignal, startAiCall } from '../calls/calls.service';
import { SPEECH_RATE, VoiceActivityDetector } from './audio';
import { AiConversation } from './ai-calls.model';
import { ConversationEngine, lines, summarize, type ConversationConfig, type Llm } from './conversation';
import { AiMediaPeer, type PeerSignal } from './media-peer';
import { SpeechEngineError, speechToText, textToSpeech, type SpeechToText, type TextToSpeech } from './speech';

/**
 * Runs one AI voice conversation end to end (docs/AI_VOICE_CALLS.md):
 *  ring the parent through the normal call flow → on answer, connect WebRTC media → speak the
 *  fixed disclosure and ask for consent → listen (voice activity) → speech-to-text →
 *  conversation engine (language model, no tools) → text-to-speech → speak → … → close.
 * Each agent owns its call, peer, timers and buffers; nothing is shared between conversations.
 * Raw audio exists only in memory for the current utterance and is never stored.
 */

const UNANSWERED_STATUSES = new Set(['missed', 'declined', 'cancelled', 'busy', 'unreachable']);
const LIVE_CALL = ['ringing', 'connecting', 'active'] as const;

/** Agents running on this instance, by conversation id (concurrency limits, cancellation). */
export const runningAgents = new Map<string, AiCallAgent>();

export function runningForSchool(schoolId: string) {
  let n = 0;
  for (const a of runningAgents.values()) if (a.schoolId === schoolId) n++;
  return n;
}

/** Fixed lines (disclosure, consent, goodbyes) are synthesized once per engine and language. */
const ttsCache = new Map<string, Int16Array>();
async function speak(tts: TextToSpeech, text: string, language: string, fixed: boolean, signal: AbortSignal) {
  const key = `${tts.name}|${language}|${text}`;
  const hit = fixed ? ttsCache.get(key) : undefined;
  if (hit) return hit;
  const pcm = await tts.synthesize(text, { language, signal });
  if (fixed) {
    if (ttsCache.size > 64) ttsCache.delete(ttsCache.keys().next().value!);
    ttsCache.set(key, pcm);
  }
  return pcm;
}

export class AiCallAgent {
  readonly schoolId: string;
  readonly conn: SignalingConnection;
  callId: string | null = null;
  private peer: AiMediaPeer | null = null;
  private vad: VoiceActivityDetector;
  private engine: ConversationEngine;
  private stt: SpeechToText;
  private tts: TextToSpeech;
  private readonly abort = new AbortController();
  private timers = new Set<NodeJS.Timeout>();
  private silenceTimer: NodeJS.Timeout | null = null;
  private reprompts = 0;
  private busy = false;
  private pendingUtterance: Int16Array | null = null;
  private transcript: Array<{ role: 'ai' | 'parent'; text: string; at: Date }> = [];
  private speechSeconds = 0;
  private ttsCharacters = 0;
  private turns = 0;
  private connected = false;
  private startedAt: Date | null = null;
  private stopping = false;
  private finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(
    readonly conversationId: string,
    private readonly ctx: SchoolContext,
    private readonly cfg: ConversationConfig,
    private readonly target: { studentId: string; parentId: string },
    engines: { stt: SpeechToText; tts: TextToSpeech; llm?: Llm },
  ) {
    this.schoolId = ctx.schoolId;
    this.stt = engines.stt;
    this.tts = engines.tts;
    const system: SystemContext = { kind: 'system', schoolId: ctx.schoolId, label: 'ai_voice_call' };
    const llm: Llm = engines.llm ?? ((req) => callAi(system, 'voice_conversation', req));
    this.engine = new ConversationEngine(cfg, llm);
    this.vad = new VoiceActivityDetector(
      (pcm) => this.onUtterance(pcm),
      () => this.onSpeechStart(),
    );
    this.conn = {
      id: crypto.randomBytes(24).toString('base64url'),
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      virtual: true,
      send: (e) => this.onCallEvent(e),
      close: () => void this.stop('failed', 'agent_closed'),
    };
    this.finished = new Promise((r) => (this.resolveFinished = r));
  }

  /** Resolves when the conversation is over and everything is released. */
  get done() {
    return this.finished;
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  /** Ring the parent. Returns the call's immediate result (ringing, busy or unreachable). */
  async start() {
    runningAgents.set(this.conversationId, this);
    callHub.add(this.conn);
    try {
      const { call } = await startAiCall(this.ctx, this.target.studentId, this.target.parentId, this.conn);
      this.callId = call.callId;
      if (call.status === 'ringing') {
        await this.update({ callId: call.callId, status: 'ringing' });
        // Safety net: the whole conversation can never outlive its limit (plus ringing).
        this.later(
          (env.CALL_RING_TIMEOUT_SECONDS + env.AI_CALL_MAX_MINUTES * 60 + 30) * 1000,
          () => void this.stop('failed', 'time_limit'),
        );
      } else {
        await this.update({ callId: call.callId });
        await this.stop('not_answered', call.status);
      }
      return call;
    } catch (err) {
      await this.stop('failed', 'call_not_started');
      throw err;
    }
  }

  private async update(set: Record<string, unknown>) {
    await AiConversation.updateOne({ _id: oid(this.conversationId), schoolId: oid(this.schoolId) }, { $set: set });
  }

  private onCallEvent(e: CallEvent) {
    if (this.stopping) return;
    const call = e.call as { callId?: string; status?: string } | undefined;
    if (e.type === 'call.updated' && call?.callId === this.callId) {
      if (call.status === 'connecting' && e.onThisDevice && !this.peer) void this.connectMedia();
      else if (call.status && !LIVE_CALL.includes(call.status as (typeof LIVE_CALL)[number])) {
        // The call ended on the other side (hang-up, lost connection, timeout).
        const notAnswered = !this.connected && UNANSWERED_STATUSES.has(call.status);
        void this.stop(
          notAnswered ? 'not_answered' : this.connected ? 'completed' : 'failed',
          notAnswered ? call.status : 'call_ended',
        );
      }
      return;
    }
    if (!('callId' in e) || e.callId !== this.callId) return;
    if (e.type === 'signal') void this.peer?.handle(e.signal as PeerSignal).catch(() => undefined);
    else if (e.type === 'call.peer_rejoined') void this.peer?.makeOffer(true).catch(() => undefined);
  }

  private async connectMedia() {
    const ice = iceServersFor(this.ctx);
    this.peer = new AiMediaPeer(
      ice.iceServers,
      (signal) => void relaySignal(this.conn, this.callId!, signal),
      (state) => {
        if (state === 'connected' && !this.connected) void this.onConnected();
        if (state === 'failed') void this.stop('failed', 'media_failed');
      },
      (pcm) => this.vad.push(pcm),
    );
    await this.peer.makeOffer();
  }

  private async onConnected() {
    this.connected = true;
    this.startedAt = new Date();
    await markAiCallConnected(this.schoolId, this.callId!);
    await this.update({ status: 'consent', startedAt: this.startedAt });
    const idle = setInterval(() => this.vad.checkIdle(), 100);
    idle.unref?.();
    this.timers.add(idle as unknown as NodeJS.Timeout);
    this.later(env.AI_CALL_MAX_MINUTES * 60_000, () => void this.say(lines(this.cfg.language).timeUp, true, true));
    await this.say(this.engine.opening(), true);
  }

  /** Speak; `end` hangs up afterwards. Never records the AI's audio, only (with consent) its text. */
  private async say(text: string, fixed: boolean, end = false) {
    if (!text || !this.peer || this.stopping) {
      if (end) await this.stop('completed', 'conversation_finished');
      return;
    }
    this.clearSilence();
    this.vad.reset();
    this.record('ai', text);
    try {
      const pcm = await speak(this.tts, text, this.cfg.language, fixed, this.abort.signal);
      this.ttsCharacters += text.length;
      await this.peer.play(pcm);
    } catch (err) {
      if (this.stopping) return;
      logger.warn({ engine: 'tts', kind: (err as SpeechEngineError).kind }, 'AI call speech synthesis failed');
      await this.stop('failed', 'tts_unavailable');
      return;
    }
    if (end) {
      await this.stop(this.engine.consent === 'given' ? 'completed' : 'no_consent', 'conversation_finished');
      return;
    }
    this.armSilence();
  }

  private record(role: 'ai' | 'parent', text: string) {
    // The transcript starts only after consent, and only when the school enabled it.
    if (!this.cfg.storeTranscript || this.engine.consent !== 'given') return;
    this.transcript.push({ role, text: text.slice(0, 2000), at: new Date() });
  }

  private armSilence() {
    this.clearSilence();
    this.silenceTimer = this.later(env.AI_CALL_SILENCE_SECONDS * 1000, () => {
      if (this.busy || this.stopping) return;
      if (this.reprompts++ >= 2) {
        void this.say(lines(this.cfg.language).goodbye, true, true);
        return;
      }
      void this.say(this.engine.reprompt(), false);
    });
  }

  private clearSilence() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.timers.delete(this.silenceTimer);
    }
    this.silenceTimer = null;
  }

  /** Barge-in: the parent started talking while the AI speaks. */
  private onSpeechStart() {
    this.clearSilence();
    if (this.peer?.speaking) this.peer.interrupt();
  }

  private onUtterance(pcm: Int16Array) {
    if (this.stopping || !this.connected) return;
    if (this.busy) {
      this.pendingUtterance = pcm; // keep only the latest
      return;
    }
    void this.handleUtterance(pcm);
  }

  private async handleUtterance(pcm: Int16Array) {
    this.busy = true;
    try {
      this.speechSeconds += pcm.length / SPEECH_RATE;
      let text = '';
      try {
        text = (await this.stt.transcribe(pcm, { language: this.cfg.language, signal: this.abort.signal })).text;
      } catch (err) {
        if (this.stopping) return;
        logger.warn({ engine: 'stt', kind: (err as SpeechEngineError).kind }, 'AI call speech recognition failed');
        await this.say(lines(this.cfg.language).trouble, true);
        await this.stop('failed', 'stt_unavailable');
        return;
      }
      if (!text.trim()) {
        this.armSilence();
        return;
      }
      this.reprompts = 0;
      this.turns++;
      const before = this.engine.consent;
      const turn = await this.engine.onParent(text);
      if (this.engine.consent === 'given' && before !== 'given') {
        // The record starts with the disclosure the parent heard and their consent.
        this.record('ai', this.engine.opening());
        await this.update({ status: 'in_progress', consent: 'given', consentAt: new Date() });
      }
      this.record('parent', text);
      if (turn.reason === 'llm_unavailable') {
        await this.say(turn.say, true);
        await this.stop('failed', 'llm_unavailable');
        return;
      }
      const outOfTurns = this.turns >= env.AI_CALL_MAX_TURNS;
      await this.say(
        outOfTurns && !turn.end ? lines(this.cfg.language).timeUp : turn.say,
        turn.reason === 'no_consent',
        turn.end || outOfTurns,
      );
    } finally {
      this.busy = false;
      const next = this.pendingUtterance;
      this.pendingUtterance = null;
      if (next && !this.stopping) void this.handleUtterance(next);
    }
  }

  /** Cancel from the website. */
  cancel() {
    return this.stop('cancelled', 'cancelled_by_staff');
  }

  /**
   * End and release everything, once: speech requests, media, timers, the virtual connection
   * and the call; then save the result.
   */
  async stop(status: 'completed' | 'no_consent' | 'not_answered' | 'cancelled' | 'failed', reason: string) {
    if (this.stopping) return this.finished;
    this.stopping = true;
    this.abort.abort();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.vad.reset();
    await this.peer?.close();
    callHub.remove(this.conn.id);
    if (this.callId)
      await finalize(this.schoolId, this.callId, [...LIVE_CALL], 'completed', `ai_${reason}`.slice(0, 40)).catch(
        () => undefined,
      );
    runningAgents.delete(this.conversationId);

    try {
      const consent = this.engine.consent;
      // Answered but never agreed (refused, unclear, or hung up during the disclosure): no consent.
      const finalStatus = status === 'completed' && consent !== 'given' ? 'no_consent' : status;
      let summary: string | undefined;
      let tokens = this.engine.llmTokens;
      if (consent === 'given' && (Object.keys(this.engine.answers).length || this.transcript.length)) {
        try {
          const system: SystemContext = { kind: 'system', schoolId: this.schoolId, label: 'ai_voice_call' };
          const s = await summarize(
            (req) => callAi(system, 'voice_conversation', req),
            this.cfg,
            this.transcript,
            this.engine.answers,
          );
          summary = s.text || undefined;
          tokens += s.tokens;
        } catch {
          summary = undefined; // The answers are kept even when no summary can be written.
        }
      }
      const endedAt = new Date();
      const keep = this.cfg.storeTranscript && consent === 'given' && this.transcript.length > 0;
      await AiConversation.updateOne(
        { _id: oid(this.conversationId), schoolId: oid(this.schoolId) },
        {
          $set: {
            status: finalStatus,
            ...(consent && consent !== 'given' ? { consent } : {}),
            answers: consent === 'given' ? this.engine.answers : {},
            outcome: consent === 'given' ? (this.engine.followUp ? 'follow_up' : this.engine.outcome()) : undefined,
            followUpRequested: this.engine.followUp,
            ...(summary ? { summary } : {}),
            ...(finalStatus === 'failed' || finalStatus === 'not_answered' ? { failureReason: reason } : {}),
            endedAt,
            ...(keep
              ? {
                  transcript: this.transcript,
                  transcriptExpiresAt: new Date(endedAt.getTime() + env.AI_CALL_TRANSCRIPT_RETENTION_DAYS * 86_400_000),
                }
              : {}),
            usage: {
              turns: this.turns,
              speechSeconds: Math.round(this.speechSeconds),
              ttsCharacters: this.ttsCharacters,
              llmTokens: tokens,
              durationSec: this.startedAt ? Math.round((endedAt.getTime() - this.startedAt.getTime()) / 1000) : 0,
            },
          },
        },
      );
      await audit(this.ctx, {
        action: 'ai_call.finished',
        entityType: 'AiConversation',
        entityId: this.conversationId,
        summary: `${finalStatus} (${reason})`,
        metadata: { status: finalStatus, reason, turns: this.turns, answered: Object.keys(this.engine.answers).length },
      });
    } catch (err) {
      logger.error({ err }, 'Could not save an AI conversation result');
    } finally {
      this.resolveFinished();
    }
    return this.finished;
  }
}

/** The configured engines, or what is missing. */
export function engines(): { stt: SpeechToText | null; tts: TextToSpeech | null } {
  return { stt: speechToText(), tts: textToSpeech() };
}
