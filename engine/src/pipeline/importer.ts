// Turn an incoming project (a Reelwright backup, or a plain screenplay payload from any
// front end) into rows: project + episodes. Scenes and assets come later, in the breakdown.

import { z } from 'zod';
import { sql, begin } from '../db.js';
import { config } from '../config.js';
import { checkScript } from './limits.js';

const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

const Generic = z.object({
  title: z.string().max(200).default('Untitled'),
  format: z.enum(['micro', 'film', 'series']).default('micro'),
  aspect: z.string().optional(),
  resolution: z.enum(['768P', '2K']).optional(),
  language: z.string().max(60).optional(),
  style: z.record(z.string(), z.any()).optional(),
  characters: z.array(z.object({
    id: z.string().optional(), name: z.string(), age: z.string().optional(), role: z.string().optional(),
    description: z.string().optional(), voice: z.string().optional(),
  }).passthrough()).optional(),
  world: z.string().optional(),
  episodes: z.array(z.object({ label: z.string().optional(), title: z.string().optional(), script: z.string().min(1) })).optional(),
  screenplay: z.string().optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

export interface Normalized {
  title: string; format: string; aspect: string; resolution: string; language: string;
  style: any; story_bible: any; settings: any;
  episodes: { label: string; title: string; script: string }[];
}

const pickAspect = (a: any, format: string) => {
  const s = String(a || '').trim();
  if (RATIOS.includes(s)) return s;
  if (s === '2.39:1' || s === '2.35:1') return '21:9';
  if (s === '4:5') return '3:4';
  return format === 'film' ? '16:9' : format === 'series' ? '16:9' : '9:16';
};

/** Reelwright project backup → normalized. Keeps its look bible (locks) as design seeds. */
function fromReelwright(p: any): Normalized {
  const s = p.settings || {};
  const format = ['micro', 'film', 'series'].includes(s.format) ? s.format : 'micro';
  const units = p.outline?.units || [];
  const episodes = units
    .map((u: any) => ({ label: u.label || '', title: u.title || '', script: p.units?.[u.id]?.script || '' }))
    .filter((e: any) => e.script.trim());
  // Units written without an outline entry.
  for (const [id, u] of Object.entries<any>(p.units || {})) {
    if (!units.find((x: any) => x.id === id) && u?.script?.trim()) episodes.push({ label: id, title: '', script: u.script });
  }
  const sb = p.storyBible || {};
  const bible = p.bible || {};
  const locks: any = {};
  for (const c of bible.characters || []) locks[String(c.id).toUpperCase()] = { lock: c.lock, looks: c.looks, voice: c.voice };
  return {
    title: p.title || p.outline?.title || p.story?.title || 'Untitled',
    format,
    aspect: pickAspect(bible.style?.aspect || s.aspect, format),
    resolution: '768P',
    language: s.language || 'English',
    style: bible.style || {},
    story_bible: {
      logline: p.story?.logline || '', synopsis: sb.synopsis || '', world: sb.world || s.setting || '',
      themes: sb.themes || [], motifs: sb.motifs || [],
      characters: (sb.characters || []).map((c: any) => ({ ...c, id: String(c.id || c.name).toUpperCase(), design: locks[String(c.id).toUpperCase()] || null })),
      // Prior look-bible designs from Reelwright, reused so the look stays what the writer approved.
      design_seeds: { locations: bible.locations || [], props: bible.props || [], characters: bible.characters || [] },
    },
    settings: { source: 'reelwright', genre: s.genre || '', tone: s.tone || '' },
    episodes,
  };
}

export function normalizeImport(body: any): Normalized {
  if (body && body.settings && (body.units || body.outline)) return fromReelwright(body);
  const g = Generic.parse(body);
  const episodes = g.episodes?.length ? g.episodes.map((e, i) => ({ label: e.label || `Episode ${i + 1}`, title: e.title || '', script: e.script }))
    : g.screenplay ? [{ label: g.format === 'film' ? 'Feature' : 'Episode 1', title: '', script: g.screenplay }] : [];
  if (!episodes.length) throw Object.assign(new Error('Provide episodes[] or screenplay (Fountain text).'), { status: 400 });
  return {
    title: g.title, format: g.format, aspect: pickAspect(g.aspect, g.format), resolution: g.resolution || '768P',
    language: g.language || 'English', style: g.style || {},
    story_bible: {
      world: g.world || '',
      characters: (g.characters || []).map((c) => ({ ...c, id: String(c.id || c.name).toUpperCase().trim() })),
    },
    settings: g.settings || {},
    episodes,
  };
}

export async function createProject(ownerId: string, body: any) {
  const n = normalizeImport(body);
  // Bounded before anything is stored or sent to a model: so many episodes, each a script one episode can hold.
  if (n.episodes.length > config.scripts.maxImportEpisodes) throw Object.assign(new Error(`A project can be imported with up to ${config.scripts.maxImportEpisodes} episodes; this one has ${n.episodes.length}.`), { status: 400, code: 'too_long' });
  n.episodes.forEach((e, i) => checkScript(e.script, `Episode ${i + 1}'s script`));
  n.title = String(n.title || 'Untitled').slice(0, 200);
  return begin(async (tx) => {
    const [p] = await tx`
      insert into projects (owner_id, title, format, aspect, resolution, language, style, story_bible, settings, source)
      values (${ownerId}, ${n.title}, ${n.format}, ${n.aspect}, ${n.resolution}, ${n.language},
              ${tx.json(n.style)}, ${tx.json(n.story_bible)}, ${tx.json({ chain_clips: true, burn_subtitles: false, ...n.settings })}, ${tx.json(body)})
      returning *`;
    let i = 0;
    for (const e of n.episodes) {
      i++;
      await tx`insert into episodes (project_id, idx, label, title, script) values (${p.id}, ${i}, ${e.label}, ${e.title}, ${e.script})`;
    }
    return p;
  });
}
