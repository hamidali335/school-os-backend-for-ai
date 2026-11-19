import http from 'node:http';
import type { AddressInfo } from 'node:net';
import OpusScript from 'opusscript';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from 'werift';
import WebSocket from 'ws';
import { AuditLog } from '../src/modules/audit/audit.model';
import { setAiProviderForTests, type AiProvider, type ChatRequest } from '../src/modules/ai/provider';
import { runningAgents } from '../src/modules/ai-calls/ai-calls.agent';
import { AiConversation } from '../src/modules/ai-calls/ai-calls.model';
import { purgeExpiredTranscripts } from '../src/modules/ai-calls/ai-calls.service';
import { classifyConsent, ConversationEngine, validAnswer, type Llm } from '../src/modules/ai-calls/conversation';
import { setSpeechEnginesForTests, type SpeechToText, type TextToSpeech } from '../src/modules/ai-calls/speech';
import { callHub, callStarts, callTimers } from '../src/modules/calls/calls.hub';
import { CallSession } from '../src/modules/calls/calls.model';
import { attachCallSignaling, SIGNALING_PATH } from '../src/modules/calls/calls.socket';
import { School } from '../src/modules/schools/school.model';
import { auth, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * AI voice conversations. The pipeline is real: signaling socket, call lifecycle, WebRTC between
 * the server's AI peer and a separate WebRTC "phone" (werift), Opus audio both ways, voice
 * activity detection, conversation engine, storage. Only the engines are test doubles: speech
 * recognition returns scripted text and synthesis returns a tone (no Urdu speech engine runs here),
 * and the language model is a scripted provider. Real engines are not verified by these tests.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let server: http.Server;
let url: string;

// ── test doubles for the engines ──
const heard: string[] = [];
const sttScript: string[] = [];
const stt: SpeechToText = {
  name: 'test-stt',
  transcribe: async () => ({ text: sttScript.shift() ?? '' }),
};
const tts: TextToSpeech = {
  name: 'test-tts',
  synthesize: async (text) => {
    heard.push(text);
    return new Int16Array(16000 * 0.3).map((_, k) => Math.round(6000 * Math.sin((2 * Math.PI * 330 * k) / 16000)));
  },
};
let llmCalls = 0;
const provider: AiProvider = {
  name: 'test',
  model: 'test-llm',
  isConfigured: () => true,
  estimateCostUsd: () => 0,
  chat: async (req: ChatRequest) => {
    llmCalls++;
    const system = String(req.messages[0]?.content ?? '');
    const last = String(req.messages[req.messages.length - 1]?.content ?? '');
    const reply = (content: string) => ({
      content,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      model: 'test-llm',
    });
    if (system.startsWith('Summarize')) return reply('The parent will collect the child at 3 PM.');
    if (req.tools?.length) throw new Error('AI calls must never offer tools');
    if (last.includes('agreed to continue'))
      return reply('{"say":"آپ بچے کو کس وقت لینے آئیں گے؟","answers":{},"done":false}');
    if (last.includes('Parent:'))
      return reply('{"say":"شکریہ۔","answers":{"pickup_time":"3 PM","coming":true},"done":true}');
    return reply('not json');
  },
};

// ── signaling client and a WebRTC phone ──
type Event = Record<string, any>;
interface Sock {
  ws: WebSocket;
  id: string;
  events: Event[];
  waitFor(type: string, pred?: (e: Event) => boolean, ms?: number): Promise<Event>;
  send(m: unknown): void;
}
const sockets: WebSocket[] = [];
async function connect(token: string): Promise<Sock> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const events: Event[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    events.push(JSON.parse(raw.toString()));
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((r) => ws.once('open', r));
  const sock: Sock = {
    ws,
    id: '',
    events,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (type, pred = () => true, ms = 8000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
        const check = () => {
          const i = events.findIndex((e) => e.type === type && pred(e));
          if (i >= 0) {
            clearTimeout(timer);
            resolve(events.splice(i, 1)[0]);
          } else waiters.push(check);
        };
        check();
      }),
  };
  sock.send({ type: 'auth', token });
  sock.id = (await sock.waitFor('ready')).connectionId;
  return sock;
}

