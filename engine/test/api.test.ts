// Unit checks for the public API's building blocks: which addresses count as the public internet, keys, data URIs,
// which kind of clip a request asks for, the model's tags, webhook signatures and the error mapping. No database.
import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';

const { isPublicAddress, parseIPv6, decodeDataUri, checkUrl, FetchError } = await import('../src/api/net.js');
const { newKey, keyHash, keyPreview, KEY_RX, base62, newWebhookSecret } = await import('../src/api/keys.js');
const { inferMode } = await import('../src/api/videos.js');
const { normalizeRefs } = await import('../src/pipeline/clips.js');
const { sign, signatureHeader, verifySignature, SCHEDULE } = await import('../src/api/webhooks.js');
const { toApiError, ApiError } = await import('../src/api/errors.js');
const { PermanentError } = await import('../src/queue.js');
const { VideoCreate, FilmCreate } = await import('../src/api/schemas.js');

test('only addresses on the public internet may be fetched or called', () => {
  const cases: [string, boolean][] = [
    ['8.8.8.8', true], ['1.1.1.1', true], ['93.184.216.34', true], ['172.32.0.1', true], ['100.128.0.1', true],
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.0.1', false], ['172.31.255.255', false], ['192.168.1.1', false],
    ['169.254.169.254', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false], ['255.255.255.255', false],
    ['198.18.0.1', false], ['192.0.2.1', false], ['203.0.113.9', false],
    ['2001:4860:4860::8888', true], ['2606:4700:4700::1111', true], ['::ffff:8.8.8.8', true], ['64:ff9b::8.8.8.8', true],
    ['::1', false], ['::', false], ['::ffff:127.0.0.1', false], ['::ffff:7f00:1', false], ['fc00::1', false], ['fd12:3456::1', false],
    ['fe80::1', false], ['fe80::1%eth0', false], ['ff02::1', false], ['2001:db8::1', false], ['2002:7f00:1::1', false],
    ['2001::1', false], ['64:ff9b::127.0.0.1', false], ['::127.0.0.1', false], ['[::1]', false], ['not-an-ip', false],
  ];
  for (const [ip, want] of cases) assert.equal(isPublicAddress(ip), want, ip);
  assert.deepEqual(parseIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 1, 2, 3, 4]);
  assert.equal(parseIPv6('1::2::3'), null);
  assert.equal(parseIPv6('12345::'), null);
});

test('URLs: https only, no credentials, no private or local names', () => {
  assert.equal(checkUrl('https://cdn.example.com/a.jpg').hostname, 'cdn.example.com');
  for (const bad of ['http://example.com/a.jpg', 'ftp://example.com/a', 'https://user:pass@example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a',
    'https://169.254.169.254/latest/meta-data', 'https://printer.local/a', 'https://db.internal/a', 'not a url', 'x'.repeat(5000)]) {
    assert.throws(() => checkUrl(bad), FetchError, bad);
  }
});

test('data URIs decode with a size cap', () => {
  const d = decodeDataUri(`data:image/png;base64,${Buffer.from('hello').toString('base64')}`, 1024)!;
  assert.equal(d.mime, 'image/png'); assert.equal(d.data.toString(), 'hello');
  assert.equal(decodeDataUri('https://example.com/a.png', 1024), null);
  assert.throws(() => decodeDataUri('data:image/png,plain-text', 1024), /base64/);
  assert.throws(() => decodeDataUri(`data:image/png;base64,${'A'.repeat(4000)}`, 1024), /over/);
  assert.throws(() => decodeDataUri('data:image/png;base64,***', 1024), /not valid base64/);
});

test('keys look the same every time, are stored only as a hash, and show only a prefix', () => {
  const k = newKey();
  assert.match(k, KEY_RX);
  assert.notEqual(newKey(), k);
  assert.equal(keyHash(k), keyHash(k)); assert.equal(keyHash(k).length, 64); assert.notEqual(keyHash(k), keyHash(newKey()));
  assert.equal(keyPreview(k), k.slice(0, 12) + '…');
  assert.match(newWebhookSecret(), /^whsec_[0-9A-Za-z]{32}$/);
  const s = base62(20000);
  const counts = new Map<string, number>(); for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  assert.equal(counts.size, 62);
  assert.ok(Math.max(...counts.values()) / Math.min(...counts.values()) < 1.6, 'evenly spread');
});

