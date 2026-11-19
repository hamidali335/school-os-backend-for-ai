import crypto from 'node:crypto';
import { env, type Env } from '../../config/env';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * ICE servers for one user, with short-lived TURN credentials in coturn's REST format
 * (`use-auth-secret`): username `<expiry unix time>:<opaque user tag>`, credential
 * base64(HMAC-SHA1(secret, username)). The secret never leaves the server, and a credential
 * stops working at its expiry. The user tag is a hash, so the TURN server's logs hold no ids.
 */
export function iceServersFor(
  user: { schoolId: string; userId: string },
  e: Pick<Env, 'CALL_STUN_URLS' | 'CALL_TURN_URLS' | 'CALL_TURN_SECRET' | 'CALL_TURN_TTL_SECONDS'> = env,
  now = Date.now(),
) {
  const iceServers: IceServer[] = [];
  if (e.CALL_STUN_URLS.length) iceServers.push({ urls: [...e.CALL_STUN_URLS] });
  let expiresAt: string | null = null;
  const relay = e.CALL_TURN_URLS.length > 0 && Boolean(e.CALL_TURN_SECRET);
  if (relay) {
    const expiry = Math.floor(now / 1000) + e.CALL_TURN_TTL_SECONDS;
    const tag = crypto.createHash('sha256').update(`${user.schoolId}:${user.userId}`).digest('base64url').slice(0, 16);
    const username = `${expiry}:${tag}`;
    const credential = crypto.createHmac('sha1', e.CALL_TURN_SECRET!).update(username).digest('base64');
    iceServers.push({ urls: [...e.CALL_TURN_URLS], username, credential });
    expiresAt = new Date(expiry * 1000).toISOString();
  }
  return { iceServers, relayAvailable: relay, expiresAt };
}
