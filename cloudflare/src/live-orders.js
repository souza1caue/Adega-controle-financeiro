// This channel carries invalidation signals only. Authorized state stays in D1.
const encoder = new TextEncoder();
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function liveTicket(secret, now = Date.now()) {
  const payload = encode(encoder.encode(JSON.stringify({ exp: now + 60000, nonce: crypto.randomUUID() })));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyLiveTicket(secret, ticket, now = Date.now()) {
  try {
    const [payload, signature, extra] = ticket.split('.');
    if (extra || !await crypto.subtle.verify('HMAC', await key(secret), decode(signature), encoder.encode(payload))) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(decode(payload)));
    return Number.isFinite(exp) && exp > now && exp <= now + 60000;
  } catch { return false; }
}
export function orderHub(env) {
  return env.ORDER_LIVE.get(env.ORDER_LIVE.idFromName('orders-v1'));
}
export async function publishChanges(env) {
  if (!env.ORDER_LIVE) return;
  const response = await orderHub(env).fetch('https://orders.internal/publish', { method: 'POST' });
  if (!response.ok) throw new Error('Live order notification failed');
}

export class OrderLive {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/publish' && request.method === 'POST') {
      for (const socket of this.state.getWebSockets()) {
        try {
          if (socket.deserializeAttachment().expires <= Date.now()) socket.close(1000, 'Renew authorization');
          else socket.send('changed');
        } catch { try { socket.close(1011, 'Reconnect'); } catch {} }
      }
      return new Response(null, { status: 204 });
    }
    if (path !== '/connect' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ expires: Date.now() + 300000 });
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(socket) { socket.close(1008, 'Server notifications only'); }
  webSocketClose(socket, code) { socket.close(code === 1005 ? 1000 : code); }
  webSocketError(socket) { socket.close(1011, 'Reconnect'); }
}
