import assert from 'node:assert/strict';
import { requireInstallation } from './.build/installation-auth.js';

const secret = 'synthetic_fuzz_credential_0123456789';
const allowed = 'https://fuzz-client.invalid';
const disallowed = 'https://other-client.invalid';
const refererOrigins = new Map([
  [allowed + '/page', allowed],
  [disallowed + '/page', disallowed],
  ['https://fuzz-client.invalid.evil.invalid/page', 'https://fuzz-client.invalid.evil.invalid'],
  ['https://other-client.invalid/https://fuzz-client.invalid/page', disallowed],
]);
const referers = [null, ...refererOrigins.keys(), 'malformed-url'];
const credential = { id: 'fuzz-installation', token: secret, origins: [allowed] };

export async function fuzz(data) {
  if (data.length < 4 || data.length > 8192) return;
  const auth = [null, `Bearer ${secret}`, `bearer ${secret}`, 'Bearer wrong', `Bearer ${secret}wrong`, `Bearer  ${secret} `][data[0] % 6];
  const origin = [null, allowed, disallowed, 'null', allowed + '/path', 'https://fuzz-client.invalid.evil.invalid'][data[1] % 6];
  const referer = referers[data[2] % referers.length];
  const trusted = Boolean(data[3] & 1), crossSite = Boolean(data[3] & 2);
  const configKind = (data[3] >> 2) % 4;
  const entry = { ...credential, originPolicy: trusted ? 'trusted-proxy' : 'require-origin' };
  const config = [JSON.stringify([entry]), JSON.stringify([entry, entry]), '{}', data.subarray(4).toString('utf8')][configKind];
  const headers = new Headers();
  if (auth !== null) headers.set('Authorization', auth);
  if (origin !== null) headers.set('Origin', origin);
  if (referer !== null) headers.set('Referer', referer);
  if (crossSite) headers.set('Sec-Fetch-Site', 'cross-site');
  const request = new Request('https://swop-fuzz.invalid/session', { headers });
  const result = requireInstallation(request, { INSTALLATION_CREDENTIALS_JSON: config });
  if (result instanceof Response) {
    assert.ok([401,403,503].includes(result.status));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const body = await result.text();
    assert.equal(body.includes(secret), false, 'credentials must not leak');
    if (auth === null) assert.equal(result.status, 401);
    if (configKind === 1 || configKind === 2) assert.equal(result.status, auth === null ? 401 : 503);
  } else {
    assert.equal(crossSite, false);
    const selected = JSON.parse(config).find(item => item.id === result.installationId);
    assert.ok(selected && auth?.startsWith('Bearer ') && auth.slice(7).trim() === selected.token);
    // Independent oracle: exact generated fixture identity, not URL substring checks.
    const provenance = origin ?? refererOrigins.get(referer) ?? null;
    assert.ok(selected.origins.includes(provenance) || (selected.originPolicy === 'trusted-proxy' && origin === null && referer === null));
  }
  if (configKind === 0) {
    const tokenValid = auth?.startsWith('Bearer ') && auth.slice(7).trim() === secret;
    const originValid = origin === allowed || (origin === null && referer === allowed + '/page') || (trusted && origin === null && referer === null);
    const expected = !tokenValid ? 401 : (!originValid || crossSite ? 403 : 200);
    assert.equal(result instanceof Response ? result.status : 200, expected);
  }
}
