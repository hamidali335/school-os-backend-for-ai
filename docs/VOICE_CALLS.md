# App voice calls

Internet voice calls between the school office, teachers and parents, in the website and the mobile app. Self-hosted: signaling runs inside this API, audio is WebRTC between the two devices, and a TURN server you run relays audio when a direct path is impossible. There is no paid calling provider and no phone network. **Calls are never recorded**; the API never receives audio.

Module: `src/modules/calls` (model, policy, service, socket, routes). Website: `src/features/calls`. Mobile: `src/features/calls` (+ `android/.../CallAudioModule.kt`).

## Who can call whom

Calls follow exactly the messaging relationships (`src/modules/messaging/messaging.service.ts`), resolved from the database on every call and again when it is answered:

| Caller | May call |
|---|---|
| School leadership (Admin, Principal, Office Administrator), on the website | Any parent (with an active app account) of any student of their school |
| Teacher | Parents of students in sections they teach (class, subject or current substitute) |
| Parent | Their child's teachers; a named school office member with access to the child's campus; or **the school office**: every eligible office account rings and the first to answer takes the call |

- Needs the permission `calls:use` (parents, teachers, leadership; not accountants or custom roles, and it cannot be delegated) and the plan feature **`calls.voice`**.
- `calls.voice` is in **no default plan**, like a premium feature: the Platform Owner adds it to a plan or grants it to a school. It is removed when a subscription is ineligible, like the mobile and AI features. Prices and existing plans are unchanged.
- The mobile policy is unchanged: the app is for parents and teachers only, and the socket applies the same rule. Leadership places and takes calls on the website.
- Nothing the client sends identifies anyone: the caller comes from the verified session, recipients from the database, and the school from the token. Ids outside the user's school or relationships answer `404`/`403`.

## How a call works

```
caller (web/app)            API (REST + /api/v1/calls/socket)            recipient device(s)
  POST /calls ───────────────▶ resolve + authorize, create CallSession
                               status ringing ── call.incoming ─────────▶ rings (app/website open)
                                                       POST /calls/{id}/accept (re-authorized)
  ◀──── call.updated (connecting, onThisDevice) ───────  bound: callerConn ↔ calleeConn
  offer ──── signal ─────────▶ relayed only between the two bound connections ──▶ answer
  ICE candidates ◀──────────────────────────────────────────────────────────────▶
  audio: direct (STUN) or via TURN ════════════════════════════════════════════
  POST /calls/{id}/connected   status active, duration starts
  POST /calls/{id}/hangup      status completed (or cancelled / declined while ringing)
```

| Status | Meaning |
|---|---|
| `ringing` → `connecting` → `active` | Live: ringing, answered (media starting), audio flowing |
| `completed` | Answered and ended (`durationSec` from when audio started) |
| `missed` | Rang until `CALL_RING_TIMEOUT_SECONDS` |
| `declined` | The recipient declined (office calls: every office member declined) |
| `cancelled` | The caller hung up while it rang |
| `busy` | Every recipient was already in, placing, or being rung for another call |
| `unreachable` | No device of any recipient was connected, and none can be woken by push (`docs/INCOMING_CALLS.md`) |
| `failed` | No microphone, media could not connect (45 s), connection lost and not restored (`CALL_RECONNECT_GRACE_SECONDS`), the relationship ended before answering, or a server restart |

Each user sees an `outcome` from their side (`missed` for an unanswered incoming call, `answered_elsewhere` when another office member answered). Recipients who did not answer get an in-app "Missed call" notification (category `call`, link `/calls`).

### Endpoints

`GET /calls/ice-servers`, `POST /calls`, `GET /calls` (history; `conversationId` filter), `GET /calls/current`, `GET /calls/{callId}`, `POST /calls/{callId}/accept | decline | hangup | connected | fail | rejoin`. Schemas in `docs/openapi.json` (tag Calls). Conversations now include `callTo` and the contacts list includes `office` for parents (both additive).

