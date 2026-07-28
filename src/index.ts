/**
 * duo-call - two-person low-latency voice + screen share.
 *
 * The Worker does three things and nothing else:
 *   1. serves the static app
 *   2. mints short-lived Cloudflare TURN credentials
 *   3. hands WebSocket signalling off to a per-room Durable Object
 *
 * No media ever touches this Worker. Audio and video go peer-to-peer
 * (or via Cloudflare's TURN relay if a direct path can't be found).
 */

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

function newRoomId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Landing page: mint an unguessable room and bounce to it.
    if (path === '/' || path === '') {
      return Response.redirect(`${url.origin}/r/${newRoomId()}`, 302);
    }

    // ICE servers (STUN + TURN). Short cache so a reload is cheap.
    if (path === '/api/ice') {
      return handleIce(env, ctx);
    }

    // WebSocket signalling: /api/room/<roomId>
    if (path.startsWith('/api/room/')) {
      const roomId = path.slice('/api/room/'.length);
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response('bad room id', { status: 400 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const id = env.ROOM.idFromName(roomId);
      return env.ROOM.get(id).fetch(request);
    }

    // Room page: /r/<roomId> serves the app shell.
    if (path.startsWith('/r/')) {
      const roomId = path.slice(3);
      if (!ROOM_ID_RE.test(roomId)) {
        return Response.redirect(`${url.origin}/r/${newRoomId()}`, 302);
      }
      const res = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`, request));
      return new Response(res.body, {
        status: res.status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          // Keep the room id out of Referer headers to third parties.
          'referrer-policy': 'no-referrer',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

let iceCache: { body: string; expires: number } | null = null;

async function handleIce(env: Env, ctx: ExecutionContext): Promise<Response> {
  const now = Date.now();
  if (iceCache && iceCache.expires > now) {
    return json(JSON.parse(iceCache.body));
  }

  // Cloudflare's own public STUN, plus Google's as a second opinion.
  const fallback = {
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['stun:stun.l.google.com:19302'] },
    ],
    turn: false,
  };

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return json(fallback);
  }

  try {
    const ttl = 4 * 60 * 60; // 4h - long enough for a work session
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
      },
    );
    if (!res.ok) throw new Error(`turn api ${res.status}`);
    const data = (await res.json()) as { iceServers: unknown };
    const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    const payload = {
      iceServers: [...servers, { urls: ['stun:stun.l.google.com:19302'] }],
      turn: true,
    };
    const body = JSON.stringify(payload);
    // Re-mint well before expiry.
    iceCache = { body, expires: now + (ttl - 600) * 1000 };
    ctx.waitUntil(Promise.resolve());
    return json(payload);
  } catch (err) {
    return json({ ...fallback, error: String(err) });
  }
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/* ------------------------------------------------------------------ *
 * Room - signalling only. Two seats, first-come.                      *
 * ------------------------------------------------------------------ */

interface PeerMeta {
  id: string;
  name: string;
  joinedAt: number;
}

export class Room implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Keep pings cheap: respond to them without waking the isolate's JS.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(JSON.stringify({ t: 'ping' }), JSON.stringify({ t: 'pong' })),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') || 'peer').slice(0, 24);

    const existing = this.state.getWebSockets();
    if (existing.length >= 2) {
      // Drop stale sockets that never closed cleanly, then re-check.
      for (const ws of existing) {
        if (ws.readyState !== WebSocket.OPEN) {
          try { ws.close(1001, 'stale'); } catch { /* ignore */ }
        }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (this.state.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN).length >= 2) {
      // Accept, explain, then close with a code the client can recognise.
      // A plain 409 on the handshake is invisible to the browser WebSocket API.
      server.accept();
      server.send(JSON.stringify({ t: 'full' }));
      server.close(4409, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const meta: PeerMeta = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      joinedAt: Date.now(),
    };

    this.state.acceptWebSocket(server);
    server.serializeAttachment(meta);

    const others = this.peers(server);

    // Perfect-negotiation roles. The peer who was already here is "polite"
    // and yields on collisions; the newcomer is impolite and drives the
    // first offer. Deterministic, so glare can never deadlock.
    server.send(
      JSON.stringify({
        t: 'hello',
        self: meta,
        peers: others.map((o) => o.meta),
        polite: others.length === 0,
        initiator: others.length > 0,
      }),
    );

    for (const other of others) {
      this.safeSend(other.ws, { t: 'peer-join', peer: meta });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'ping') {
      this.safeSend(ws, { t: 'pong' });
      return;
    }
    const from = ws.deserializeAttachment() as PeerMeta | null;
    // Everything else is opaque signalling; relay it verbatim to the other seat.
    for (const other of this.peers(ws)) {
      this.safeSend(other.ws, { ...msg, from: from?.id });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.announceLeave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.announceLeave(ws);
  }

  private announceLeave(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as PeerMeta | null;
    for (const other of this.peers(ws)) {
      this.safeSend(other.ws, { t: 'peer-leave', peer: meta });
    }
  }

  private peers(exclude: WebSocket): { ws: WebSocket; meta: PeerMeta }[] {
    return this.state
      .getWebSockets()
      .filter((w) => w !== exclude)
      .map((w) => ({ ws: w, meta: w.deserializeAttachment() as PeerMeta }))
      .filter((p) => !!p.meta);
  }

  private safeSend(ws: WebSocket, obj: unknown) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket already gone */
    }
  }
}