test('the kind of clip follows the inputs, and impossible combinations are named', () => {
  const u = { url: 'https://x/a' };
  assert.equal(inferMode({}), 'text');
  assert.equal(inferMode({ first_frame: u }), 'image');
  assert.equal(inferMode({ images: [u] }), 'reference');
  assert.equal(inferMode({ images: [u], audio: u }), 'reference');
  assert.equal(inferMode({ video: u, images: [u] }), 'remix');
  const param = (f: () => unknown) => { try { f(); } catch (e: any) { return e.param; } return null; };
  assert.equal(param(() => inferMode({ first_frame: u, images: [u] })), 'first_frame');
  assert.equal(param(() => inferMode({ audio: u })), 'audio');
  assert.equal(param(() => inferMode({ video: u, audio: u })), 'audio');
  assert.equal(param(() => inferMode({ video: u, images: Array(9).fill(u) })), 'images');
});

test('the model’s own tags and plain words both become the wording H3 needs', () => {
  assert.equal(normalizeRefs('<Picture 2> hands <Image 1> the box'), 'reference image 2 hands reference image 1 the box');
  assert.equal(normalizeRefs('remix <Video 1> with <Audio 1>'), 'remix reference video 1 with reference audio 1');
  assert.equal(normalizeRefs('the woman in image 2 speaks with voice 1'), 'the woman in reference image 2 speaks with reference audio 1');
  assert.equal(normalizeRefs('reference image 3 stays'), 'reference image 3 stays');
});

test('webhook signatures: Stripe-style, checked against a known value, tolerant only to 5 minutes', () => {
  const secret = 'whsec_test', body = '{"id":"evt_1"}', t = 1_700_000_000;
  const known = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(sign(secret, t, body), known);
  assert.equal(signatureHeader(secret, body, t), `t=${t},v1=${known}`);
  assert.ok(verifySignature(secret, `t=${t},v1=${known}`, body, 300, t * 1000 + 60_000));
  assert.ok(!verifySignature(secret, `t=${t},v1=${known}`, body, 300, t * 1000 + 600_000), 'too old');
  assert.ok(!verifySignature(secret, `t=${t},v1=${known}`, body + ' ', 300, t * 1000), 'body changed');
  assert.ok(!verifySignature('whsec_other', `t=${t},v1=${known}`, body, 300, t * 1000), 'another secret');
  assert.ok(SCHEDULE.reduce((a, b) => a + b, 0) < 24 * 3600, 'every retry happens while the links in the object still work');
});

test('every internal error becomes the documented error shape, without internal detail', () => {
  const zod = (() => { try { VideoCreate.parse({ prompt: 'ok kite', duration: 99 }); } catch (e) { return e; } })();
  assert.deepEqual([toApiError(zod).status, toApiError(zod).param], [400, 'duration']);
  const extra = (() => { try { FilmCreate.parse({ prompt: 'a long enough idea', nope: 1 }); } catch (e) { return e; } })();
  assert.match(toApiError(extra).message, /unknown field/);
  assert.equal(toApiError(new PermanentError('no money', 'insufficient_credit')).status, 402);
  assert.equal(toApiError(new PermanentError('nope', 'sensitive_content')).type, 'content_refused');
  assert.equal(toApiError(new PermanentError('busy', 'bad_state')).status, 409);
  assert.equal(toApiError(Object.assign(new Error('deadlock detected'), { code: '40P01' })).status, 503);
  const boom = toApiError(new Error('relation "credit_accounts" does not exist at host db.internal'));
  assert.equal(boom.status, 500); assert.doesNotMatch(boom.message, /credit_accounts|db\.internal/);
  const own = new ApiError(429, 'rate_limited', 'rate_limited', 'slow down');
  assert.equal(toApiError(own), own);
});
