import OpusScript from 'opusscript';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  type RTCIceCandidate,
} from 'werift';
import type { IceServer } from '../calls/calls.ice';
import { FRAME_MS, OPUS_RATE, resample, SPEECH_RATE } from './audio';

/**
 * The AI agent's side of the WebRTC call (werift: WebRTC in plain TypeScript, no native code).
 * Incoming Opus audio is decoded and handed on as 16 kHz PCM frames; speech to play is encoded
 * to Opus and sent in real time, 20 ms per packet. One peer per call; nothing is shared between
 * calls and nothing is recorded.
 */

const SAMPLES_PER_FRAME = (OPUS_RATE * FRAME_MS) / 1000; // 960

export type PeerSignal =
  | { kind: 'offer'; sdp: string; restart?: boolean }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

export type PeerState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export class AiMediaPeer {
  private readonly pc: RTCPeerConnection;
  private readonly track = new MediaStreamTrack({ kind: 'audio' });
  private readonly encoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
  private readonly decoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
  private queue: Buffer[] = [];
  private pacer: NodeJS.Timeout | null = null;
  private seq = Math.floor(Math.random() * 65535);
  private timestamp = Math.floor(Math.random() * 2 ** 31);
  private readonly ssrc = Math.floor(Math.random() * 2 ** 32);
  private payloadType = 111;
  private drained: Array<() => void> = [];
  private pendingCandidates: Array<{ candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }> = [];
  private remoteSet = false;
  closed = false;

  constructor(
    iceServers: IceServer[],
    private readonly send: (s: PeerSignal) => void,
    private readonly onState: (s: PeerState) => void,
    /** 20 ms frames of the remote party's audio at 16 kHz. */
    private readonly onAudio: (pcm16k: Int16Array) => void,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: iceServers.map((s) => ({ urls: s.urls[0], username: s.username, credential: s.credential })),
      codecs: {
        audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: OPUS_RATE, channels: 2 })],
      },
    });
    this.pc.onIceCandidate.subscribe((c?: RTCIceCandidate) => {
      if (c?.candidate)
        this.send({
          kind: 'candidate',
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
        });
    });
    this.pc.connectionStateChange.subscribe((s) => this.onState(s as PeerState));
    const transceiver = this.pc.addTransceiver(this.track, { direction: 'sendrecv' });
    transceiver.onTrack.subscribe((remote) => {
      remote.onReceiveRtp.subscribe((rtp) => {
        if (this.closed) return;
        try {
          const pcm48 = this.decoder.decode(rtp.payload);
          const samples = new Int16Array(pcm48.buffer, pcm48.byteOffset, Math.floor(pcm48.byteLength / 2));
          this.onAudio(resample(samples, OPUS_RATE, SPEECH_RATE));
        } catch {
          /* a damaged packet: skip it */
        }
      });
    });
  }

  /** The AI side always makes the offer (like the caller in a normal call). */
  async makeOffer(restart = false) {
    if (this.closed) return;
    const offer = await this.pc.createOffer({ iceRestart: restart });
    await this.pc.setLocalDescription(offer);
    this.send({ kind: 'offer', sdp: this.pc.localDescription!.sdp, ...(restart ? { restart: true } : {}) });
  }

  async handle(signal: PeerSignal) {
    if (this.closed) return;
    if (signal.kind === 'answer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      this.remoteSet = true;
      const codec = this.pc.getTransceivers()[0]?.codecs?.[0];
      if (codec?.payloadType) this.payloadType = codec.payloadType;
      for (const c of this.pendingCandidates.splice(0)) await this.addCandidate(c);
    } else if (signal.kind === 'candidate') {
      if (this.remoteSet) await this.addCandidate(signal);
      else this.pendingCandidates.push(signal);
    }
    // An offer from the other side is not expected: the AI side always offers.
  }

  private async addCandidate(c: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }) {
    await this.pc
      .addIceCandidate({
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? undefined,
        sdpMLineIndex: c.sdpMLineIndex ?? undefined,
      })
      .catch(() => undefined);
  }

  /** Queue 16 kHz speech for playback; resolves when it has all been sent (or was interrupted). */
  play(pcm16k: Int16Array): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pcm48 = resample(pcm16k, SPEECH_RATE, OPUS_RATE);
    for (let i = 0; i < pcm48.length; i += SAMPLES_PER_FRAME) {
      const frame = new Int16Array(SAMPLES_PER_FRAME);
      frame.set(pcm48.subarray(i, i + SAMPLES_PER_FRAME));
      this.queue.push(this.encoder.encode(Buffer.from(frame.buffer), SAMPLES_PER_FRAME));
    }
    this.startPacer();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  get speaking() {
    return this.queue.length > 0;
  }

  /** Stop talking now (the parent started speaking). */
  interrupt() {
    this.queue = [];
    this.flushDrained();
  }

  private startPacer() {
    if (this.pacer) return;
    this.pacer = setInterval(() => {
      const payload = this.queue.shift();
      if (!payload) {
        this.stopPacer();
        this.flushDrained();
        return;
      }
      this.seq = (this.seq + 1) & 0xffff;
      this.timestamp = (this.timestamp + SAMPLES_PER_FRAME) >>> 0;
      const header = new RtpHeader({
        payloadType: this.payloadType,
        sequenceNumber: this.seq,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
        marker: false,
      });
      try {
        this.track.writeRtp(new RtpPacket(header, payload));
      } catch {
        /* not connected yet or closing */
      }
    }, FRAME_MS);
    this.pacer.unref?.();
  }

  private stopPacer() {
    if (this.pacer) clearInterval(this.pacer);
    this.pacer = null;
  }

  private flushDrained() {
    for (const r of this.drained.splice(0)) r();
  }

  /** Release everything: timers, codecs, the peer connection. Safe to call twice. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopPacer();
    this.queue = [];
    this.flushDrained();
    try {
      this.encoder.delete();
      this.decoder.delete();
    } catch {
      /* already freed */
    }
    await this.pc.close().catch(() => undefined);
  }
}
