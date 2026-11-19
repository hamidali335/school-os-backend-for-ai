import type { Api } from '../../utils/api';
import { objectId, paginationQuery, z } from '../../utils/zod';
import { CALL_KINDS, CALL_STATUSES } from './calls.model';
import * as svc from './calls.service';

const CallIdParams = z.object({
  callId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/)
    .openapi({ description: 'Opaque call id' }),
});
const ConnectionBody = z.object({
  connectionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32}$/)
    .openapi({ description: 'From the `ready` message of this device’s signaling connection' }),
});

const CallTarget = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('parent'), parentId: objectId().optional() }),
    z.object({ type: z.literal('staff'), userId: objectId() }),
    z.object({ type: z.literal('office') }),
  ])
  .openapi('CallTarget');

const CallRes = z
  .object({
    callId: z.string(),
    kind: z.enum(CALL_KINDS),
    ai: z.boolean().openapi({ description: 'An AI voice conversation: show the recipient that it is an AI assistant' }),
    direction: z.enum(['outgoing', 'incoming']),
    status: z.enum(CALL_STATUSES),
    outcome: z.string().openapi({
      description:
        'The call from your side: a status, or `missed` (rang you, not answered), `declined`, `answered_elsewhere` (another office member answered)',
    }),
    studentId: objectId(),
    studentName: z.string(),
    peerName: z.string(),
    peerRole: z.string(),
    startedAt: z.string(),
    ringExpiresAt: z.string(),
    answeredAt: z.string().nullable(),
    connectedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    durationSec: z.number(),
    endReason: z.string().nullable(),
  })
  .openapi('Call');

const IceRes = z
  .object({
    iceServers: z.array(
      z.object({ urls: z.array(z.string()), username: z.string().optional(), credential: z.string().optional() }),
    ),
    relayAvailable: z.boolean().openapi({ description: 'A TURN relay is configured' }),
    expiresAt: z.string().nullable().openapi({ description: 'When the TURN credentials stop working' }),
  })
  .openapi('CallIceServers');

const CallWithIce = IceRes.extend({ call: CallRes }).openapi('CallWithIceServers');
const CallOnly = z.object({ call: CallRes });