/** The parent's phone: answers the AI's offer, plays "speech" into the call, counts what it hears. */
function phone(sock: Sock, callId: string) {
  const pc = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2 })] },
  });
  const track = new MediaStreamTrack({ kind: 'audio' });
  const tr = pc.addTransceiver(track, { direction: 'sendrecv' });
  const state = { received: 0, connected: false };
  tr.onTrack.subscribe((remote) => remote.onReceiveRtp.subscribe(() => state.received++));
  pc.connectionStateChange.subscribe((s) => (state.connected = s === 'connected' || state.connected));
  pc.onIceCandidate.subscribe((c) => {
    if (c?.candidate)
      sock.send({
        type: 'signal',
        callId,
        signal: {
          kind: 'candidate',
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
        },
      });
  });
  let remoteSet = false;
  const early: Event[] = [];
  sock.ws.on('message', async (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.type !== 'signal' || e.callId !== callId) return;
    if (e.signal.kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: e.signal.sdp });
      remoteSet = true;
      for (const c of early.splice(0))
        await pc.addIceCandidate({
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? undefined,
          sdpMLineIndex: c.sdpMLineIndex ?? undefined,
        });
      await pc.setLocalDescription(await pc.createAnswer());
      sock.send({ type: 'signal', callId, signal: { kind: 'answer', sdp: pc.localDescription!.sdp } });
    } else if (e.signal.kind === 'candidate') {
      if (remoteSet)
        await pc
          .addIceCandidate({
            candidate: e.signal.candidate,
            sdpMid: e.signal.sdpMid ?? undefined,
            sdpMLineIndex: e.signal.sdpMLineIndex ?? undefined,
          })
          .catch(() => undefined);
      else early.push(e.signal);
    }
  });
  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  let seq = 0;
  /** ~0.6 s of "speech" then ~1 s of silence, in real time (20 ms packets). */
  const speak = async () => {
    for (let i = 0; i < 80; i++) {
      const loud = i < 30;
      const frame = new Int16Array(960).map((_, k) =>
        loud ? Math.round(9000 * Math.sin((2 * Math.PI * 220 * (i * 960 + k)) / 48000)) : 0,
      );
      track.writeRtp(
        new RtpPacket(
          new RtpHeader({ payloadType: 111, sequenceNumber: seq++, timestamp: seq * 960, ssrc: 4321 }),
          enc.encode(Buffer.from(frame.buffer), 960),
        ),
      );
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    pc,
    state,
    speak,
    close: async () => {
      enc.delete();
      await pc.close();
    },
  };
}

const api = (token: string, method: 'get' | 'post', path: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${path}`).set(auth(token)).send(body);
const start = (token: string, studentId: string, extra: object = {}) =>
  api(token, 'post', '/ai-calls', {
    studentId,
    purpose: 'Confirm the pickup time for the school trip',
    language: 'ur',
    questions: [
      { key: 'coming', prompt: 'Will your child come on the trip?', type: 'yes_no' },
      { key: 'pickup_time', prompt: 'At what time will you collect your child?', type: 'text' },
    ],
    ...extra,
  });

async function grant(schoolId: string, features: string[]) {
  await School.updateOne(
    { _id: schoolId },
    { $push: { 'subscription.featureOverrides': { $each: features.map((feature) => ({ feature, mode: 'grant' })) } } },
  );
}

async function until(fn: () => Promise<boolean> | boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 2 });
  other = await buildSchool(t.app, { students: 1 });
  await grant(f.schoolId, ['calls.voice', 'calls.ai_voice']);
  await grant(other.schoolId, ['calls.voice', 'calls.ai_voice']);
  server = http.createServer(t.app);
  attachCallSignaling(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${SIGNALING_PATH}`;
});

afterEach(async () => {
  for (const a of [...runningAgents.values()]) if ('stop' in a) await a.stop('failed', 'test_cleanup');
  for (const ws of sockets.splice(0)) ws.close();
  setSpeechEnginesForTests({ stt: null, tts: null });
  setAiProviderForTests(null);
  await CallSession.updateMany(
    { status: { $in: ['ringing', 'connecting', 'active'] } },
    { $set: { status: 'failed' } },
  ).setOptions({ crossTenant: true });
  callTimers.clearAll();
  callStarts.reset();
  heard.length = 0;
  sttScript.length = 0;
});

