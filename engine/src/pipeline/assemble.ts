// Assembly: approved takes → one finished episode. The clips are joined whole, in order: each is only brought to the
// same size, frame rate and audio format so they can be joined, and the episode's loudness is set to streaming level
// (-14 LUFS). Nothing is trimmed. Captions and music are the creator's to add; burned-in subtitles (timed from the
// plan), fades and a ducked music bed remain options a cut can ask for.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { sql, begin } from '../db.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { PermanentError, enqueue } from '../queue.js';
import { ffmpeg, probe, subtitleFontsDir, textFilter, thumbnail } from '../media/ffmpeg.js';
import { speechSeconds, type ShotPlan } from './compiler.js';

// Every option ends up inside an FFmpeg filter graph, so only typed, bounded values are accepted.
const CutOptionsSchema = z.object({
  burn_subtitles: z.boolean().optional(),                 // draw subtitles into the picture (social feeds play muted)
  music_key: z.string().regex(/^[\w\-./]+$/).nullable().optional(), // storage key of an uploaded music bed
  music_volume: z.number().min(0).max(1).optional(),      // before ducking (default 0.22)
  fade: z.boolean().optional(),                           // fade in from and out to black
  loudness: z.number().min(-30).max(-5).optional(),       // integrated LUFS target, default -14
});
export type CutOptions = z.infer<typeof CutOptionsSchema>;

export function parseCutOptions(raw: unknown, projectId: string): CutOptions {
  const r = CutOptionsSchema.safeParse(raw ?? {});
  if (!r.success) throw new PermanentError('Invalid cut options: ' + r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '), 'bad_input');
  if (r.data.music_key && !r.data.music_key.startsWith(`projects/${projectId}/music/`)) throw new PermanentError('music_key must be a music file uploaded to this project.', 'bad_input');
  return r.data;
}

/**
 * Ask for an edit and queue it. An identical edit of the same episode that is still waiting to start is reused (it
 * will pick up the newest clips anyway), so asking a hundred times makes one edit, not a hundred. The cut and its job
 * are created together, under a lock on the episode.
 */
export async function queueCut(episodeId: string, kind: 'final' | 'preview', rawOptions: unknown): Promise<{ cut: any; job_id: number | null; reused: boolean }> {
  const [e] = await sql`select project_id from episodes where id = ${episodeId}`;
  if (!e) throw new PermanentError('episode not found', 'not_found');
  const options = parseCutOptions(rawOptions, e.project_id);
  const shots = await sql`select id, code, status, approved_take_id from shots where episode_id = ${episodeId} order by idx`;
  if (!shots.length) throw new PermanentError('This episode has no shots yet.', 'bad_state');
  if (kind === 'final') {
    const missing = shots.filter((s: any) => s.status !== 'approved' || !s.approved_take_id);
    if (missing.length) throw Object.assign(new PermanentError(`${missing.length} shot(s) still need approval: ${missing.slice(0, 12).map((s: any) => s.code).join(', ')}${missing.length > 12 ? '…' : ''}`, 'not_approved'), { missing: missing.map((s: any) => s.id) });
  }
  return begin(async (tx) => {
    await tx`select id from episodes where id = ${episodeId} for update`;
    const [waiting] = await tx`select * from cuts where episode_id = ${episodeId} and status = 'queued' and kind = ${kind} and options = ${tx.json(options as any)}::jsonb order by created_at desc limit 1`;
    if (waiting) return { cut: waiting, job_id: null, reused: true };
    const [cut] = await tx`insert into cuts (project_id, episode_id, kind, options) values (${e.project_id}, ${episodeId}, ${kind}, ${tx.json(options as any)}) returning *`;
    const job_id = await enqueue('cut.assemble', { cutId: cut.id }, { projectId: e.project_id, maxAttempts: 2, tx });
    return { cut, job_id, reused: false };
  });
}

/** Ask for an assembly. Final cuts need every shot approved; previews use whatever is newest. (Tests use this; the engine uses queueCut.) */
export async function requestCut(episodeId: string, kind: 'final' | 'preview', rawOptions: unknown) {
  const [e] = await sql`select project_id from episodes where id = ${episodeId}`;
  const options = parseCutOptions(rawOptions, e.project_id);
  const shots = await sql`select id, code, status, approved_take_id from shots where episode_id = ${episodeId} order by idx`;
  if (!shots.length) throw new PermanentError('This episode has no shots yet.', 'bad_state');
  if (kind === 'final') {
    const missing = shots.filter((s: any) => s.status !== 'approved' || !s.approved_take_id);
    if (missing.length) throw Object.assign(new PermanentError(`${missing.length} shot(s) still need approval: ${missing.slice(0, 12).map((s: any) => s.code).join(', ')}${missing.length > 12 ? '…' : ''}`, 'not_approved'), { missing: missing.map((s: any) => s.id) });
  }
  const [c] = await sql`insert into cuts (project_id, episode_id, kind, options) values (${e.project_id}, ${episodeId}, ${kind}, ${sql.json(options as any)}) returning *`;
  return c;
}

const srtTime = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};
function wrap(text: string, max: number) {
  const words = text.split(/\s+/); const lines: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  // Keep at most two lines on screen: rebalance if longer.
  if (lines.length > 2) { const all = text.split(/\s+/); const h = Math.ceil(all.length / 2); return [all.slice(0, h).join(' '), all.slice(h).join(' ')].join('\n'); }
  return lines.join('\n');
}

