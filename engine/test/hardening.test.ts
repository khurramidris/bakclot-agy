// Unit checks for the launch hardening: what counts as an upload, the job lanes, script limits and fees,
// the content check's reading of long texts, and the H3 model table. No database, no network.
import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { sniff, isUpload, UPLOAD_FORMATS, safeInput, imageSize } = await import('../src/media/ffmpeg.js');
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { blockedKinds, laneOf } = await import('../src/queue.js');
const { countScenes, checkScript, breakdownFee, planFee } = await import('../src/pipeline/limits.js');
const { chunksOf } = await import('../src/moderation.js');
const { validateH3 } = await import('../src/pipeline/compiler.js');
const { config } = await import('../src/config.js');

const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(32)]);

test('uploads are recognised by their first bytes, whatever they are called', () => {
  assert.equal(sniff(pad(bytes([0xff, 0xd8, 0xff, 0xe0]))), 'jpeg');
  assert.equal(sniff(pad(bytes('\x89PNG\r\n\x1a\n'))), 'png');
  assert.equal(sniff(pad(bytes('RIFF', [0, 0, 0, 0], 'WEBP'))), 'webp');
  assert.equal(sniff(pad(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))), 'wav');
  assert.equal(sniff(pad(bytes([0, 0, 0, 0x20], 'ftypisom'))), 'mp4');
  assert.equal(sniff(pad(bytes([0x1a, 0x45, 0xdf, 0xa3]))), 'webm');
  assert.equal(sniff(pad(bytes('ID3', [4, 0, 0]))), 'mp3');
  assert.equal(sniff(pad(bytes([0xff, 0xfb, 0x90, 0x00]))), 'mp3');
  assert.equal(sniff(pad(bytes([0xff, 0xf1, 0x50, 0x80]))), 'aac');
  // The things FFmpeg would otherwise happily "open": playlists, manifests, scripts, vector pictures.
  for (const hostile of ['#EXTM3U\n#EXT-X-VERSION:3\n', '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">', 'ffconcat version 1.0\nfile /etc/passwd\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>', 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n', '']) {
    assert.equal(sniff(pad(Buffer.from(hostile))), null, hostile.slice(0, 20));
  }
  assert.equal(isUpload('image', pad(bytes([0xff, 0xd8, 0xff, 0xe0]))), true);
  assert.equal(isUpload('image', pad(bytes([0, 0, 0, 0x20], 'ftypisom'))), false, 'a video is not a picture');
  assert.equal(isUpload('video', pad(bytes([0, 0, 0, 0x20], 'ftypqt  '))), true);
  assert.equal(isUpload('audio', pad(bytes([0, 0, 0, 0x20], 'ftypM4A '))), true);
  assert.equal(isUpload('audio', pad(bytes('#EXTM3U\n'))), false);
});

test('FFmpeg is told which readers it may use for a customer file', () => {
  const args = safeInput('image', '/tmp/x.in');
  assert.deepEqual(args.slice(0, 4), ['-protocol_whitelist', 'file,crypto,data', '-format_whitelist', UPLOAD_FORMATS.image]);
  assert.ok(args.includes('-max_pixels'));
  assert.deepEqual(args.slice(-2), ['-i', '/tmp/x.in']);
  for (const kind of ['image', 'video', 'audio'] as const) {
    for (const banned of ['hls', 'dash', 'concat', 'svg_pipe', 'sdp', 'rtsp', 'lavfi', 'tty', 'imf']) assert.ok(!UPLOAD_FORMATS[kind].split(',').includes(banned), `${kind} must not allow ${banned}`);
  }
});

test('each kind of job has its own lane, and a full lane blocks only its own kinds', () => {
  assert.equal(laneOf('project.autopilot'), 'llm');
  assert.equal(laneOf('take.poll'), 'render');
  assert.equal(laneOf('cut.assemble'), 'media');
  assert.equal(laneOf('asset.generate'), 'assets');
  assert.equal(laneOf('webhook.deliver'), 'io');
  const kinds = ['project.autopilot', 'episode.plan', 'take.submit', 'take.poll', 'cut.assemble', 'asset.generate', 'system.cleanup'];
  const slots = { llm: 2, render: 4, assets: 2, media: 1, io: 2 };
  assert.deepEqual(blockedKinds({}, slots, kinds), []);
  // Every writing slot busy: writing and planning wait, collecting clips and editing carry on.
  assert.deepEqual(blockedKinds({ llm: 2 }, slots, kinds), ['project.autopilot', 'episode.plan']);
  assert.deepEqual(blockedKinds({ llm: 2, media: 1 }, slots, kinds), ['project.autopilot', 'episode.plan', 'cut.assemble']);
  assert.deepEqual(blockedKinds({ render: 3 }, slots, kinds), []);
  assert.ok(config.lanes.llm >= 1 && config.lanes.render >= 1 && config.lanes.media >= 1);
});

