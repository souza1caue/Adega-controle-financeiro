// Open operational entry is intentional; administrative access remains separate.
const encoder = new TextEncoder();
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function operationAccess(role, secret, now = Date.now()) {
  if (!['front', 'kitchen'].includes(role)) throw new Error('Escolha Caixa ou Cozinha.');
  const payload = encode(encoder.encode(JSON.stringify({ role, exp: now + 86400000, id: crypto.randomUUID() })));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(`operation.${payload}`));
  return `operation.${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyOperationAccess(token, secret, now = Date.now()) {
  try {
    const [prefix, payload, signature, extra] = token.split('.');
    if (prefix !== 'operation' || extra || !secret) return null;
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(signature), encoder.encode(`operation.${payload}`))) return null;
    const access = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!['front', 'kitchen'].includes(access.role) || !Number.isFinite(access.exp) || access.exp <= now || access.exp > now + 86400000 || typeof access.id !== 'string') return null;
    return { id: access.id, role: access.role, label: access.role === 'front' ? 'Caixa' : 'Cozinha', open_access: true };
  } catch { return null; }
}