/** Subtitle cues from shot plans, stretched to the real clip lengths. */
export function buildSrt(clips: { plan: ShotPlan; start: number; actual: number }[], maxChars: number) {
  const cues: { a: number; b: number; text: string }[] = [];
  for (const c of clips) {
    const k = c.plan.duration ? c.actual / c.plan.duration : 1;
    for (const b of c.plan.beats || []) {
      const ds = b.dialogue || []; if (!ds.length) continue;
      const need = ds.map((d) => speechSeconds(d.line));
      const tot = need.reduce((x, y) => x + y, 0) || 1;
      let t = c.start + b.t0 * k; const span = (b.t1 - b.t0) * k;
      ds.forEach((d, i) => {
        const len = (span * need[i]) / tot;
        // Long lines become several cues so no subtitle holds more than two lines.
        const chunks = d.line.length > maxChars * 2 ? (d.line.match(/[^.!?,;:]+[.!?,;:]*\s*/g) || [d.line]).reduce((acc: string[], s) => { const l = acc.length - 1; if (l >= 0 && (acc[l] + s).length <= maxChars * 2) acc[l] += s; else acc.push(s); return acc; }, []) : [d.line];
        const tl = chunks.reduce((x, s) => x + s.length, 0) || 1;
        let u = t;
        for (const ch of chunks) { const l = (len * ch.length) / tl; cues.push({ a: u + 0.05, b: u + l - 0.05, text: wrap(ch.trim(), maxChars) }); u += l; }
        t += len;
      });
    }
  }
  return cues.map((q, i) => `${i + 1}\n${srtTime(q.a)} --> ${srtTime(Math.max(q.a + 0.6, q.b))}\n${q.text}\n`).join('\n');
}

