# Incoming calls when the app is not in front

How an incoming app call reaches a parent or teacher whose app is in the background, locked or closed, what has to be configured for that, and what Android does not allow. The call itself is described in `docs/VOICE_CALLS.md`.

## What happens

| Recipient's app | How it rings | Needs |
|---|---|---|
| Open, in front | Full-screen call screen in the app, with ringtone | Nothing |
| Just put in the background, or the screen just locked | Call notification: ringtone, caller, *About <student>*, school, **Answer** and **Decline**. Shown over the lock screen where Android allows it | Notification permission |
| Backgrounded for more than a few seconds, or closed (not force-stopped) | Same notification, after a high-priority push wakes the app | Push configured (below) and notification permission |
| Force-stopped (*Settings › Apps › Force stop*), or never opened since install | Does not ring. The caller sees *Not reachable*, and the recipient gets a missed-call notice | Not possible on Android: no app may be woken after a force stop until the user opens it |

Why the background row needs push: Android blocks a background app's network a few seconds after it leaves the screen. This was observed on Android 17 (`dumpsys netpolicy` shows `blocked=APP_BACKGROUND`). The app's signaling connection then receives nothing. Only a high-priority FCM message lifts that restriction for a short time.

Some manufacturers (for example Xiaomi, Oppo, Vivo, Huawei) also stop background apps more aggressively. On those phones, the user may need to allow the app to run in the background (*battery: no restrictions*) for reliable ringing.

### Answer and Decline are checked by the server

The notification carries only what the recipient may see: caller name, role, student and school. It holds no tokens, user ids or connection ids. Nothing in it authorizes anything:

- **Answer** opens the app. The app connects to the server, which re-sends calls still ringing for this user. The answer then goes through `POST /calls/{id}/accept`, which checks the session, school, relationship and call state again. If the call has already ended, the app says so (*This call has already ended*).
- **Decline** runs a short background task. It uses the stored session to call `POST /calls/{id}/decline`, which applies the same checks. A user who is signed out, or who is not a recipient of this call, cannot decline it. Without a network connection nothing is sent, and the call ends as unanswered when it stops ringing.
- The notification is removed when the call stops ringing (answered elsewhere, cancelled by the caller, missed), and in any case when the ring time (`CALL_RING_TIMEOUT_SECONDS`) is over.
- Signing out removes this device's push registration (`DELETE /devices/push`) before the session is revoked.

## Why the website could show "Ringing" while the phone stayed silent

Android freezes an app a few seconds after it goes to the background, but its socket to the server stays open. The server saw the parent as connected, rang over that socket, and the frozen app never heard it: the caller saw *Ringing* for the whole ring time.

Now clients that support it (the website and the mobile app since 29 Oct 2026) send `acks: true` when they connect and acknowledge every `call.incoming` at once. A device that promised this and does not acknowledge within 6 seconds is treated as frozen: its connection is closed, and if nobody else can receive the call (no live device and no registered push device) the call ends as **unreachable** straight away. Older clients that never promised acknowledgements are not affected.

With push configured, a frozen app is woken by a high-priority push, which is sent for every ringing call. **Without push, a phone whose app is in the background or closed cannot ring at all.**

## Configuring push (Firebase Cloud Messaging)

Push for calls and for school notifications is one system, with one configuration: see [PUSH_NOTIFICATIONS.md](PUSH_NOTIFICATIONS.md) for set-up, the production checklist and checks (`npm run push:check -- --google --app <google-services.json>`). Keyless credentials are in [FCM_KEYLESS.md](FCM_KEYLESS.md).

For calls specifically:
- A recipient with a device registered in the last 30 days counts as reachable, so their call rings by push even when their app is not connected.
- The incoming-call push is a high-priority, data-only message that lives only for the remaining ring time. The app shows its own call notification from it. A `call.ended` push removes that notification.
- When push is not configured, nothing is sent anywhere. Devices still register, but `pushConfigured` is `false`, and calls behave as in the table without push.

### Android permissions the app asks for

- **Notifications** (Android 13+): asked once, when calls are available to the user. Without it, no incoming-call notification can be shown.
- **Full-screen notifications** (Android 14+): Android grants this by default only to calling and alarm apps. Otherwise the call shows as a heads-up notification with Answer and Decline instead of filling the lock screen. The user can allow it in *Settings › Apps › School OS › Full-screen notifications*.
- **Microphone**: asked when the first call is placed or answered.

## Other requirements for calls outside one network

- **HTTPS:** the API must be served over HTTPS (the socket is then `wss://`) to work from the internet. Browsers allow the microphone only on HTTPS.
- **TURN:** phones on mobile data usually cannot connect directly, so they need a TURN relay with a public IP. See `docs/VOICE_CALLS.md` › coturn.
- **LAN-only setups** (one school network, HTTP): calls work between devices on the same network, without TURN. Push still needs internet access from the API server to Google, and from the phones.

## What has and has not been verified (29 Oct 2026)

Verified on an Android 17 emulator, with the real website in Chromium (fake microphone) calling the app over the LAN against the in-memory demo:

- The notification appears for a call that arrives just after the app is backgrounded.
- **Decline** from the notification: the server records `declined`, and the notification clears.
- A second call right after it rings normally.
- **Answer** from the notification: the call connects, with audio both ways.

Verified automatically (backend tests):

- Push is sent only to the recipient's registered devices, and its payload is limited to what the recipient may see.
- Rejected tokens are removed, and a token moves when another account signs in.
- Push alone authorizes nothing.

**Not verified:** real push delivery (needs your Firebase project), a closed app being woken by push, the lock-screen full-screen presentation on a physical phone, and manufacturer battery restrictions.
