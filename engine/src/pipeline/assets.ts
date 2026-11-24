// Locked reference assets. Order matters: a character's master portrait is made first and
// every wardrobe look is generated FROM it; a set's master plate comes first and every
// variant (night, reverse angle) is generated FROM it. That is what keeps identity stable.

import { sql } from '../db.js';
import { storage } from '../storage.js';
import { config } from '../config.js';
import { PermanentError, enqueue, type Again, type JobCtx } from '../queue.js';
import { generateImage, placeRefsSupported, type RefImage } from '../providers/images.js';
import { voiceDesign, ProviderError } from '../providers/minimax.js';
import { mockVoice } from '../providers/mock.js';
import { recordUsage } from '../usage.js';
import { jobKey, paid, requireCredit } from '../billing.js';
import { trimAudio, probe, withMediaSlot } from '../media/ffmpeg.js';
import { prepImage, prepAudio } from './clips.js';
import { moderate, refusal } from '../moderation.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';

const clean = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
const styleLine = (st: any) => [st?.camera, st?.lighting, st?.grade].filter(Boolean).map(clean).join('; ');

/**
 * Join prompt parts in order, within the image model's limit (MiniMax image-01 reads 1500 characters).
 * Parts marked optional are dropped, last first, until the prompt fits; required parts always stay.
 */
export function fitPrompt(parts: (string | { text: string; optional: true } | false | null | undefined)[], limit = 1500): string {
  const items = parts.filter(Boolean).map((p) => (typeof p === 'string' ? { text: p, optional: false } : (p as { text: string; optional: boolean })))
    .map((p) => ({ ...p, text: clean(p.text) })).filter((p) => p.text);
  const join = (xs: typeof items) => xs.map((x) => (/[.!?]$/.test(x.text) ? x.text : x.text + '.')).join(' ');
  let kept = [...items];
  for (let i = kept.length - 1; join(kept).length > limit && i >= 0; i--) if (kept[i].optional) kept.splice(i, 1);
  const out = join(kept);
  return out.length > limit ? out.slice(0, limit - 1) : out;
}
const opt = (text: string | false | null | undefined) => (text ? { text, optional: true as const } : null);

/** Build the generation prompt for an asset from its (editable) description, most important details first. */
export function assetPrompt(a: any, parent: any, p: any, note?: string | null): string {
  if (a.meta?.prompt_override) return note ? `${a.meta.prompt_override} Revision: ${clean(note)}.` : a.meta.prompt_override;
  const rev = note ? `Revision requested: ${clean(note)}` : null; // required, so it survives fitting
  const st = p.style || {};
  const world = clean(p.story_bible?.world || '').slice(0, 260);
  const film = [st.palette && `palette of ${clean(st.palette)}`, st.texture && clean(st.texture)].filter(Boolean).join('; ');
  const realSkin = 'Real skin with pores, fine lines and natural unevenness; natural hair with flyaways; no beauty retouching, no airbrushing, no glamour light; an ordinary real person, not a model';
  switch (a.kind) {
    case 'character': {
      const wardrobe = clean(a.meta?.default_wardrobe || '');
      return fitPrompt([
        `Photorealistic casting headshot of ${clean(a.name)}`,
        rev,
        clean(a.description),
        wardrobe && `Wearing ${wardrobe}`,
        'Head and shoulders to mid-chest, facing the camera, eyes to lens, relaxed neutral expression',
        '85mm portrait lens at eye level, soft window light from camera left with gentle fill, plain mid-grey seamless backdrop, sharp focus on the eyes',
        realSkin,
        opt(world && `A person of this world: ${world}`),
        'No text, no watermark, no props, no other people',
      ]);
    }
    case 'look':
      return fitPrompt([
        'Full-length wardrobe reference photograph of the same person as the reference image: identical face, age, skin, hair and build',
        rev,
        `Wearing ${clean(a.description)}`,
        'Standing naturally in a relaxed three-quarter pose, the whole body from head to shoes in frame, arms loose',
        'Plain light-grey studio backdrop, soft even light, true fabric colours and textures, wear and creases where described',
        opt(parent && `Identity: ${clean(parent.description)}`),
        opt(film && `Film look: ${film}`),
        'No text, no other people',
      ]);
    case 'location': {
      const layout = clean(a.meta?.layout || '');
      const ext = /EXT/.test(a.meta?.int_ext || '') && !/INT/.test(a.meta?.int_ext || '');
      return fitPrompt([
        `Photorealistic production-design plate of an empty film set: ${clean(a.name)}`,
        rev,
        clean(a.description),
        layout && `Layout: ${layout}`,
        `Wide 24mm lens at standing eye height, deep focus, the whole space visible with clear ${ext ? 'ground' : 'floor'} area where actors will stand`,
        'Lived-in and real: true materials, wear, dust and everyday clutter; practical light sources visible and motivating the light',
        opt(styleLine(st) && `Cinematography: ${styleLine(st)}`),
        opt(film && `Film look: ${film}`),
        opt(world && `Place and period: ${world}`),
        'No people, no animals; any signage decorative and unreadable; no captions, no watermarks',
      ]);
    }
    case 'set_variant':
      return fitPrompt([
        `The exact same location as the reference image, with the same architecture, layout, furniture, materials and camera position, now shown as: ${clean(a.name.split('—').pop() || a.name)}`,
        rev,
        `What changes: ${clean(a.description)}`,
        'Photorealistic film still of the empty set',
        opt(parent && `Location: ${clean(parent.description)}`),
        opt(styleLine(st) && `Cinematography: ${styleLine(st)}`),
        opt(film && `Film look: ${film}`),
        'No people; any signage decorative and unreadable; no captions, no watermarks',
      ]);
    case 'prop':
      return fitPrompt([
        `Photorealistic hero-prop reference photograph of ${clean(a.name)}`,
        rev,
        clean(a.description),
        'A single object, entirely in frame, three-quarter view, macro-sharp detail on a neutral light-grey surface, soft even light, true colours, visible wear and history',
        opt(world && `It belongs to this world: ${world}`),
        'No hands, no readable text, nothing else in frame',
      ]);
    default:
      return clean(a.description);
  }
}