### Signaling socket

`wss://<api host>/api/v1/calls/socket`, JSON text frames, max 64 KB per message.

- The first message is `{type: "auth", token, client?: "mobile"}` within 10 s. The token is **never in the URL** (no access-log exposure). It is verified exactly like a request (user, token version, school status, plan, mobile policy, `calls:use`, `calls.voice`), re-checked every 60 s, and the socket closes when the token expires unless the client re-authenticates (the clients do every 8 minutes). A connection cannot switch users.
- The server answers `{type: "ready", connectionId}`. The opaque `connectionId` goes into `POST /calls`, `accept` and `rejoin`, and only works for the same user and school.
- `{type: "signal", callId, signal}`: strict schema (offer/answer SDP ≤ 20 KB, ICE candidate ≤ 1 KB). It is relayed only to the other connection bound to that live call; anything else answers `NOT_IN_CALL`.
- Server events: `call.incoming` (with the school's name), `call.updated` (with `onThisDevice`), `call.peer_disconnected`, `call.peer_rejoined`, `signal`, `error`.
- Limits: 120-message burst then 15/s per connection, 10 invalid messages close it, 60 connection attempts per IP per minute, at most 5 connections per user (the oldest closes). Browsers must come from `CORS_ORIGINS`; apps send no Origin.

### Concurrency

- There is no global lock or busy flag. Each call is its own document with its own timers and two bound connections, so any number of calls run at once in any number of schools, and ending one never touches another.
- Every state change is a conditional update with `status` in the filter. Of two simultaneous answers one succeeds and the other gets `409 CALL_NOT_RINGING`. An answer racing a cancel or a timeout records exactly one outcome.
- **Busy policy** (per person only): someone placing a call, in a call, or already being rung is busy for new calls. If two people call the same person at once, the earlier call (by creation order) keeps ringing and the later one ends `busy`. Office calls ring only free office members.
- A user can have one live call as a participant. A user's other devices stop ringing when one device answers.

### Reconnection and cleanup

- A dropped signaling connection gives the other side `call.peer_disconnected` and starts a grace period. The client reconnects, calls `POST /calls/{id}/rejoin` with its new `connectionId`, and the caller restarts ICE. Without that, the call ends `failed` (`connection_lost`).
- When WebRTC itself fails, the caller restarts ICE. If audio does not recover in 15 s the client reports `fail` (`ice_failed`).
- Clients stop microphone tracks, close the peer connection, clear timers and release audio routing on every exit path. The server clears the call's timers when it reaches a final state.
- A database sweeper (every 15 s) ends calls whose ringing, connecting or maximum length (`CALL_MAX_MINUTES`) has passed, even if in-memory timers were lost. At startup, calls left live by a previous run are closed as `failed` (`server_restart`).

### Audio: order of operations and diagnostics

Both apps follow the same order, because getting it wrong produced one-way or missing audio:

1. The device that answers opens its microphone and creates its WebRTC connection **before** `POST /calls/{id}/accept`. The server tells the caller at once, and the caller's offer can arrive within milliseconds. An answer created before the microphone track is attached is receive-only, so that side is never heard. Earlier, the offer could also arrive before any connection existed, was dropped, and the call stayed in *Connecting…* until it failed after 45 s.
2. Signals (offer, answer, candidates) are handled one at a time in arrival order. Signals and candidates that arrive before the connection is bound to the call are kept, never dropped.
3. The caller offers only once its own microphone track is attached.
4. On Android the call uses communication mode and audio focus. A headset is used first, then the earpiece, or the speaker when turned on. The volume keys control the call stream, so a quiet call can be turned up. No gain is added, which avoids clipping and feedback. While a call is open, a foreground service (microphone type) keeps it going if the user leaves the app. Without it, Android cuts a background app's network within seconds.

Each side reports technical statistics when media connects and when the call ends: `POST /calls/{id}/diagnostics`. This covers ICE state, the selected candidate types (host / srflx / prflx / relay), audio bytes and packets each way, packet loss, round-trip time, the input and output audio level (0–1), and the microphone track state. Only participants can report, until ten minutes after the call ends. The data is stored on the call record (`GET /calls/{id}` → `diagnostics.caller` / `diagnostics.callee`, participants only) and logged as *Call media diagnostics* with a shortened call id. It holds no audio, no content and no personal data. To diagnose "I could not hear them": the listener's `bytesReceived` near zero means nothing arrived. The speaker's `bytesSent` near zero, `localTrack` other than `live`, or `audioLevelOut` near 0 while talking means their microphone captured nothing.

### Privacy and audit

- Stored per call: who, about which student, status, timestamps, duration, end reason. No audio, no transcript, no SDP or ICE data. Signaling payloads carry no user ids of other people and no connection ids.
- The audit log records `call.started` (who called whom about which student, and the immediate result). Tokens, TURN secrets and SDP are never logged.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CALLS_ENABLED` | `true` | Socket and call endpoints on this instance |
| `CALL_STUN_URLS` | empty | e.g. `stun:turn.example.pk:3478` |
| `CALL_TURN_URLS` | empty | e.g. `turn:turn.example.pk:3478?transport=udp,turn:turn.example.pk:3478?transport=tcp,turns:turn.example.pk:5349?transport=tcp` |
| `CALL_TURN_SECRET` | empty | coturn `static-auth-secret`, ≥ 32 characters. **Server only** |
| `CALL_TURN_TTL_SECONDS` | 4500 | TURN credential lifetime; must cover `CALL_MAX_MINUTES` (coturn refuses refreshes after expiry) |
| `CALL_RING_TIMEOUT_SECONDS` | 45 | |
| `CALL_RECONNECT_GRACE_SECONDS` | 20 | |
| `CALL_MAX_MINUTES` | 60 | |
| `CALL_START_PER_MINUTE` | 6 | Calls a user may start per minute |
| `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_FILE` | empty | Push for incoming calls when the app is not connected (`docs/INCOMING_CALLS.md`). **Server only**; the file path, never its contents, goes in `.env` |

TURN credentials are coturn's REST format: username `<expiry>:<hash of school+user>`, password `base64(HMAC-SHA1(secret, username))`. They are issued per user by the API with every call (`GET /calls/ice-servers`, `POST /calls`, `accept`, `rejoin`) and expire on their own. The apps contain no TURN secret.

### coturn (self-hosted TURN/STUN)

On a host with a **public IP** (a small VPS works; the relay carries only audio, about 50–100 kbit/s per relayed call):

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<same value as CALL_TURN_SECRET>
realm=turn.example.pk
cert=/etc/letsencrypt/live/turn.example.pk/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.pk/privkey.pem
min-port=49160
max-port=49200
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# behind 1:1 NAT: external-ip=<public IP>/<private IP>
```

Firewall: open **3478 UDP and TCP**, **5349 TCP** (TURN over TLS, for networks that block UDP) and the **relay range 49160–49200 UDP** (size it about 2 ports per concurrent relayed call). The `denied-peer-ip` lines stop the relay from being used to reach your private network.

### TLS and connectivity requirements

- Production: the API is HTTPS, so the socket is **wss://**. Browsers allow the microphone only on HTTPS (or `http://localhost`). The website's `Permissions-Policy` allows `microphone=(self)`, and its CSP allows the API's `wss://` origin.
- nginx must pass the WebSocket upgrade for `/api/v1/calls/socket` (see `docs/DEPLOYMENT.md` §6).
- **Do not assume the current home server is reachable from outside.** Calls between phones on mobile data need: (1) the API reachable over HTTPS from the internet, for signaling; and (2) a TURN server with a public IP, because carrier NAT usually defeats direct connections. Without TURN, calls connect reliably only when both devices are on the same network (e.g. the school Wi-Fi) or have open NAT.

### Local development

1. `SEED_DEMO_PASSWORD='…' npm run demo`. The in-memory demo grants `calls.voice` to the demo school (`DEMO_CALLS=false` to see the plan without it). Calls work with no STUN/TURN on one machine or one LAN.
2. Website at `http://localhost:3000` (microphone allowed on localhost). Sign in as `owner@…`.
3. Emulator app (API `http://10.0.2.2:4000/api/v1`), parent or teacher. An emulator's microphone is the PC's.
4. Optional local coturn: `docker run --network host coturn/coturn -n --use-auth-secret --static-auth-secret=<32+ chars> --realm=local --listening-port=3478`, with `CALL_TURN_URLS=turn:<PC LAN IP>:3478` and `CALL_TURN_SECRET=<same>`.

## Limitations

- **Ringing when the app is not in front** (details in `docs/INCOMING_CALLS.md`):
  - While the app is open, or was just put in the background, an incoming call shows a call notification with Answer and Decline. The server checks both actions.
  - A few seconds after the app goes to the background, Android blocks its network, and it no longer receives calls over the socket.
  - Without push configured, a closed or long-backgrounded app does not ring. The caller sees *Not reachable*, and the recipient gets a missed-call notice.
  - With push (FCM) configured, the server wakes the device with a high-priority push and the notification rings. This still has limits: a **force-stopped** app never receives push until the user opens it again, and some manufacturers' battery savers delay or drop push.
  - There is no Android ConnectionService integration (the call does not appear in the system call log).
- An active call continues in the background through a foreground service while it is open. Swiping the app away from recent apps ends the call. The server records it as `failed` / `connection_lost` after `CALL_RECONNECT_GRACE_SECONDS`.
- Bluetooth headsets follow Android's default routing; there is no in-app device picker.
- **Verified:**
  - Automatically: authorization, routing, isolation, lifecycle, concurrency, signaling relay, diagnostics and push decisions (backend tests).
  - On an Android emulator against the real website in Chromium (fake microphone), on one PC and LAN: audio both ways, Answer and Decline from the notification, caller cancel, and a call continuing after leaving the app.
- **Not yet verified:** audio between two physical phones, across mobile data or strict NATs, through a TURN relay, and push delivery (needs a Firebase project). Do not rely on cross-network calls until a TURN server is set up and tested.

## Running several API instances (later)

Today's state in memory (per instance): open signaling connections and who they belong to, per-call timers, per-user start counters, per-IP connection counters. Everything that decides a call (status, who may answer, the two bound connections) is in MongoDB, so no decision depends on memory alone.

For several instances: (1) a shared presence registry and pub/sub (e.g. Redis) so events and signals reach a connection held by another instance. `calls.hub.ts` (`toUser`, `toConn`, `isOnline`) is the seam. (2) Timers owned by one instance, or the database sweeper alone. (3) Shared rate-limit counters. (4) `recoverInterruptedCalls` limited to calls owned by the restarting instance. Sticky sessions are not required once (1) exists. A media server (SFU) is only needed for group calls or recording, both out of scope.

## Later stages: integration boundaries

Stage 3 (AI voice conversations) is implemented in `src/modules/ai-calls`: see `docs/AI_VOICE_CALLS.md`. AI calls are call sessions of kind `ai` with a server-side WebRTC peer. Stage 4 (automated announcement calls) is **not implemented**. The seams:

- `callEvents` (`calls.service.ts`) emits `finished` with call metadata, for outcome reporting without changing the lifecycle.
- `calls.policy.ts` is the only place that decides recipients; an automated caller would be a new, explicitly authorized caller type there, never a bypass.
- Media stays peer-to-peer. A future speech component would join as a WebRTC peer, or through a media server, behind the same signaling and authorization, with a replaceable provider interface like `docs/AI_PROVIDERS.md`.
