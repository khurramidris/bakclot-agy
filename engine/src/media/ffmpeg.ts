import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';

export function run(bin: string, args: string[], o: { timeoutMs?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: o.cwd });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 20 * 60_000);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${bin} exited ${code}: ${err.split('\n').filter(Boolean).slice(-6).join(' | ')}`));
    });
  });
}

/** A path as an FFmpeg filter option value: forward slashes, drive colon escaped, quoted. */
const filterPath = (p: string) => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, '')}'`;
/** The font for drawtext: the bundled file when one is set, else a system font by name. */
export const drawFont = () => (config.ffmpeg.fontFile ? `fontfile=${filterPath(config.ffmpeg.fontFile)}` : `font='${config.ffmpeg.font}'`);
/** Extra option for the subtitles filter so libass finds the bundled font. */
export const subtitleFontsDir = () => (config.ffmpeg.fontsDir ? `:fontsdir=${filterPath(config.ffmpeg.fontsDir)}` : '');

export const ffmpeg = (args: string[], o?: { timeoutMs?: number; cwd?: string }) => run(config.ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], o);

export interface MediaInfo {
  duration: number; width: number; height: number; fps: number;
  has_audio: boolean; vcodec: string; acodec: string | null; size: number;
}

// ───────── customer uploads ─────────
// A file a customer sends is hostile until proven otherwise. FFmpeg will happily treat a "picture" as a streaming
// manifest and go fetch the addresses inside it (found in the 2026-11-13 audit: the DASH reader ignores the protocol
// list), and a tiny file can decode to gigabytes. So: (1) the first bytes must be a real picture, video or audio file,
// (2) FFmpeg may only use the readers for those formats, (3) only local files, (4) a bounded number of pixels, and
// (5) only a few uploads are decoded at once.

export type UploadKind = 'image' | 'video' | 'audio';
/** The FFmpeg readers allowed per kind of upload. Anything else (playlists, manifests, SVG, scripts) is refused. */
export const UPLOAD_FORMATS: Record<UploadKind, string> = {
  image: 'image2,jpeg_pipe,png_pipe,webp_pipe,mjpeg',
  video: 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
  audio: 'mp3,wav,mov,mp4,m4a,3gp,3g2,mj2,ogg,flac,aac',
};
export const MAX_IMAGE_PIXELS = 50_000_000; // 50 megapixels: far above any camera phone, far below a decompression bomb
export const MAX_VIDEO_SIDE = 4320;         // up to 8K UHD's short side; longer sides are scaled down anyway

/** What a file really is, from its first bytes. null = not something we accept. */
export function sniff(b: Buffer): 'jpeg' | 'png' | 'webp' | 'mp4' | 'webm' | 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac' | null {
  if (b.length < 12) return null;
  const s = (a: number, z: number) => b.toString('latin1', a, z);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (s(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(s(4, 8))) return 'mp4'; // MP4, MOV, M4A, 3GP
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';   // WebM, Matroska
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return ((b[1] >> 1) & 3) === 0 ? 'aac' : 'mp3'; // frame sync: ADTS has layer 0
  return null;
}
const ACCEPTS: Record<UploadKind, string[]> = {
  image: ['jpeg', 'png', 'webp'], video: ['mp4', 'webm'], audio: ['mp3', 'wav', 'mp4', 'ogg', 'flac', 'aac'],
};
/** Whether these bytes are a file of this kind that we accept. */
export const isUpload = (kind: UploadKind, data: Buffer) => ACCEPTS[kind].includes(sniff(data) ?? '');

/**
 * A picture's size from its header alone (JPEG, PNG, WebP), without decoding it. Used to refuse a picture that would
 * decode to gigabytes before FFmpeg opens it. null when the header can't be read (FFmpeg then decides).
 */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  try {
    const kind = sniff(b);
    if (kind === 'png') return b.toString('latin1', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
    if (kind === 'webp') {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
      return null;
    }
    if (kind === 'jpeg') {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }                               // fill byte
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; } // markers without a length
        // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

/** FFmpeg input options for a customer's file: these readers only, local files only, bounded pixels. */
export const safeInput = (kind: UploadKind, file: string) => [
  '-protocol_whitelist', 'file,crypto,data', '-format_whitelist', UPLOAD_FORMATS[kind],
  ...(kind === 'image' ? ['-max_pixels', String(MAX_IMAGE_PIXELS)] : []), '-i', file,
];

// Decoding uploads is the engine's biggest burst of memory: a few at a time, the rest wait their turn, and when the
// line is long the caller is told to come back instead of piling up.
let decoding = 0;
const waiting: (() => void)[] = [];
export class Busy extends Error { status = 503; code = 'busy'; constructor() { super('We’re handling a lot of uploads right now. Please try again in a moment.'); } }
export async function withMediaSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (decoding >= config.media.slots) {
    if (waiting.length >= config.media.queue) throw new Busy();
    await new Promise<void>((r) => waiting.push(r));
  }
  decoding++;
  try { return await fn(); } finally { decoding--; waiting.shift()?.(); }
}