export function registerCallRoutes(api: Api) {
  const tags = ['Calls'];
  const permission = 'calls:use' as const;
  const lifecycle =
    'Changes of state are atomic: of two simultaneous answers exactly one succeeds, the other gets `409 CALL_NOT_RINGING`. ' +
    'Calls you were not part of answer `404`.';

  api.route({
    method: 'get',
    path: '/calls/ice-servers',
    tags,
    auth: 'school',
    permission,
    summary: 'STUN/TURN servers for WebRTC, with short-lived TURN credentials',
    response: IceRes,
    handler: ({ ctx }) => svc.iceServers(ctx),
  });

  api.route({
    method: 'post',
    path: '/calls',
    tags,
    auth: 'school',
    permission,
    status: 201,
    summary: 'Call someone about a student',
    description:
      'Staff call a parent of a student they may contact (`to: {type: "parent", parentId?}`, default the primary guardian). ' +
      'Parents call one of their child’s teachers or a school office member (`{type: "staff", userId}`) or the whole school office (`{type: "office"}`: every eligible office account rings, the first to answer takes it). ' +
      'Recipients come from the same relationships as messages, resolved on the server. ' +
      'The result is `ringing`, or at once `busy` (recipient already in or being rung for a call) or `unreachable` (no device of theirs is connected). ' +
      'Needs this device’s signaling `connectionId`. Limited per user per minute (`CALL_START_PER_MINUTE`).',
    body: ConnectionBody.extend({
      studentId: objectId(),
      to: CallTarget,
    }),
    response: CallWithIce,
    handler: ({ ctx, body }) => svc.startCall(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/calls',
    tags,
    auth: 'school',
    permission,
    summary: 'Your call history, newest first',
    description: 'With `conversationId`: only calls between that conversation’s two people about its student.',
    query: paginationQuery.extend({ conversationId: objectId().optional() }),
    response: CallRes.extend({
      conversationId: z.string().nullable(),
      callBack: CallTarget.nullable().openapi({ description: 'Target for calling back (with studentId)' }),
    }),
    paginated: true,
    handler: ({ ctx, query }) => svc.listCalls(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/calls/current',
    tags,
    auth: 'school',
    permission,
    summary: 'Your live call, if any',
    response: z.object({ call: CallRes.nullable() }),
    handler: ({ ctx }) => svc.currentCall(ctx),
  });

  api.route({
    method: 'get',
    path: '/calls/:callId',
    tags,
    auth: 'school',
    permission,
    summary: 'One of your calls',
    params: CallIdParams,
    response: CallOnly.extend({
      diagnostics: z
        .object({
          caller: z.record(z.string(), z.unknown()).optional(),
          callee: z.record(z.string(), z.unknown()).optional(),
        })
        .nullable()
        .openapi({ description: 'Connection statistics each side reported (participants only)' }),
    }),
    handler: ({ ctx, params }) => svc.getCall(ctx, params.callId),
  });

  api.route({
    method: 'post',
    path: '/calls/:callId/diagnostics',
    tags,
    auth: 'school',
    permission,
    status: 204,
    summary: 'Report this device’s connection statistics for the call (technical numbers only)',
    description:
      'ICE state, selected candidate types, audio bytes and packets each way, loss, round-trip time and microphone track state. Stored on the call record and logged with the call id; never audio or content. Participants only, until ten minutes after the call ended.',
    params: CallIdParams,
    body: z
      .object({
        moment: z.enum(svc.DIAGNOSTIC_MOMENTS),
        client: z.enum(['web', 'mobile']),
        iceState: z.string().max(20),
        localCandidate: z.string().max(10).nullable(),
        remoteCandidate: z.string().max(10).nullable(),
        bytesSent: z.number().int().min(0).max(1e12),
        bytesReceived: z.number().int().min(0).max(1e12),
        packetsSent: z.number().int().min(0).max(1e10),
        packetsReceived: z.number().int().min(0).max(1e10),
        packetsLost: z.number().int().min(-1e9).max(1e10),
        roundTripMs: z.number().int().min(0).max(600_000).nullable(),
        audioLevelIn: z.number().min(0).max(1).nullable(),
        audioLevelOut: z.number().min(0).max(1).nullable(),
        localTrack: z.enum(['live', 'ended', 'muted', 'none']),
      })
      .strict(),
    handler: ({ ctx, params, body }) => svc.recordDiagnostics(ctx, params.callId, body),
  });

  api.route({
    method: 'post',
    path: '/calls/:callId/accept',
    tags,
    auth: 'school',
    permission,
    summary: 'Answer a call that is ringing for you',
    description: `The relationship is checked again from the database before answering. ${lifecycle}`,
    params: CallIdParams,
    body: ConnectionBody,
    response: CallWithIce,
    handler: ({ ctx, params, body }) => svc.acceptCall(ctx, params.callId, body.connectionId),
  });

  api.route({
    method: 'post',
    path: '/calls/:callId/decline',
    tags,
    auth: 'school',
    permission,
    summary: 'Decline a call that is ringing for you',
    params: CallIdParams,
    response: CallOnly,
    handler: ({ ctx, params }) => svc.declineCall(ctx, params.callId),
  });

  api.route({
    method: 'post',
    path: '/calls/:callId/hangup',
    tags,
    auth: 'school',
    permission,
    summary: 'Hang up: cancel your ringing call, decline one ringing for you, or end an answered call',
    description: `Safe to repeat: a finished call is returned unchanged. ${lifecycle}`,
    params: CallIdParams,
    response: CallOnly,
    handler: ({ ctx, params }) => svc.hangUp(ctx, params.callId),
  });

  api.route({
    method: 'post',
    path: '/calls/:callId/connected',
    tags,
    auth: 'school',
    permission,
    summary: 'Report that audio is flowing (starts the call duration)',
    params: CallIdParams,
    response: CallOnly,
    handler: ({ ctx, params }) => svc.markConnected(ctx, params.callId),
  });

  api.route({
    method: 'post',
    path: '/calls/:callId/fail',
    tags,
    auth: 'school',
    permission,
    summary: 'Report that the call cannot continue on this device',
    params: CallIdParams,
    body: z.object({ reason: z.enum(svc.FAIL_REASONS) }),
    response: CallOnly,
    handler: ({ ctx, params, body }) => svc.failCall(ctx, params.callId, body.reason),
  });

  api.route({
    method: 'post',
    path: '/calls/:callId/rejoin',
    tags,
    auth: 'school',
    permission,
    summary: 'Continue your call from a new signaling connection after a network drop',
    description:
      'Within `CALL_RECONNECT_GRACE_SECONDS` of losing the connection. The other side is told to restart ICE.',
    params: CallIdParams,
    body: ConnectionBody,
    response: CallWithIce,
    handler: ({ ctx, params, body }) => svc.rejoinCall(ctx, params.callId, body.connectionId),
  });
}