const aspectFor = (kind: string, projectAspect: string) =>
  kind === 'character' ? '3:4' : kind === 'look' ? '2:3' : kind === 'prop' ? '1:1' : projectAspect;

async function refFor(asset: any, role: RefImage['role']): Promise<RefImage | null> {
  if (!asset?.file_key) return null;
  return { mime: asset.mime || 'image/png', data: await storage.get(asset.file_key), role };
}

/**
 * `covered` means the setup fee already pays for this generation (the automatic first pass of a vibe project);
 * everything a customer asks for afterwards is charged, and refunded if it fails.
 */
export async function generateAsset(assetId: string, ctx?: JobCtx, o: { note?: string; covered?: boolean } = {}): Promise<any | Again> {
  const [a] = await sql`select * from assets where id = ${assetId}`;
  if (!a) throw new PermanentError('asset not found');
  if (a.status === 'approved') return { skipped: 'approved' };
  const [p] = await sql`select * from projects where id = ${a.project_id}`;
  const parent = a.parent_id ? (await sql`select * from assets where id = ${a.parent_id}`)[0] : null;

  // Variants and looks wait for their parent image.
  if ((a.kind === 'look' || a.kind === 'set_variant') && !parent?.file_key) {
    if (parent && parent.status === 'failed') throw new PermanentError(`${parent.name} failed, so ${a.name} cannot be generated from it`, 'dependency_failed');
    return { again: 15, progress: `waiting for ${parent?.name || 'parent'}` };
  }

  await sql`update assets set status = 'generating', error = null, updated_at = now() where id = ${assetId}`;
  await ctx?.progress(`Generating ${a.name}`);
  const voice = a.kind === 'voice';
  const price = o.covered ? 0 : voice ? config.credits.actions.voice : config.credits.actions.image;
  try {
    return await paid(p.owner_id, price, voice ? 'voice_gen' : 'image_gen', assetId, () => produce(), jobKey(ctx?.job, voice ? 'voice_gen' : 'image_gen'));
  } catch (e: any) {
    const permanent = e instanceof PermanentError || (e instanceof ProviderError && !e.retryable);
    if (permanent) {
      await sql`update assets set status = 'failed', error = ${String(e.message).slice(0, 500)}, updated_at = now() where id = ${assetId}`;
      throw e instanceof PermanentError ? e : new PermanentError(e.message, e.code);
    }
    await sql`update assets set status = 'planned', error = ${String(e.message).slice(0, 500)}, updated_at = now() where id = ${assetId}`;
    throw e;
  }

  async function produce(): Promise<any> {
    if (voice) return await generateVoice(a, p, parent);

    // Default wardrobe for the master portrait = the character's first look.
    if (a.kind === 'character' && !a.meta?.default_wardrobe) {
      const [look] = await sql`select description from assets where parent_id = ${a.id} and kind = 'look' order by appearances desc limit 1`;
      if (look?.description) a.meta = { ...a.meta, default_wardrobe: look.description };
    }
    const prompt = assetPrompt(a, parent, p, o.note);
    const refs: RefImage[] = [];
    if (a.kind === 'look') { const r = await refFor(parent, 'identity'); if (r) refs.push(r); }
    if (a.kind === 'set_variant') { const r = await refFor(parent, 'place'); if (r) refs.push(r); }
    if (a.kind === 'character' && a.meta?.likeness_key && a.meta?.consent?.confirmed) {
      refs.push({ mime: 'image/png', data: await storage.get(a.meta.likeness_key), role: 'identity' });
    }
    const img = await generateImage({ prompt, aspect: aspectFor(a.kind, p.aspect), refs, label: [a.name, a.kind, a.key] });
    // MiniMax image-01 only locks people: without a Gemini or OpenAI key a variant's room picture can't be passed on,
    // so the new picture matches its parent by description only. Say so on the asset instead of hiding it.
    const droppedPlace = refs.some((r) => r.role === 'place') && !placeRefsSupported(img.provider);
    const ext = img.mime === 'image/jpeg' ? 'jpg' : 'png';
    const key = `projects/${a.project_id}/assets/${a.id}/${Date.now()}.${ext}`;
    await storage.put(key, img.data, img.mime);
    const history = a.file_key ? [...(a.history || []), { file_key: a.file_key, at: new Date().toISOString(), note: o.note || null }].slice(-12) : a.history || [];
    await sql`update assets set status = 'review', file_key = ${key}, mime = ${img.mime}, prompt = ${prompt}, history = ${sql.json(history)},
      meta = (meta - 'place_ref_missing' - 'stale_parent') || ${sql.json({ provider: img.provider, ...(parent ? { parent_file: parent.file_key } : {}), ...(a.meta?.default_wardrobe ? { default_wardrobe: a.meta.default_wardrobe } : {}), ...(droppedPlace ? { place_ref_missing: true } : {}) })}, updated_at = now() where id = ${assetId}`;
    await recordUsage({ ownerId: p.owner_id, projectId: p.id, kind: 'image', units: 1, cost: img.provider === 'mock' ? 0 : config.pricing.imageEach, ref: assetId });
    return { file_key: key };
  }
}