/** Read a file's streams. Pass `kind` for anything a customer sent: FFmpeg then reads it only as that kind of file. */
export async function probe(file: string, kind?: UploadKind): Promise<MediaInfo> {
  const guard = kind ? ['-protocol_whitelist', 'file,crypto,data', '-format_whitelist', UPLOAD_FORMATS[kind]] : [];
  const { stdout } = await run(config.ffmpeg.probe, ['-v', 'error', ...guard, '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: kind ? 60_000 : undefined });
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
  const a = (j.streams || []).find((s: any) => s.codec_type === 'audio');
  const fr = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: +(j.format?.duration || v?.duration || 0),
    width: v?.width || 0, height: v?.height || 0,
    fps: fr[1] ? +(fr[0] / fr[1]).toFixed(3) : 0,
    has_audio: !!a, vcodec: v?.codec_name || '', acodec: a?.codec_name || null,
    size: +(j.format?.size || 0),
  };
}

export async function thumbnail(video: string, out: string, at = 0.5) {
  const info = await probe(video).catch(() => null);
  const t = info ? Math.min(Math.max(0, info.duration * at), Math.max(0, info.duration - 0.1)) : 0;
  await ffmpeg(['-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]);
}

/**
 * Cut an audio file to [2, 15] s as MiniMax requires for reference audio. `upload` = the input came from a customer:
 * it is then read only as an audio file (see safeInput).
 */
export async function trimAudio(input: string, out: string, maxSec = 14, upload = false) {
  const src = upload ? safeInput('audio', input) : ['-i', input];
  await ffmpeg([...src, '-vn', '-t', String(maxSec), '-ac', '1', '-ar', '44100', '-b:a', '128k', out]);
  const i = await probe(out);
  if (i.duration < 2) {
    // Too short for MiniMax: loop it up to 2+ seconds (from our own re-encoded copy, never the upload).
    await ffmpeg(['-stream_loop', '3', '-i', out, '-t', '3', '-ac', '1', '-ar', '44100', out + '.tmp.mp3']);
    await ffmpeg(['-i', out + '.tmp.mp3', '-c', 'copy', out]);
  }
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%').replace(/,/g, '\\,');

export interface TextLine {
  text: string; size: number;
  top: number; plus: number; // vertical position of the text's top edge: h * top + plus pixels
  middle?: boolean;           // centre the line vertically instead (top and plus are ignored)
  box?: boolean;              // dark box behind the text
}

/**
 * Text drawn into the picture, as an FFmpeg filter. Uses `drawtext` normally. Some FFmpeg builds (the one the desktop
 * app ships) don't include it, so when a bundled fonts folder is configured the text is written as an ASS subtitle file
 * and drawn with libass, which every build has because burned-in subtitles need it anyway.
 */
export async function textFilter(assFile: string, lines: TextLine[], w: number, h: number): Promise<string> {
  if (!config.ffmpeg.fontsDir) {
    return lines.map((l) => `drawtext=${drawFont()}:text='${esc(l.text)}':fontcolor=white:fontsize=${l.size}${l.box ? ':box=1:boxcolor=black@0.45:boxborderw=8' : ''}:x=(w-text_w)/2:y=${l.middle ? '(h-text_h)/2' : `h*${l.top}+${l.plus}`}`).join(',');
  }
  const font = config.ffmpeg.font;
  const clean = (t: string) => t.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Plain,${font},40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1`,
    `Style: Box,${font},40,&H00FFFFFF,&H00FFFFFF,&H73000000,&H00000000,0,0,0,0,100,100,0,0,3,8,0,8,10,10,10,1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines.map((l) => {
      const y = Math.round(l.middle ? h / 2 : h * l.top + l.plus);
      return `Dialogue: 0,0:00:00.00,9:59:59.00,${l.box ? 'Box' : 'Plain'},,0,0,0,,{\\${l.middle ? 'an5' : 'an8'}\\pos(${Math.round(w / 2)},${y})\\fs${l.size}}${clean(l.text)}`;
    }),
    '',
  ].join('\n');
  await writeFile(assFile, ass);
  return `ass=${filterPath(assFile)}${subtitleFontsDir()}`;
}

/** Placeholder still, used by mock providers. */
export async function placeholderImage(out: string, lines: string[], w = 768, h = 1024, color = '#2b3a55') {
  const txt = await textFilter(`${out}.ass`, lines.slice(0, 6).map((l, i) => ({ text: l.slice(0, 60), size: i ? 24 : 40, top: 0.35, plus: i * 48 })), w, h);
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}`, '-vf', txt, '-frames:v', '1', out]);
}

/** Placeholder clip with timecode, a label and a tone, used by mock providers. */
export async function placeholderVideo(out: string, lines: string[], seconds: number, w = 720, h = 1280, withAudio = true) {
  const txt = await textFilter(`${out}.ass`, lines.slice(0, 5).map((l, i) => ({ text: l.slice(0, 48), size: i ? 26 : 42, top: 0.30, plus: i * 56, box: true })), w, h);
  // The running timecode needs drawtext; builds without it just go without.
  const tc = config.ffmpeg.fontsDir ? '' : `,drawtext=${drawFont()}:text='%{pts\\:hms}':fontcolor=yellow:fontsize=28:x=24:y=24`;
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=24:d=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=${220 + Math.round(Math.random() * 440)}:sample_rate=48000:duration=${seconds}`);
  args.push('-vf', `${txt}${tc}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(out);
  await ffmpeg(args);
}