afterAll(async () => {
  callHub.closeAll(1001, 'done');
  await new Promise((r) => server.close(r));
});

function engines() {
  setSpeechEnginesForTests({ stt, tts });
  setAiProviderForTests(provider);
}

describe('a full AI conversation over a real WebRTC call', () => {
  it('rings the parent as an AI call, asks for consent, asks the questions, saves answers, transcript and summary', async () => {
    engines();
    const parent = await connect(f.parentToken);
    const res = await start(f.ownerToken, f.students[0]);
    expect(res.status).toBe(201);
    expect(res.body.data.conversation).toMatchObject({ status: 'ringing', parentName: 'Parent 0', language: 'ur' });
    const ring = await parent.waitFor('call.incoming');
    expect(ring.call).toMatchObject({
      ai: true,
      kind: 'ai',
      peerName: 'AI assistant',
      peerRole: 'AI assistant for the school',
    });
    const callId = ring.call.callId;
    const ph = phone(parent, callId);
    expect((await api(f.parentToken, 'post', `/calls/${callId}/accept`, { connectionId: parent.id })).status).toBe(200);
    await until(() => ph.state.connected);
    // The fixed disclosure is spoken first (AI, school, transcript notice, consent question).
    await until(() => heard.length >= 1);
    expect(heard[0]).toMatch(/اے آئی معاون/);
    expect(heard[0]).toMatch(/ہاں یا نہیں/);
    await until(() => ph.state.received > 10); // the parent hears it
    sttScript.push('جی ہاں');
    await ph.speak();
    await until(() => heard.length >= 2);
    expect(heard[1]).toBe('آپ بچے کو کس وقت لینے آئیں گے؟');
    sttScript.push('تین بجے، اور جی وہ آئے گا');
    await ph.speak();
    await until(
      async () =>
        (await AiConversation.findOne({ _id: res.body.data.conversation._id, schoolId: f.schoolId }).lean())?.status ===
        'completed',
      20000,
    );
    const conv = (await api(f.ownerToken, 'get', `/ai-calls/${res.body.data.conversation._id}`)).body.data;
    expect(conv).toMatchObject({
      status: 'completed',
      consent: 'given',
      answers: { pickup_time: '3 PM', coming: true },
      outcome: 'all_answered',
      summary: 'The parent will collect the child at 3 PM.',
    });
    expect(conv.transcript.map((x: { role: string }) => x.role)).toEqual(['ai', 'parent', 'ai', 'parent', 'ai']);
    expect(conv.transcriptExpiresAt).toBeTruthy();
    expect(conv.usage.turns).toBe(2);
    expect(conv.usage.llmTokens).toBeGreaterThan(0);
    const call = await CallSession.findOne({ schoolId: f.schoolId, callId }).lean();
    expect(call).toMatchObject({ kind: 'ai', status: 'completed' });
    expect(await AuditLog.exists({ schoolId: f.schoolId, action: 'ai_call.transcript_viewed' })).toBeTruthy();
    expect(await AuditLog.exists({ schoolId: f.schoolId, action: 'ai_call.finished' })).toBeTruthy();
    // The parent's ordinary history shows it as an AI call.
    const mine = (await api(f.parentToken, 'get', '/calls')).body.data.find(
      (c: { callId: string }) => c.callId === callId,
    );
    expect(mine).toMatchObject({ ai: true });
    await ph.close();
  }, 60000);

  it('no consent: the AI says goodbye, nothing is kept but the refusal', async () => {
    engines();
    const parent = await connect(f.parentToken);
    const res = await start(f.ownerToken, f.students[0]);
    const callId = (await parent.waitFor('call.incoming')).call.callId;
    const ph = phone(parent, callId);
    await api(f.parentToken, 'post', `/calls/${callId}/accept`, { connectionId: parent.id });
    await until(() => heard.length >= 1);
    sttScript.push('جی نہیں');
    await ph.speak();
    await until(
      async () =>
        (await AiConversation.findOne({ _id: res.body.data.conversation._id, schoolId: f.schoolId }).lean())?.status ===
        'no_consent',
      20000,
    );
    const conv = await AiConversation.findOne({ _id: res.body.data.conversation._id, schoolId: f.schoolId }).lean();
    expect(conv).toMatchObject({ consent: 'refused', answers: {} });
    expect(conv!.transcript).toBeUndefined();
    expect(conv!.summary).toBeUndefined();
    expect(heard[1]).toMatch(/شکریہ/);
    await ph.close();
  }, 60000);

  it('the parent does not answer: not answered, no AI processing', async () => {
    engines();
    const before = llmCalls;
    const res = await start(f.ownerToken, f.students[0]); // parent not connected
    expect(res.body.data.call.status).toBe('unreachable');
    expect(res.body.data.conversation).toMatchObject({ status: 'not_answered', failureReason: 'unreachable' });
    expect(llmCalls).toBe(before);
  });

  it('transcripts can be turned off, and expire', async () => {
    engines();
    const parent = await connect(f.parentToken);
    const res = await start(f.ownerToken, f.students[0], { storeTranscript: false });
    const callId = (await parent.waitFor('call.incoming')).call.callId;
    const ph = phone(parent, callId);
    await api(f.parentToken, 'post', `/calls/${callId}/accept`, { connectionId: parent.id });
    await until(() => heard.length >= 1);
    expect(heard[0]).toMatch(/ریکارڈ محفوظ نہیں ہوگا/);
    sttScript.push('ہاں');
    await ph.speak();
    await until(() => heard.length >= 2);
    sttScript.push('تین بجے');
    await ph.speak();
    await until(
      async () =>
        (await AiConversation.findOne({ _id: res.body.data.conversation._id, schoolId: f.schoolId }).lean())?.status ===
        'completed',
      20000,
    );
    const conv = await AiConversation.findOne({ _id: res.body.data.conversation._id, schoolId: f.schoolId }).lean();
    expect(conv!.transcript).toBeUndefined();
    expect(conv!.answers).toMatchObject({ pickup_time: '3 PM' });
    // Retention: an expired transcript is removed, answers stay.
    await AiConversation.updateOne(
      { _id: conv!._id, schoolId: f.schoolId },
      {
        $set: {
          transcript: [{ role: 'ai', text: 'x', at: new Date() }],
          transcriptExpiresAt: new Date(Date.now() - 1000),
        },
      },
    );
    expect(await purgeExpiredTranscripts()).toBeGreaterThanOrEqual(1);
    const after = await AiConversation.findOne({ _id: conv!._id, schoolId: f.schoolId }).lean();
    expect(after!.transcript).toBeUndefined();
    expect(after!.answers).toMatchObject({ pickup_time: '3 PM' });
    await ph.close();
  }, 60000);

  it('staff can cancel a running AI call; the parent’s call ends', async () => {
    engines();
    const parent = await connect(f.parentToken);
    const res = await start(f.ownerToken, f.students[0]);
    const callId = (await parent.waitFor('call.incoming')).call.callId;
    const c = await api(f.ownerToken, 'post', `/ai-calls/${res.body.data.conversation._id}/cancel`);
    expect(c.body.data.status).toBe('cancelled');
    expect(
      (await parent.waitFor('call.updated', (e) => e.call.callId === callId && e.call.status === 'completed')).call
        .outcome,
    ).toBe('completed');
    expect(runningAgents.size).toBe(0);
  });
});

