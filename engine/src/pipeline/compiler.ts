// Shot plan → MiniMax H3 request. Deterministic on purpose: the same plan always produces the
// same prompt, every H3 rule is checked in code, and the prompt ties each reference file to a
// named character, set or prop ("reference image 2 is Asma").

import { config } from '../config.js';

export const H3 = {
  minSec: 4, maxSec: 15, maxImages: 9, maxVideos: 3, maxAudios: 3, maxVideoSecTotal: 15,
  maxPromptChars: 7000, ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
};

export interface Beat {
  t0: number; t1: number; shot: string; angle?: string; camera?: string; action: string;
  lens?: string; blocking?: string; performance?: string; light?: string;
  dialogue?: { who: string; line: string; delivery?: string }[];
}
export interface ShotPlan {
  duration: number; purpose?: string; characters: string[]; props: string[];
  beats: Beat[]; sound?: string; screen_positions?: string; warnings?: string[];
  covers?: number[];      // action lines of the scene this shot shows
  scene_light?: string;   // the director's light for the scene
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;
/** Seconds needed to speak a line naturally (plus a breath). */
export function speechSeconds(line: string) {
  const cjk = (line.match(CJK) || []).length;
  const w = (line.replace(CJK, ' ').match(/[\p{L}\p{N}'’]+/gu) || []).length;
  return cjk / 4.5 + w / 2.4 + 0.5;
}
export const beatNeeds = (b: Beat) => Math.max(2, (b.dialogue || []).reduce((s, d) => s + speechSeconds(d.line), 0));

/** Normalize beats: whole seconds, contiguous from 0, each long enough for its dialogue; returns the shot duration. */
export function fitBeats(beats: Beat[], wanted: number): { beats: Beat[]; duration: number; overflow: boolean } {
  const bs = beats.filter((b) => b && (b.action || b.dialogue?.length)).map((b) => ({ ...b, dialogue: (b.dialogue || []).filter((d) => d.line?.trim()) }));
  if (!bs.length) return { beats: [], duration: Math.max(H3.minSec, Math.min(H3.maxSec, Math.round(wanted) || 5)), overflow: false };
  // Proposed lengths from the plan, floored by what the dialogue needs.
  let lens = bs.map((b) => Math.max(beatNeeds(b), (+b.t1 - +b.t0) || 0, 2));
  let total = lens.reduce((a, b) => a + b, 0);
  const target = Math.max(H3.minSec, Math.min(H3.maxSec, Math.max(Math.round(wanted) || 0, Math.ceil(total))));
  const need = bs.map(beatNeeds);
  const needTotal = need.reduce((a, b) => a + b, 0);
  const overflow = needTotal > H3.maxSec + 0.01;
  if (total > target) {
    // Shrink beats that have slack, never below their dialogue floor.
    const slack = lens.map((l, i) => Math.max(0, l - need[i]));
    const s = slack.reduce((a, b) => a + b, 0);
    const cut = Math.min(total - target, s);
    lens = lens.map((l, i) => l - (s ? (slack[i] / s) * cut : 0));
  } else if (total < target) {
    lens = lens.map((l) => l + ((target - total) * l) / total);
  }
  // Integer boundaries that sum to the duration.
  const duration = overflow ? H3.maxSec : target;
  const sum = lens.reduce((a, b) => a + b, 0) || 1;
  const last = lens.length - 1;
  const out: Beat[] = []; let t = 0, acc = 0;
  lens.forEach((l, i) => {
    acc += (l * duration) / sum;
    let t1 = i === last ? duration : Math.round(acc);
    t1 = Math.min(Math.max(t1, t + 1), duration - (last - i));
    out.push({ ...bs[i], t0: t, t1 });
    t = t1;
  });
  return { beats: out, duration, overflow };
}

export interface CompileAsset { id: string; kind: string; key: string; name: string; description: string; meta: any; file_key: string | null; parent_key?: string }
export interface CompileInput {
  plan: ShotPlan;
  project: { aspect: string; language: string; style: any; format: string };
  scene: { heading: string; time_of_day: string; int_ext: string };
  set?: CompileAsset | null;           // set or set variant used by the scene
  setMaster?: CompileAsset | null;     // parent set when `set` is a variant
  characters: { key: string; name: string; identity?: CompileAsset | null; look?: CompileAsset | null; voice?: CompileAsset | null }[];
  props: CompileAsset[];
  chainNote?: string | null;           // set when a previous clip is passed as reference video
}
export interface Compiled { prompt: string; images: CompileAsset[]; voices: CompileAsset[]; warnings: string[] }

const clean = (s: any) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.;,]$/, '');
const firstName = (n: string) => clean(n).split(/\s+/)[0] || n;
const hasFile = (a?: CompileAsset | null): a is CompileAsset => !!a && !!a.file_key;
/** Cut a description to at most n characters, at a word boundary. */
const short = (s: string, n: number) => (s.length <= n ? s : n <= 0 ? '' : s.slice(0, n).replace(/\s+\S*$/, '').replace(/[.;,]$/, '') + '…');
/** A shot whose lines and actions alone are over the prompt limit. Retrying can't fix it. */
export class PromptTooLong extends Error { code = 'prompt_too_long'; }

export function compileShot(i: CompileInput): Compiled {
  const warnings: string[] = [];
  const { plan, project } = i;
  const st = project.style || {};
  const onScreen = new Set(plan.characters.map((k) => k.toUpperCase()));
  const speaking = new Set(plan.beats.flatMap((b) => (b.dialogue || []).map((d) => d.who.toUpperCase())));
  const chars = i.characters.filter((c) => onScreen.has(c.key) || speaking.has(c.key));

  // ── Reference images, in priority order, max 9 ──
  const images: CompileAsset[] = [];
  const label = new Map<string, string>();
  const add = (a: CompileAsset | null | undefined, what: string) => {
    if (!hasFile(a) || images.find((x) => x.id === a.id)) return false;
    if (images.length >= H3.maxImages) { warnings.push(`dropped reference (limit 9): ${what}`); return false; }
    images.push(a); label.set(a.id, what); return true;
  };
  add(i.set || i.setMaster, `the location, ${clean((i.set || i.setMaster)!?.name || '')}`);
  for (const c of chars) add(c.identity, `${firstName(c.name)}'s face and identity`);
  for (const c of chars) add(c.look, `${firstName(c.name)}'s full outfit`);
  for (const p of i.props.filter((p) => plan.props.map((x) => x.toUpperCase()).includes(p.key))) add(p, `the ${clean(p.name).toLowerCase()}`);
  for (const c of chars) if (!hasFile(c.identity) && !hasFile(c.look)) warnings.push(`${c.name} has no approved reference image`);
  if (!hasFile(i.set) && !hasFile(i.setMaster)) warnings.push('the set has no approved reference image');

  // ── Reference audio: voices of characters who speak in this shot, max 3 ──
  const voices: CompileAsset[] = [];
  for (const c of chars) if (speaking.has(c.key) && hasFile(c.voice)) {
    if (voices.length < H3.maxAudios) voices.push(c.voice); else warnings.push(`voice reference dropped for ${c.name} (limit 3)`);
  }

  // ── Prompt text ──
  const ar = project.aspect === '9:16' ? 'Vertical 9:16' : project.aspect;
  const cuts = plan.beats.length - 1;
  // Descriptions (characters, outfits, the set, objects) are cut to `cap` characters when the prompt must shrink.
  const head = (cap: number): string[] => {
  const d = (x: any) => short(clean(x), cap);
  const L: string[] = [];
  L.push(`${ar} live-action cinematic drama shot, ${plan.duration} seconds${cuts > 0 ? `, with ${cuts} hard cut${cuts > 1 ? 's' : ''}` : ', one continuous take'}. Photorealistic, natural performances, no animation.`);
  if (images.length) L.push(`References: ${images.map((a, n) => `reference image ${n + 1} is ${label.get(a.id)}`).join('; ')}.`);
  if (voices.length) L.push(`Voices: ${voices.map((v, n) => `${firstName(chars.find((c) => c.voice?.id === v.id)?.name || v.name)} speaks with the voice in reference audio ${n + 1}`).join('; ')}.`);
  if (i.chainNote) L.push(i.chainNote);

  const set = i.set || i.setMaster;
  const place = [clean(i.scene.heading)];
  if (set) {
    place.push(i.setMaster && i.set && i.set.id !== i.setMaster.id ? `${d(i.setMaster.description)}. Now: ${d(i.set.description)}` : d(set.description));
    const layout = d((i.setMaster || set)?.meta?.layout);
    if (layout) place.push(`Layout: ${layout}`);
  }
  L.push(`Setting: ${place.filter(Boolean).join('. ')}.`);

  if (chars.length) {
    L.push(`Characters: ${chars.map((c) => {
      const refs = [c.identity, c.look].filter(hasFile).map((a) => `reference image ${images.findIndex((x) => x.id === a.id) + 1}`).filter((s) => !s.endsWith(' 0'));
      const idText = d(c.identity?.description);
      const wear = d(c.look?.description);
      return `${c.name}${refs.length ? ` (${refs.join(' and ')})` : ''}: ${idText || 'as established'}${wear ? `; wearing ${wear}` : ''}`;
    }).join('. ')}.`);
  }
  if (plan.screen_positions) L.push(`Screen positions, keep consistent: ${d(plan.screen_positions)}.`);
  const propsIn = i.props.filter((p) => plan.props.map((x) => x.toUpperCase()).includes(p.key));
  if (propsIn.length) L.push(`Key objects: ${propsIn.map((p) => `${clean(p.name)}${hasFile(p) ? ` (reference image ${images.findIndex((x) => x.id === p.id) + 1})` : ''}: ${d(p.description)}`).join('. ')}.`);

  if (plan.scene_light) L.push(`Light: ${d(plan.scene_light)}.`);
  return L;
  };

  // The timeline is built at the richest detail that fits H3's prompt limit: level 2 has everything,
  // level 1 drops blocking and performance notes, level 0 also drops lens and per-beat light.
  const who = (k: string) => i.characters.find((c) => c.key === k.toUpperCase())?.name || k;
  const timeline = (level: number) => plan.beats.map((b, n) => {
    const lens = level >= 1 && b.lens ? (/\blens\b/i.test(b.lens) ? clean(b.lens) : `${clean(b.lens).replace(new RegExp(`^${b.shot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '')} lens`) : '';
    const framing = [b.shot, lens, b.angle && !/^eye.?level$/i.test(b.angle) ? `${b.angle} angle` : '', b.camera].filter(Boolean).map(clean).join(', ');
    const parts = [`${b.t0}–${b.t1}s: ${n ? 'Cut to ' : ''}${framing}.`];
    if (level >= 2 && b.blocking) parts.push(`${clean(b.blocking)}.`);
    parts.push(`${clean(b.action)}.`);
    if (level >= 2 && b.performance) parts.push(`${clean(b.performance)}.`);
    if (level >= 1 && b.light) parts.push(`Light: ${clean(b.light)}.`);
    const lines = (b.dialogue || []).map((d) => `${firstName(who(d.who))}${d.delivery ? `, ${clean(d.delivery)},` : ''} says: "${String(d.line).trim().replace(/"/g, "'")}"`).join(' ');
    if (lines) parts.push(lines);
    return parts.join(' ');
  });