export async function assembleCut(cutId: string, progress: (s: string) => Promise<void>) {
  const [cut] = await sql`select * from cuts where id = ${cutId}`;
  if (!cut) throw new PermanentError('cut not found');
  await sql`update cuts set status = 'running', error = null where id = ${cutId}`;
  const [ep] = await sql`select * from episodes where id = ${cut.episode_id}`;
  const [p] = await sql`select * from projects where id = ${cut.project_id}`;
  const o: CutOptions = { burn_subtitles: p.settings?.burn_subtitles ?? false, fade: false, music_volume: 0.22, loudness: -14, ...parseCutOptions(cut.options, p.id) };
  const shots = await sql`select s.*, t.file_key take_file, t.media take_media from shots s
    left join lateral (
      select file_key, media from takes where
        ${cut.kind === 'final' ? sql`id = s.approved_take_id` : sql`shot_id = s.id and status = 'succeeded' and (id = s.approved_take_id or s.approved_take_id is null)`}
      order by (id = s.approved_take_id) desc nulls last, n desc limit 1) t on true
    where s.episode_id = ${cut.episode_id} order by s.idx`;
  if (cut.kind === 'final' && shots.some((s: any) => !s.take_file)) throw new PermanentError('A shot lost its approved take; approve it again.', 'not_approved');

  const dir = await mkdtemp(join(tmpdir(), 'cut-'));
  try {
    // Output geometry: the first real take decides; otherwise derive from the aspect ratio.
    const firstMedia = shots.find((s: any) => s.take_media?.width)?.take_media;
    const [aw, ah] = String(p.aspect).split(':').map(Number);
    let W = firstMedia?.width || (aw >= ah ? 1280 : 720), H = firstMedia?.height || (aw >= ah ? Math.round((1280 * ah) / aw) : Math.round((720 * ah) / aw));
    W -= W % 2; H -= H % 2;
    const FPS = 24;

    const parts: string[] = [];
    const clips: { plan: ShotPlan; start: number; actual: number }[] = [];
    let t = 0;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      await progress(`Preparing clip ${i + 1} of ${shots.length}`);
      const out = join(dir, `n${String(i).padStart(4, '0')}.mp4`);
      if (s.take_file) {
        const src = await storage.toLocal(s.take_file, dir);
        const info = s.take_media?.duration ? s.take_media : await probe(src);
        const args = ['-i', src];
        if (!info.has_audio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        args.push('-map', '0:v:0', '-map', info.has_audio ? '0:a:0' : '1:a:0',
          '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`,
          '-af', 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo',
          '-t', String(info.duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', out);
        await ffmpeg(args);
      } else {
        // Preview only: a slate where a shot has no take yet.
        const slate = await textFilter(`${out}.ass`, [{ text: `SHOT ${s.code} NOT RENDERED`, size: Math.round(H / 24), top: 0, plus: 0, middle: true }], W, H);
        await ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}:d=${s.duration}`, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-vf', slate,
          '-t', String(s.duration), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
      }
      const real = (await probe(out)).duration;
      clips.push({ plan: s.plan, start: t, actual: real });
      t += real;
      parts.push(out);
    }

    await progress('Joining clips');
    const list = join(dir, 'list.txt');
    await writeFile(list, parts.map((f) => `file '${f}'`).join('\n'));
    const joined = join(dir, 'joined.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    const total = t;

    // Subtitles only when a cut asks for them: then they're burned in and the .srt file comes with the cut.
    const portrait = H > W;
    const srt = o.burn_subtitles ? buildSrt(clips, portrait ? 30 : 42) : '';
    const srtFile = join(dir, 'subs.srt');
    if (srt.trim()) await writeFile(srtFile, srt);

    await progress('Mixing and finishing');
    const vf: string[] = [];
    if (srt.trim()) {
      const fs = portrait ? 11 : 16, mv = portrait ? 40 : 22;
      vf.push(`subtitles=subs.srt${subtitleFontsDir()}:force_style='FontName=${config.ffmpeg.font},FontSize=${fs},PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=1.6,Shadow=0,MarginV=${mv},Alignment=2,Bold=1'`);
    }
    if (o.fade) vf.push(`fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, total - 0.6).toFixed(2)}:d=0.6`);
    const args = ['-i', joined];
    let af = '';
    if (o.music_key) {
      const music = await storage.toLocal(o.music_key, dir);
      args.push('-stream_loop', '-1', '-i', music);
      // Music ducks under dialogue (sidechain), then everything is normalized together.
      af = `[0:a]asplit=2[dia][key];[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=${o.music_volume ?? 0.22}[mus];` +
        `[mus][key]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=450[duck];` +
        `[dia][duck]amix=inputs=2:duration=first:normalize=0,`;
    } else af = '[0:a]';
    af += `loudnorm=I=${o.loudness ?? -14}:TP=-1.5:LRA=11${o.fade ? `,afade=t=in:st=0:d=0.4,afade=t=out:st=${Math.max(0, total - 0.6).toFixed(2)}:d=0.6` : ''}[aout]`;
    const final = join(dir, 'final.mp4');
    args.push('-filter_complex', af, '-map', '0:v:0', '-map', '[aout]');
    // A plain join keeps the joined picture as it is (no second encode); subtitles or fades need one.
    if (vf.length) args.push('-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
    else args.push('-c:v', 'copy');
    args.push('-t', total.toFixed(3), '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', final);
    await ffmpeg(args, { timeoutMs: 60 * 60_000, cwd: dir }); // cwd: subtitles= takes a relative path (absolute Windows paths break its parser)

    const base = `projects/${p.id}/cuts/${cutId}`;
    const thumb = join(dir, 'poster.jpg');
    await thumbnail(final, thumb, 0.1);
    await storage.putFile(`${base}.mp4`, final, 'video/mp4');
    if (srt.trim()) await storage.putFile(`${base}.srt`, srtFile, 'application/x-subrip');
    await storage.putFile(`${base}.jpg`, thumb, 'image/jpeg');
    const info = await probe(final);
    await sql`update cuts set status = 'done', file_key = ${base + '.mp4'}, srt_key = ${srt.trim() ? base + '.srt' : null}, thumb_key = ${base + '.jpg'},
      duration = ${info.duration}, finished_at = now() where id = ${cutId}`;
    if (cut.kind === 'final') await sql`update episodes set status = 'assembled', updated_at = now() where id = ${ep.id}`;
    const [left] = await sql`select count(*)::int n from episodes where project_id = ${p.id} and status <> 'assembled'`;
    if (!left.n) await sql`update projects set status = 'done', updated_at = now() where id = ${p.id}`;
    return { file_key: base + '.mp4', duration: info.duration, shots: shots.length };
  } catch (e: any) {
    await sql`update cuts set status = 'failed', error = ${String(e.message).slice(0, 1000)}, finished_at = now() where id = ${cutId}`;
    throw e;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