describe('authorization, plan, engines and limits', () => {
  it('only leadership with the plan feature; teachers, accountants and parents cannot', async () => {
    engines();
    for (const token of [f.teacherToken, f.accountantToken, f.parentToken])
      expect((await start(token, f.students[0])).status).toBe(403);
    await School.updateOne(
      { _id: other.schoolId },
      { $set: { 'subscription.featureOverrides': [{ feature: 'calls.voice', mode: 'grant' }] } },
    );
    try {
      const res = await start(other.ownerToken, other.students[0]);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    } finally {
      await grant(other.schoolId, ['calls.ai_voice']);
    }
  });

  it('School B cannot start, list, read or cancel School A conversations', async () => {
    engines();
    const a = await start(f.ownerToken, f.students[0]);
    const id = a.body.data.conversation._id;
    expect((await start(other.ownerToken, f.students[0])).status).toBe(404);
    expect((await api(other.ownerToken, 'get', `/ai-calls/${id}`)).status).toBe(404);
    expect((await api(other.ownerToken, 'post', `/ai-calls/${id}/cancel`)).status).toBe(404);
    expect((await api(other.ownerToken, 'get', '/ai-calls')).body.data.some((c: { _id: string }) => c._id === id)).toBe(
      false,
    );
  });

  it('missing engines: 503 with what is missing, nothing is called', async () => {
    setSpeechEnginesForTests({ stt: null, tts: null });
    setAiProviderForTests(provider);
    const res = await start(f.ownerToken, f.students[0]);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'AI_CALL_UNAVAILABLE',
      details: { missing: ['speech_to_text', 'text_to_speech'] },
    });
    const avail = (await api(f.ownerToken, 'get', '/ai-calls/availability')).body.data;
    expect(avail).toMatchObject({ ready: false, speechToText: null, languageModel: 'configured' });
  });

  it('one AI call per school at a time; another school can run its own', async () => {
    engines();
    const parent = await connect(f.parentToken);
    const first = await start(f.ownerToken, f.students[0]);
    expect(first.body.data.conversation.status).toBe('ringing');
    await parent.waitFor('call.incoming');
    const second = await start(f.principalToken, f.students[1]);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('AI_CALL_BUSY');
    const bParent = await connect(other.parentToken);
    const b = await start(other.ownerToken, other.students[0]);
    expect(b.body.data.conversation.status).toBe('ringing');
    const bRing = await bParent.waitFor('call.incoming');
    // Each school's parent rings for its own conversation only.
    expect(bRing.call.studentName).toBe(b.body.data.conversation.studentName);
    expect(parent.events.filter((e) => e.type === 'call.incoming')).toEqual([]);
  });

  it('input is validated: question keys, types and choices', async () => {
    engines();
    const bad = await api(f.ownerToken, 'post', '/ai-calls', {
      studentId: f.students[0],
      purpose: 'Test',
      questions: [{ key: 'Bad Key', prompt: 'x?', type: 'text' }],
    });
    expect(bad.status).toBe(400);
    const dup = await start(f.ownerToken, f.students[0], {
      questions: [
        { key: 'a', prompt: 'One?', type: 'text' },
        { key: 'a', prompt: 'Two?', type: 'text' },
      ],
    });
    expect(dup.status).toBe(409);
  });
});