async function generateVoice(a: any, p: any, character: any) {
  const brief = [clean(a.description), character ? `Speaks as: ${clean(character.name)}.` : '', p.language && p.language !== 'English' ? `Speaks ${p.language}.` : ''].filter(Boolean).join(' ');
  const line = a.meta?.sample_line || `This is how I sound when nobody is listening.`;
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  try {
    const got = config.mock ? await mockVoice(line) : await voiceDesign(brief, line);
    const raw = join(dir, 'raw.mp3'), out = join(dir, 'ref.mp3');
    await writeFile(raw, got.audio);
    await trimAudio(raw, out, 14);
    const info = await probe(out);
    const key = `projects/${a.project_id}/assets/${a.id}/${Date.now()}.mp3`;
    await storage.put(key, await readFile(out), 'audio/mpeg');
    await sql`update assets set status = 'review', file_key = ${key}, mime = 'audio/mpeg', prompt = ${brief},
      meta = meta || ${sql.json({ voice_id: got.voiceId, seconds: +info.duration.toFixed(2) })}, updated_at = now() where id = ${a.id}`;
    await recordUsage({ ownerId: p.owner_id, projectId: p.id, kind: 'voice', units: line.length, cost: config.mock ? 0 : line.length * config.pricing.voicePerChar, ref: a.id });
    return { file_key: key, voice_id: got.voiceId };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Queue generation for every asset that still needs an image or voice, masters first. */
export async function queueAllAssets(projectId: string, o: { kinds?: string[]; covered?: boolean } = {}) {
  const rows = await sql`select id, kind from assets where project_id = ${projectId} and status in ('planned','failed')
    and coalesce((meta->>'unused')::boolean, false) = false ${o.kinds?.length ? sql`and kind in ${sql(o.kinds)}` : sql``}
    order by case kind when 'character' then 0 when 'location' then 1 when 'prop' then 2 when 'voice' then 3 else 4 end, priority desc`;
  if (!o.covered && rows.length) { // a customer's bulk request: they must be able to afford all of it, up front
    const [pr] = await sql`select owner_id from projects where id = ${projectId}`;
    const total = rows.reduce((t: number, r: any) => t + (r.kind === 'voice' ? config.credits.actions.voice : config.credits.actions.image), 0);
    await requireCredit(pr.owner_id, total);
  }
  for (const r of rows) {
    await sql`update assets set status = 'planned', error = null where id = ${r.id}`;
    await enqueue('asset.generate', { assetId: r.id, covered: !!o.covered }, { projectId, dedupeKey: `asset:${r.id}`, maxAttempts: 3 });
  }
  return rows.length;
}

export async function approveAsset(assetId: string, o: { covered?: boolean } = {}) {
  const [a] = await sql`update assets set status = 'approved', approved_at = now(), updated_at = now(), meta = meta - 'stale_parent'
    where id = ${assetId} and file_key is not null returning *`;
  if (!a) throw new PermanentError('Nothing to approve yet: generate or upload the asset first.', 'bad_state');
  // Children generated from an older parent image are now out of date.
  if (a.kind === 'character' || a.kind === 'location') {
    const stale = await sql`update assets set status = 'planned' where parent_id = ${a.id} and status in ('review','failed') and kind <> 'voice'
      and file_key is not null and (meta->>'parent_file') is distinct from ${a.file_key} returning id`;
    for (const s of stale) await enqueue('asset.generate', { assetId: s.id, covered: !!o.covered }, { projectId: a.project_id, dedupeKey: `asset:${s.id}` });
    // An approved look or variant made from the old picture no longer matches it. Covered work (autopilot) redoes it for
    // free; otherwise it goes back to review, marked out of date, so it isn't sent to the video model until the customer
    // approves it again or pays to redo it.
    const outdated = await sql`update assets set ${o.covered ? sql`status = 'planned'` : sql`status = 'review', meta = meta || ${sql.json({ stale_parent: true })}`}, updated_at = now()
      where parent_id = ${a.id} and status = 'approved' and kind <> 'voice' and file_key is not null
        and (meta->>'parent_file') is distinct from ${a.file_key} returning id`;
    if (o.covered) for (const s of outdated) await enqueue('asset.generate', { assetId: s.id, covered: true }, { projectId: a.project_id, dedupeKey: `asset:${s.id}` });
  }
  return a;
}

/**
 * Store a user-supplied file as the asset (an actor photo, a real location, a recorded voice). What is stored is
 * never the bytes the customer sent: a picture is re-encoded to a JPEG and a voice to an MP3 (see clips.ts), which
 * proves the file is what it claims to be and drops metadata such as GPS. A picture goes to the video model as a
 * reference, so it is content-checked like any other customer content.
 */
export async function uploadAsset(assetId: string, data: Buffer, mime: string, uid: string, consent: boolean) {
  const [a] = await sql`select * from assets where id = ${assetId}`;
  if (!a) throw new PermanentError('asset not found');
  const isPerson = a.kind === 'character' || a.kind === 'look' || a.kind === 'voice';
  if (isPerson && !consent) throw new PermanentError('Uploading a real person\'s face or voice needs consent=true: confirm you have that person\'s permission.', 'consent_required');
  let key: string;
  const dir = await mkdtemp(join(tmpdir(), 'upasset-'));
  try {
    if (a.kind === 'voice') {
      const v = await withMediaSlot(() => prepAudio(data, dir, 14, 'The voice recording'));
      key = `projects/${a.project_id}/assets/${a.id}/upload-${Date.now()}.mp3`;
      await storage.put(key, await readFile(v.file), 'audio/mpeg'); mime = 'audio/mpeg';
    } else {
      const im = await withMediaSlot(() => prepImage(data, dir, 'upload'));
      const v = await moderate({ ownerId: uid, projectId: a.project_id, text: `Reference picture uploaded for a ${a.kind}: ${a.name}`, images: [{ mime: 'image/jpeg', data: im.small }] });
      if (!v.allowed) throw refusal(v);
      key = `projects/${a.project_id}/assets/${a.id}/upload-${Date.now()}.jpg`;
      await storage.put(key, await readFile(im.file), 'image/jpeg'); mime = 'image/jpeg';
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  const history = a.file_key ? [...(a.history || []), { file_key: a.file_key, at: new Date().toISOString(), note: 'replaced by upload' }].slice(-12) : a.history || [];
  const meta = { ...(a.meta || {}), source: 'upload', ...(isPerson ? { consent: { confirmed: true, by: uid, at: new Date().toISOString() } } : {}) };
  const [row] = await sql`update assets set file_key = ${key}, mime = ${mime}, status = 'review', history = ${sql.json(history)}, meta = ${sql.json(meta)}, error = null, updated_at = now()
    where id = ${assetId} returning *`;
  return row;
}