test('a script is counted in scenes, kept to one episode, and priced by its length', () => {
  const scene = (i: number) => `${i % 2 ? 'EXT' : 'INT'}. PLACE ${i} - DAY\n\nSomething happens.\n\nAMIRA\nA line.\n\n`;
  const script = (n: number) => Array.from({ length: n }, (_, i) => scene(i)).join('');
  assert.equal(countScenes(script(7)), 7);
  assert.equal(countScenes('Just a paragraph with no headings.'), 1);
  assert.equal(countScenes('   '), 0);
  assert.equal(checkScript(script(5)), script(5));
  assert.throws(() => checkScript('x'.repeat(config.scripts.maxEpisodeChars + 1)), /Split it into more episodes/);
  assert.throws(() => checkScript(script(config.scripts.maxEpisodeScenes + 1)), /scenes; one episode holds/);
  assert.throws(() => checkScript(42 as any), /must be text/);
  // The flat fees cover a normal episode; a long one pays for every scene past what's included.
  const c = config.credits;
  assert.equal(breakdownFee(3), c.actions.breakdown);
  assert.equal(breakdownFee(c.breakdownIncludedScenes), c.actions.breakdown);
  assert.equal(breakdownFee(c.breakdownIncludedScenes + 40), +(c.actions.breakdown + 40 * c.breakdownPerSceneUsd).toFixed(2));
  assert.equal(planFee(c.planIncludedScenes), c.actions.plan);
  assert.equal(planFee(c.planIncludedScenes + 10), +(c.actions.plan + 10 * c.planPerSceneUsd).toFixed(2));
  // The audit's case: 300 scenes used to cost $1.25 to break down and plan. Now the two fees cover what it costs to do.
  assert.ok(breakdownFee(300) + planFee(300) > 20, `${breakdownFee(300) + planFee(300)}`);
});

test('a long text is content-checked in pieces, none longer than one reading, none of it skipped', () => {
  const para = (i: number) => `Paragraph ${i}. ${'word '.repeat(300)}`.trim();
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
  const parts = chunksOf(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 6000));
  assert.equal(parts.join('\n\n'), text, 'the pieces put back together are the whole text');
  // One paragraph longer than a piece is cut, not dropped.
  const giant = 'y'.repeat(15000);
  assert.equal(chunksOf(giant).join(''), giant);
  assert.deepEqual(chunksOf('short'), ['short']);
});

test('every H3 model MiniMax sells is accepted with its own sizes and shortest clip', () => {
  const body = (model: string, resolution: string, duration = 5) => ({ model, resolution, duration, ratio: '9:16', content: [{ type: 'text', text: 'A kite over a beach.' }] });
  assert.ok(validateH3(body('MiniMax-H3', '768P')));
  assert.ok(validateH3(body('MiniMax-H3', '2K')));
  assert.ok(validateH3(body('MiniMax-H3-Highspeed', '768P', 4)));
  assert.ok(validateH3(body('MiniMax-H3-Lite', '480P')));
  assert.ok(validateH3(body('MiniMax-H3-Max', '768P', 5)));
  assert.throws(() => validateH3(body('MiniMax-H3-Lite', '2K')), /not supported by MiniMax-H3-Lite/);
  assert.throws(() => validateH3(body('MiniMax-H3-Max', '768P', 4)), /duration 4 out of range/);
  assert.throws(() => validateH3(body('Some-Other-Model', '768P')), /unknown model/);
});

test('the size of a picture is read from its header, without decoding it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imgsize-'));
  for (const [ext, extra] of [['jpg', []], ['png', []], ['webp', []], ['webp', ['-lossless', '1']]] as [string, string[]][]) {
    const f = join(dir, `a${extra.length ? '-lossless' : ''}.${ext}`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1234x567:d=1', '-frames:v', '1', ...extra, f]);
    const [width, height] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number);
    assert.ok(width === 1234 && height >= 566, `${f}: ${width}x${height}`);
    assert.deepEqual(imageSize(readFileSync(f)), { width, height }, f);
  }
  assert.equal(imageSize(Buffer.from('#EXTM3U\n' + ' '.repeat(40))), null);
});