describe('conversation engine (unit)', () => {
  it('consent is decided by fixed rules; "no" wins', () => {
    expect(classifyConsent('جی ہاں')).toBe('given');
    expect(classifyConsent('haan ji')).toBe('given');
    expect(classifyConsent('جی نہیں')).toBe('refused');
    expect(classifyConsent('انہوں نے کہا')).toBe('unclear');
    expect(classifyConsent('hmm')).toBe('unclear');
  });

  it('model answers are validated against the questions; unknown keys are ignored', async () => {
    const q = { key: 'n', prompt: 'How many?', type: 'number' as const, required: true };
    expect(validAnswer(q, '3 children')).toBe(3);
    expect(validAnswer({ ...q, type: 'choice', choices: ['Bus', 'Car'] }, 'car')).toBe('Car');
    expect(validAnswer({ ...q, type: 'choice', choices: ['Bus', 'Car'] }, 'plane')).toBeUndefined();
    const llm: Llm = async () => ({
      content: '{"say":"ok","answers":{"n":"2","admin_password":"x"},"done":true}',
      toolCalls: [],
      usage: null,
      model: 'x',
    });
    const e = new ConversationEngine(
      {
        language: 'en',
        purpose: 'p',
        schoolName: 's',
        studentName: 'k',
        staffName: 'm',
        questions: [q],
        storeTranscript: true,
      },
      llm,
    );
    await e.onParent('yes');
    expect(e.answers).toEqual({ n: 2 });
  });

  it('a failing model falls back to the written question, then ends after two failures', async () => {
    const llm: Llm = async () => {
      throw new Error('down');
    };
    const e = new ConversationEngine(
      {
        language: 'en',
        purpose: 'p',
        schoolName: 's',
        studentName: 'k',
        staffName: 'm',
        questions: [{ key: 'a', prompt: 'Question A?', type: 'text', required: true }],
        storeTranscript: true,
      },
      llm,
    );
    expect((await e.onParent('yes')).say).toBe('Question A?');
    const end = await e.onParent('something');
    expect(end).toMatchObject({ end: true, reason: 'llm_unavailable' });
  });
});