  const hasDialogue = plan.beats.some((b) => b.dialogue?.length);
  const after: string[] = [];
  after.push(`Sound: ${plan.sound ? clean(plan.sound) + '. ' : ''}${hasDialogue ? `Dialogue spoken on camera in ${project.language}, clear and lip-synced, natural pace.` : 'No dialogue.'} No background music.`);
  const look = [st.camera, st.lighting, st.grade].filter(Boolean).map(clean).join('; ');
  const film = [st.palette && `palette: ${clean(st.palette)}`, st.texture && clean(st.texture)].filter(Boolean).join('; ');
  if (look || film) after.push(`Look: ${[look, film].filter(Boolean).join('. ')}.`);
  if (st.look) after.push(`Mood: ${clean(st.look)}.`);
  const avoid = [...new Set(['on-screen text', 'subtitles', 'captions', 'watermarks', 'logos', ...String(st.negative || '').split(/[,;]/).map((x) => clean(x).toLowerCase()).filter(Boolean)])];
  after.push(`Avoid: ${avoid.join(', ')}; faces or outfits that differ from the references; extra people in frame unless described.`);

  // Shrink in order of least harm: per-beat detail first, then the length of every description, then the mood and look
  // lines. The timeline's spoken lines and actions are never cut: a shot that can't fit them is refused, not mangled.
  const lines = plan.beats.flatMap((b) => (b.dialogue || []).map((x) => String(x.line).trim().replace(/"/g, "'"))).filter(Boolean);
  const build = (level: number, cap: number, extras: boolean) => [...head(cap), 'Timeline:', ...timeline(level), ...(extras ? after : after.slice(0, 1).concat(after.slice(-1)))].join('\n');
  const steps: [number, number, boolean, string | null][] = [
    [2, Infinity, true, null], [1, Infinity, true, 'detail level 1'], [0, Infinity, true, 'detail level 0'],
    [0, 400, true, 'descriptions cut to 400 characters'], [0, 220, true, 'descriptions cut to 220 characters'],
    [0, 120, true, 'descriptions cut to 120 characters'], [0, 120, false, 'look and mood dropped'], [0, 60, false, 'descriptions cut to 60 characters'],
  ];
  let prompt = '';
  for (const [level, cap, extras, note] of steps) {
    prompt = build(level, cap, extras);
    if (note) warnings.push(`prompt shortened to fit H3's limit (${note})`);
    if (prompt.length <= H3.maxPromptChars) break;
  }
  if (prompt.length > H3.maxPromptChars) {
    throw new PromptTooLong(`This shot's directions are too long for the video model even after shortening every description (${prompt.length} of ${H3.maxPromptChars} characters). Split the shot or shorten its lines and actions.`);
  }
  const lost = lines.filter((l) => !prompt.includes(l));
  if (lost.length) throw new PromptTooLong(`Shortening the prompt would drop ${lost.length} spoken line(s); split the shot instead.`);
  return { prompt, images, voices, warnings };
}

/** Final validation of the request body against MiniMax's documented rules. Throws on violations. */
/** What each H3 model renders (MiniMax's reference, November 2026): its resolutions and its shortest clip. */
export const H3_MODELS: Record<string, { resolutions: string[]; minSec: number }> = {
  'MiniMax-H3': { resolutions: ['768P', '2K'], minSec: 4 },
  'MiniMax-H3-Highspeed': { resolutions: ['480P', '768P'], minSec: 4 },
  'MiniMax-H3-Lite': { resolutions: ['480P', '768P'], minSec: 4 },
  'MiniMax-H3-Max': { resolutions: ['480P', '768P'], minSec: 5 },
};

export function validateH3(body: any) {
  const errs: string[] = [];
  const model = H3_MODELS[body.model];
  if (!model) errs.push(`unknown model ${body.model}`);
  const texts = (body.content || []).filter((c: any) => c.type === 'text');
  if (texts.length !== 1 || !texts[0].text?.trim()) errs.push('exactly one non-empty text item is required');
  if (texts[0]?.text?.length > H3.maxPromptChars) errs.push('prompt over 7000 characters');
  if (!Number.isInteger(body.duration) || body.duration < (model?.minSec ?? 4) || body.duration > 15) errs.push(`duration ${body.duration} out of range`);
  if (model && !model.resolutions.includes(body.resolution)) errs.push(`resolution ${body.resolution} not supported by ${body.model}`);
  if (body.ratio && !H3.ratios.includes(body.ratio)) errs.push(`ratio ${body.ratio} invalid`);
  const roles = (body.content || []).map((c: any) => c.role).filter(Boolean);
  const i2v = roles.some((r: string) => r === 'first_frame' || r === 'last_frame');
  const ref = roles.some((r: string) => r.startsWith('reference_'));
  if (i2v && ref) errs.push('first/last frame and reference media cannot be mixed');
  const count = (r: string) => roles.filter((x: string) => x === r).length;
  if (count('reference_image') > 9) errs.push('more than 9 reference images');
  if (count('reference_video') > 3) errs.push('more than 3 reference videos');
  if (count('reference_audio') > 3) errs.push('more than 3 reference audio clips');
  if (count('reference_audio') && !count('reference_image') && !count('reference_video')) errs.push('reference audio needs an image or video reference with it');
  if (errs.length) throw new Error('H3 request invalid: ' + errs.join('; '));
  return true;
}

export const costOf = (resolution: string, seconds: number) => (config.pricing.videoPerSecond[resolution] ?? config.pricing.videoPerSecond['768P']) * seconds;
