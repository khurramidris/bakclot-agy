// Breakdown: screenplay → scenes, then Claude decides which characters, sets, variants,
// wardrobe looks, props and voices need locked references. Code checks and repairs the
// answer so every scene is covered and every appearance is counted.

import { sql, begin } from '../db.js';
import { PermanentError, type JobCtx } from '../queue.js';
import { claudeJSON, llmCost, llmUnits } from '../providers/claude.js';
import { config } from '../config.js';
import { BreakdownSchema } from './schemas.js';
import { recordUsage } from '../usage.js';
import { parseScenes, type BibleCharacter } from './fountain.js';
import { BREAKDOWN_SYSTEM, breakdownPrompt } from './prompts.js';

const up = (s: any) => String(s || '').toUpperCase().trim();
const snake = (s: any) => up(s).replace(/['’]/g, '').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'X';

export interface BreakdownResult {
  style: any;
  characters: { key: string; name: string; is_minor?: boolean; description: string; looks: { key: string; name: string; wardrobe: string; scenes: string[] }[]; voice?: { brief: string; sample_line: string }; scenes: string[] }[];
  sets: { key: string; name: string; building?: string; int_ext?: string; description: string; layout?: string; variants: { key: string; name: string; change: string; scenes: string[] }[]; scenes: string[] }[];
  props: { key: string; name: string; description: string; owner?: string; scenes: string[] }[];
}

export async function runBreakdown(projectId: string, ctx: JobCtx, o: { force?: boolean } = {}) {
  const [p] = await sql`select * from projects where id = ${projectId}`;
  if (!p) throw new PermanentError('project not found');
  const [{ n: takesN }] = await sql`select count(*)::int n from takes where project_id = ${projectId}`;
  if (takesN && !o.force) throw new PermanentError('This project already has rendered takes. Re-run the breakdown with force=true to rebuild scenes (approved assets are kept).', 'conflict');

  await sql`update projects set status = 'breaking_down', updated_at = now() where id = ${projectId}`;
  await ctx.progress('Reading the screenplay');
  const episodes = await sql`select * from episodes where project_id = ${projectId} order by idx`;
  const bibleChars: BibleCharacter[] = (p.story_bible?.characters || []).map((c: any) => ({ ...c, id: up(c.id || c.name) }));

  // 1) Deterministic parse.
  type Sc = ReturnType<typeof parseScenes>[number] & { ref: string; episode: number; episode_id: string };
  const scenes: Sc[] = [];
  for (const e of episodes) {
    for (const s of parseScenes(e.script, bibleChars)) scenes.push({ ...s, ref: `E${e.idx}S${s.idx}`, episode: e.idx, episode_id: e.id });
  }
  if (!scenes.length) throw new PermanentError('No scenes found. Scene headings must start with INT. or EXT.', 'bad_input');

  // 2) Claude breakdown. A long screenplay goes in batches of scenes; each batch sees the designs so far and reuses
  // their keys, and the answers are merged before the repair, so a character or a set is one asset across the film.
  await ctx.progress(`Breaking down ${scenes.length} scenes across ${episodes.length} episode(s)`);
  const size = config.anthropic.breakdownBatchScenes;
  const batches = Array.from({ length: Math.ceil(scenes.length / size) }, (_, i) => scenes.slice(i * size, (i + 1) * size));
  const long = batches.length > 1;
  const answers: any[] = [];
  for (const [i, batch] of batches.entries()) {
    if (long) await ctx.progress(`Breaking down scenes ${i * size + 1} to ${i * size + batch.length} of ${scenes.length}`);
    const sofar = i ? mergeBreakdowns(answers) : null;
    const input = {
      title: p.title, format: p.format, aspect: p.aspect, language: p.language,
      world: p.story_bible?.world || '', style: { ...(sofar?.style || {}), ...(p.style || {}) },
      characters: bibleChars.map((c) => {
        const had = sofar?.characters.find((x: any) => up(x.key || x.name) === up(c.id));
        return {
          key: c.id, name: c.name, age: c.age, role: c.role, voice_notes: c.voice,
          prior_design: had?.description || c.design?.lock || c.description || '',
          prior_looks: had ? had.looks.map((l: any) => ({ key: l.key, name: l.name, wardrobe: l.wardrobe })) : c.design?.looks || [],
        };
      }),
      seeds: sofar ? {
        sets: sofar.sets.map((x: any) => ({ key: x.key, name: x.name, description: x.description, variants: (x.variants || []).map((v: any) => ({ key: v.key, name: v.name })) })),
        props: sofar.props.map((x: any) => ({ key: x.key, name: x.name, description: x.description })),
        other_characters: sofar.characters.filter((x: any) => !bibleChars.some((c) => up(c.id) === up(x.key || x.name))).map((x: any) => ({ key: x.key, name: x.name, description: x.description })),
      } : p.story_bible?.design_seeds || {},
      treatment: treatmentNotes(p.story_bible?.treatment),
      batch: long ? { n: i + 1, of: batches.length } : null,
      scenes: batch.map((s) => ({ ref: s.ref, heading: s.heading, location: s.location, time: s.time, int_ext: s.int_ext, present: s.present, speakers: s.speakers, excerpt: s.body.slice(0, 900) })),
    };
    const res = await claudeJSON<BreakdownResult>({ task: 'breakdown', system: BREAKDOWN_SYSTEM, prompt: breakdownPrompt(input), input, schema: BreakdownSchema as any, effort: config.anthropic.effort, maxTokens: 32000, bulk: long });
    await recordUsage({ ownerId: p.owner_id, projectId, kind: 'llm', units: llmUnits(res.usage), cost: llmCost(res.model, res.usage), ref: long ? `breakdown:${i + 1}` : 'breakdown' });
    answers.push(res.data);
  }
  const bd = repair(long ? mergeBreakdowns(answers) : answers[0], scenes, bibleChars);

  // 3) Write assets + scenes in one transaction.
  await ctx.progress('Saving the asset list');
  const summary = await begin(async (tx) => {
    const existing = await tx`select id, kind, key, status from assets where project_id = ${projectId}`;
    const byKey = new Map(existing.map((a: any) => [`${a.kind}:${a.key}`, a]));
    const seen = new Set<string>();
    const epOf = (refs: string[]) => [...new Set(refs.map((r) => +r.slice(1, r.indexOf('S'))))].sort((a, b) => a - b);

    async function upsert(kind: string, key: string, fields: { name: string; description: string; parent_id?: string | null; scenes: string[]; meta?: any; priority?: number }) {
      const eps = epOf(fields.scenes);
      const recurring = fields.scenes.length >= 2 || eps.length >= 2;
      const meta = { ...(fields.meta || {}), scenes: fields.scenes };
      const prev = byKey.get(`${kind}:${key}`) as any;
      seen.add(`${kind}:${key}`);
      if (prev) {
        // Approved assets keep their look; only their usage facts are refreshed.
        const [row] = prev.status === 'approved'
          ? await tx`update assets set appearances = ${fields.scenes.length}, episodes = ${eps}, recurring = ${recurring},
              priority = ${fields.priority ?? 0}, meta = assets.meta || ${tx.json(meta)}, parent_id = ${fields.parent_id ?? null}, updated_at = now()
              where id = ${prev.id} returning id`
          : await tx`update assets set name = ${fields.name}, description = ${fields.description}, appearances = ${fields.scenes.length},
              episodes = ${eps}, recurring = ${recurring}, priority = ${fields.priority ?? 0}, meta = assets.meta || ${tx.json(meta)},
              parent_id = ${fields.parent_id ?? null}, updated_at = now() where id = ${prev.id} returning id`;
        return row.id as string;
      }
      const [row] = await tx`insert into assets (project_id, kind, key, parent_id, name, description, appearances, episodes, recurring, priority, meta)
        values (${projectId}, ${kind}, ${key}, ${fields.parent_id ?? null}, ${fields.name}, ${fields.description}, ${fields.scenes.length}, ${eps}, ${recurring}, ${fields.priority ?? 0}, ${tx.json(meta)})
        returning id`;
      return row.id as string;
    }

    const lookOf: Record<string, Record<string, string>> = {}; // sceneRef → {CHAR: lookAssetId}
    const locOf: Record<string, string> = {};                   // sceneRef → set/variant asset id
    const propsOf: Record<string, string[]> = {};
    const speakers = new Set(scenes.flatMap((s) => s.speakers));

    for (const c of bd.characters) {
      const lead = c.scenes.length;
      const cid = await upsert('character', c.key, { name: c.name, description: c.description, scenes: c.scenes, priority: 100 + lead, meta: { is_minor: !!c.is_minor } });
      for (const l of c.looks) {
        const lid = await upsert('look', `${c.key}/${l.key}`, { name: `${c.name} — ${l.name}`, description: l.wardrobe, parent_id: cid, scenes: l.scenes, priority: 90 + l.scenes.length, meta: { character: c.key } });
        for (const r of l.scenes) (lookOf[r] ||= {})[c.key] = lid;
      }
      if (c.voice && speakers.has(c.key)) {
        await upsert('voice', `${c.key}/VOICE`, { name: `${c.name} — voice`, description: c.voice.brief, parent_id: cid, scenes: c.scenes.filter((r) => scenes.find((s) => s.ref === r)?.speakers.includes(c.key)), priority: 50, meta: { character: c.key, sample_line: c.voice.sample_line } });
      }
    }
    for (const st of bd.sets) {
      const sid = await upsert('location', st.key, { name: st.name, description: st.description, scenes: st.scenes, priority: 80 + st.scenes.length, meta: { layout: st.layout || '', building: st.building || '', int_ext: st.int_ext || '' } });
      for (const r of st.scenes) locOf[r] = sid;
      for (const v of st.variants) {
        const vid = await upsert('set_variant', `${st.key}/${v.key}`, { name: `${st.name} — ${v.name}`, description: v.change, parent_id: sid, scenes: v.scenes, priority: 70 + v.scenes.length, meta: { set: st.key } });
        for (const r of v.scenes) locOf[r] = vid;
      }
    }
    for (const pr of bd.props) {
      await upsert('prop', pr.key, { name: pr.name, description: pr.description, scenes: pr.scenes, priority: 40 + pr.scenes.length, meta: { owner: pr.owner || '' } });
      for (const r of pr.scenes) (propsOf[r] ||= []).push(pr.key);
    }
    // Assets the new breakdown no longer uses: keep (they may be approved), but mark unused.
    for (const a of existing as any[]) {
      if (!seen.has(`${a.kind}:${a.key}`)) await tx`update assets set meta = meta || '{"unused": true}'::jsonb, appearances = 0 where id = ${a.id}`;
      else await tx`update assets set meta = meta - 'unused' where id = ${a.id}`;
    }

    await tx`delete from scenes where project_id = ${projectId}`;
    for (const s of scenes) {
      const chars = bd.characters.filter((c) => c.scenes.includes(s.ref)).map((c) => c.key);
      await tx`insert into scenes (project_id, episode_id, idx, heading, int_ext, location_raw, time_of_day, body, characters, speakers, location_asset_id, looks, props, est_seconds)
        values (${projectId}, ${s.episode_id}, ${s.idx}, ${s.heading}, ${s.int_ext}, ${s.location}, ${s.time}, ${s.body}, ${chars}, ${s.speakers},
                ${locOf[s.ref] ?? null}, ${tx.json(lookOf[s.ref] || {})}, ${propsOf[s.ref] || []}, ${s.estSeconds})`;
    }
    const style = { ...(bd.style || {}), ...Object.fromEntries(Object.entries(p.style || {}).filter(([, v]) => v !== '' && v != null)) };
    await tx`update projects set style = ${tx.json(style)}, status = 'assets', updated_at = now() where id = ${projectId}`;
    return {
      scenes: scenes.length,
      characters: bd.characters.length,
      sets: bd.sets.length,
      set_variants: bd.sets.reduce((n, s) => n + s.variants.length, 0),
      looks: bd.characters.reduce((n, c) => n + c.looks.length, 0),
      props: bd.props.length,
      voices: bd.characters.filter((c) => c.voice && speakers.has(c.key)).length,
      recurring_sets: bd.sets.filter((s) => s.scenes.length >= 2).map((s) => s.name),
    };
  });
  return summary;
}

/** The parts of the writers' treatment that matter to casting and design (vibe projects only). */
function treatmentNotes(t: any) {
  if (!t) return null;
  return {
    tone: t.tone, genre: t.genre, theme: t.theme, world: t.world, motifs: t.motifs,
    characters: (t.characters || []).map((c: any) => ({ id: c.id, age: c.age, role: c.role, look: c.look, voice: c.voice })),
    sets: t.sets,
  };
}

const arr = (x: any): any[] => (Array.isArray(x) ? x : []);
/** The breakdowns of a long screenplay's batches as one: the same key is the same character, look, set, variant or prop. */
export function mergeBreakdowns(parts: any[]): { style: any; characters: any[]; sets: any[]; props: any[] } {
  const out = { style: {} as any, characters: [] as any[], sets: [] as any[], props: [] as any[] };
  const ck = (x: any) => up(x?.key || x?.name), sk = (x: any) => snake(x?.key || x?.name || 'DEFAULT');
  /** Add `items` to `into` by key; a known key gains the new scenes (and nested lists merged by `nested`). */
  const fold = (into: any[], items: any[], key: (x: any) => string, nested?: string) => {
    for (const x of items) {
      if (!x || typeof x !== 'object' || !key(x)) continue;
      const have = into.find((y) => key(y) === key(x));
      if (!have) { into.push({ ...x, scenes: [...arr(x.scenes)], ...(nested ? { [nested]: arr(x[nested]).map((n: any) => ({ ...n, scenes: [...arr(n.scenes)] })) } : {}) }); continue; }
      have.scenes = [...arr(have.scenes), ...arr(x.scenes)];
      if (nested) fold(have[nested] ||= [], arr(x[nested]), sk);
      for (const [k, v] of Object.entries(x)) if (k !== 'scenes' && k !== nested && (have[k] === undefined || have[k] === '' || (k === 'voice' && !have.voice?.brief))) have[k] = v;
    }
  };
  for (const r of parts) {
    for (const [k, v] of Object.entries(r?.style || {})) if (!out.style[k]) out.style[k] = v; // the first batch sets the look
    fold(out.characters, arr(r?.characters), ck, 'looks');
    fold(out.sets, arr(r?.sets), sk, 'variants');
    fold(out.props, arr(r?.props), sk);
  }
  return out;
}

/** Make Claude's breakdown internally consistent: every scene in one set, looks cover appearances, keys clean. */
export function repair(raw: any, scenes: { ref: string; heading: string; location: string; time: string; int_ext: string; present: string[]; speakers: string[] }[], bible: BibleCharacter[]): BreakdownResult {
  const refs = new Set(scenes.map((s) => s.ref));
  const okRefs = (a: any) => [...new Set((Array.isArray(a) ? a : []).map(String).map((r) => r.trim().toUpperCase()).filter((r) => refs.has(r)))];
  const out: BreakdownResult = { style: raw?.style || {}, characters: [], sets: [], props: [] };

  // Characters.
  const seenC = new Set<string>();
  for (const c of Array.isArray(raw?.characters) ? raw.characters : []) {
    // Character keys keep the bible's spelling ("DR. NAQVI") so parser matches line up.
    const key = up(c.key || c.name);
    if (!key || seenC.has(key)) continue;
    seenC.add(key);
    // Speaking is certain; name matches in action lines are only hints (a surname on a shop sign is not the person).
    const parsed = scenes.filter((s) => s.speakers.includes(key)).map((s) => s.ref);
    const sc = [...new Set([...okRefs(c.scenes), ...parsed])];
    if (!sc.length) continue;
    let looks = (Array.isArray(c.looks) ? c.looks : []).map((l: any) => ({ key: snake(l.key || l.name || 'DEFAULT'), name: String(l.name || 'Default'), wardrobe: String(l.wardrobe || ''), scenes: okRefs(l.scenes).filter((r) => sc.includes(r)) }));
    if (!looks.length) looks = [{ key: 'DEFAULT', name: 'Default', wardrobe: '', scenes: [] }];
    // Partition: each scene in exactly one look; uncovered scenes go to the first look.
    const taken = new Set<string>();
    for (const l of looks) { l.scenes = l.scenes.filter((r: string) => !taken.has(r)); l.scenes.forEach((r: string) => taken.add(r)); }
    for (const r of sc) if (!taken.has(r)) looks[0].scenes.push(r);
    looks = looks.filter((l: any) => l.scenes.length);
    const bc = bible.find((b) => up(b.id) === key);
    out.characters.push({
      key, name: String(c.name || bc?.name || key), is_minor: !!c.is_minor || (bc?.age ? +bc.age < 18 : false),
      description: String(c.description || bc?.design?.lock || ''),
      looks, scenes: sc,
      voice: c.voice && c.voice.brief ? { brief: String(c.voice.brief || ''), sample_line: String(c.voice.sample_line || '') } : undefined,
    });
  }
  // Speakers that Claude forgot.
  for (const s of scenes) for (const k of s.speakers) {
    if (seenC.has(k)) continue;
    seenC.add(k);
    const sc = scenes.filter((x) => x.speakers.includes(k)).map((x) => x.ref);
    const bc = bible.find((b) => up(b.id) === k);
    out.characters.push({ key: k, name: bc?.name || k, description: bc?.design?.lock || '', looks: [{ key: 'DEFAULT', name: 'Default', wardrobe: '', scenes: sc }], scenes: sc, is_minor: bc?.age ? +bc.age < 18 : false });
  }

  // Sets.
  const assigned = new Map<string, string>();
  const seenS = new Set<string>();
  for (const st of Array.isArray(raw?.sets) ? raw.sets : []) {
    let key = snake(st.key || st.name);
    while (seenS.has(key)) key += '_2';
    const sc = okRefs(st.scenes).filter((r) => !assigned.has(r));
    if (!sc.length) continue;
    seenS.add(key);
    sc.forEach((r) => assigned.set(r, key));
    const vTaken = new Set<string>();
    const variants = (Array.isArray(st.variants) ? st.variants : []).map((v: any) => {
      const vs = okRefs(v.scenes).filter((r) => sc.includes(r) && !vTaken.has(r));
      vs.forEach((r) => vTaken.add(r));
      return { key: snake(v.key || v.name), name: String(v.name || v.key || ''), change: String(v.change || v.description || ''), scenes: vs };
    }).filter((v: any) => v.scenes.length);
    // If variants exist, scenes not in any variant stay on the set master (allowed).
    out.sets.push({ key, name: String(st.name || key), building: snake(st.building || '') === 'X' ? '' : snake(st.building || ''), int_ext: String(st.int_ext || ''), description: String(st.description || ''), layout: String(st.layout || ''), variants, scenes: sc });
  }
  // Scenes Claude didn't place: group by parsed location.
  const orphan = scenes.filter((s) => !assigned.has(s.ref));
  for (const s of orphan) {
    const key = snake(s.location || s.heading);
    let set = out.sets.find((x) => x.key === key);
    if (!set) { set = { key, name: s.location || s.heading, int_ext: s.int_ext, description: '', layout: '', variants: [], scenes: [] }; out.sets.push(set); }
    set.scenes.push(s.ref);
  }

  // Props.
  const seenP = new Set<string>();
  for (const pr of Array.isArray(raw?.props) ? raw.props : []) {
    const key = snake(pr.key || pr.name);
    if (seenP.has(key)) continue;
    const sc = okRefs(pr.scenes);
    if (!sc.length) continue;
    seenP.add(key);
    out.props.push({ key, name: String(pr.name || key), description: String(pr.description || ''), owner: up(pr.owner || ''), scenes: sc });
  }
  return out;
}
