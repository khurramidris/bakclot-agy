// Prompt → screenplay, as a writers' room. Each step is one small job, saved before the next, so a restart resumes,
// no job runs long, and no model is ever asked to hold the whole film in its head at once:
//   1. pitch: three different takes on the idea; then a head of development scores them on a rubric and picks one,
//      with development notes (choosing well is easier than writing well, so a weaker model still chooses well);
//   2. bible: the chosen take developed into the story bible (characters with wants, secrets and voices, world,
//      sets, setups and payoffs, the shape of each episode, the film's look); overused names are recast;
//   3. outline: each episode boarded into scene cards (purpose, what each character wants, what's underneath, the
//      turn, the exit), with seconds, scene counts and a timed beat grid worked out in code;
//   4. scenes: every scene written from its card, in parallel, to a word budget computed in code, with worked
//      examples; an episode's opening and ending are drafted twice and a judge keeps the better one;
//   5. polish: a script editor scores the screenplay and gives located notes; only the flagged scenes are rewritten,
//      and a rewrite replaces a scene only if the checks don't get worse and a judge prefers it.
// Scenes are written as elements and code renders the Fountain, so every script parses the same way. The result has
// the shape the importer accepts, so everything downstream is unchanged; the cards travel on in the story bible to
// the director and the shot planner.

import { z } from 'zod';
import { sql, begin } from '../db.js';
import { config } from '../config.js';
import { PermanentError, type JobCtx } from '../queue.js';
import { claudeJSON, llmCost, llmUnits, type ClaudeCall } from '../providers/claude.js';
import { recordUsage } from '../usage.js';
import { sceneFountain, type SceneElement } from './fountain.js';
import { normalizeImport } from './importer.js';
import {
  PITCH_SYSTEM, pitchPrompt, CHOOSE_SYSTEM, choosePrompt, BIBLE_SYSTEM, biblePrompt, RENAME_SYSTEM, renamePrompt, OUTLINE_SYSTEM, outlinePrompt,
  SCENE_SYSTEM, scenePrompt, CRITIQUE_SYSTEM, critiquePrompt, JUDGE_SYSTEM, judgePrompt, SEASON_SYSTEM, seasonPrompt, bibleText, cardLine, cardText,
} from './prompts.js';
import { PitchSchema, ChooseSchema, BibleSchema, RenameSchema, OutlineSchema, SceneSchema, CritiqueSchema, JudgeSchema, SeasonSchema } from './schemas.js';
import {
  applyRenames, budget, cleanBible, cleanOutline, cleanScene, inParallel, overusedNames, plantNotes, recentWork, rhythm, sceneProblem,
  sceneRange, shuffled, sparksFor, storyLint, type CardOut,
} from './story.js';
import { craftFor, craftTags } from './craft.js';

type Range = readonly [number, number];
const ANY = Number.MAX_SAFE_INTEGER; // no limit on how many episodes or parts a story has
export const FORMATS: Record<string, { label: string; aspect: string; engine: string; unit: 'Episode' | 'Part'; episodes: Range; seconds: Range; defaults: { episodes: number; seconds: number }; notes: string }> = {
  microdrama: { label: 'Microdrama', aspect: '9:16', engine: 'micro', unit: 'Episode', episodes: [1, ANY], seconds: [45, 180], defaults: { episodes: 1, seconds: 75 },
    notes: 'A vertical microdrama for phone feeds: heightened emotion, fast turns, big reveals, and a cliffhanger ending.' },
  short_film: { label: 'Short film', aspect: '16:9', engine: 'film', unit: 'Part', episodes: [1, 1], seconds: [60, 600], defaults: { episodes: 1, seconds: 120 },
    notes: 'A self-contained short film with a clear beginning, middle and end.' },
  feature_film: { label: 'Feature film', aspect: '16:9', engine: 'film', unit: 'Part', episodes: [1, ANY], seconds: [180, 600], defaults: { episodes: 18, seconds: 300 },
    notes: 'A feature-length film, written and filmed in parts of a few minutes each. It is one story: a beginning, a middle and an end across the whole film. Each part moves the story forward and hands over to the next; the last part pays everything off.' },
  web_series: { label: 'Web series', aspect: '16:9', engine: 'series', unit: 'Episode', episodes: [1, ANY], seconds: [90, 600], defaults: { episodes: 2, seconds: 150 },
    notes: 'A web series: every episode has its own arc and ends on a hook into the next.' },
  youtube: { label: 'YouTube story', aspect: '16:9', engine: 'film', unit: 'Part', episodes: [1, ANY], seconds: [60, 600], defaults: { episodes: 1, seconds: 120 },
    notes: 'A narrative story video for YouTube: a strong hook in the first five seconds, then rising tension to the end.' },
};

export const BriefSchema = z.object({
  prompt: z.string().trim().min(10, 'Describe your idea in at least a sentence.').max(4000),
  format: z.enum(['microdrama', 'short_film', 'feature_film', 'web_series', 'youtube']).default('microdrama'),
  episodes: z.number().int().positive().optional(),
  seconds: z.number().int().positive().optional(), // per episode
  total_seconds: z.number().int().positive().optional(), // the whole film or series; split into episodes or parts in code
  language: z.string().trim().min(2).max(40).default('English'),
  review: z.boolean().default(false), // step by step: stop for the customer after the takes, the script and the cast
});
export type Brief = Omit<z.infer<typeof BriefSchema>, 'episodes' | 'seconds' | 'total_seconds'> & { episodes: number; seconds: number; aspect: string; engineFormat: string };

const clamp = (v: number, [lo, hi]: Range) => Math.min(hi, Math.max(lo, v));

/** Fill defaults and clamp to what the format allows. There is no length limit unless MAX_RUNTIME_SECONDS sets one. */
export function resolveBrief(raw: unknown): Brief {
  const { total_seconds: total, ...b } = BriefSchema.parse(raw);
  const f = FORMATS[b.format];
  const single = f.episodes[1] === 1;
  let seconds = clamp(single && total ? total : b.seconds ?? f.defaults.seconds, f.seconds);
  let episodes = clamp(total && !single ? Math.max(1, Math.round(total / seconds)) : b.episodes ?? f.defaults.episodes, f.episodes);
  const cap = config.autopilot.maxRuntimeSeconds;
  if (cap > 0) {
    seconds = Math.min(seconds, cap);
    while (episodes > 1 && episodes * seconds > cap) episodes--;
  }
  return { ...b, episodes, seconds, aspect: f.aspect, engineFormat: f.engine };
}

/** A whole season or a feature film: its many small calls run on the bulk model and it's planned in batches. */
export const isLongForm = (b: Pick<Brief, 'episodes' | 'seconds'>) => b.episodes * b.seconds > config.anthropic.longFormSeconds;
/** What one episode of this format is called on screen: "Episode 3" or, for films, "Part 3". */
export const unitOf = (format: string) => FORMATS[format]?.unit || 'Episode';

/** The take to develop: the best rubric total among takes that keep the customer's idea (fidelity counts double). */
export function pickConcept(choice: any, n: number): number {
  const scores: any[] = Array.isArray(choice?.scores) ? choice.scores : [];
  const said = Number.isInteger(+choice?.chosen) && +choice.chosen >= 0 && +choice.chosen < n ? +choice.chosen : 0;
  const v = (s: any, k: string) => Math.min(5, Math.max(1, Math.round(+s?.[k]) || 1));
  const rated = Array.from({ length: n }, (_, i) => scores.find((s) => +s?.concept === i)).map((s, i) => ({ i, s }))
    .filter((x) => x.s).map(({ i, s }) => ({ i, fidelity: v(s, 'fidelity'), total: 2 * v(s, 'fidelity') + ['hook', 'stakes', 'specificity', 'surprise', 'renderable'].reduce((t, k) => t + v(s, k), 0) }));
  if (!rated.length) return said;
  const faithful = rated.filter((x) => x.fidelity >= 3);
  const pool = faithful.length ? faithful : rated;
  const best = Math.max(...pool.map((x) => x.total));
  const top = pool.filter((x) => x.total === best);
  return (top.find((x) => x.i === said) || top[0]).i;
}

/** A judge's verdicts mapped back to the versions, given which pairs were shown in swapped order. 0 = the first version. */
export function judged(raw: any, flips: boolean[]): { winner: 0 | 1; clear: boolean }[] {
  const vs: any[] = Array.isArray(raw?.verdicts) ? raw.verdicts : [];
  return flips.map((flip, n) => {
    const v = vs.find((x) => +x?.pair === n + 1) || vs[n];
    const saidB = String(v?.better || 'A').trim().toUpperCase().startsWith('B');
    return { winner: (saidB !== flip ? 1 : 0) as 0 | 1, clear: v ? !/slight/i.test(String(v.margin)) : false };
  });
}

type Note = { problem: string; fix: string };
type Phase = 'pitch' | 'bible' | 'season' | 'outline' | 'scenes' | 'critique' | 'revise';
const PHASES: Phase[] = ['pitch', 'bible', 'season', 'outline', 'scenes', 'critique', 'revise'];
export interface WriteState {
  phase?: Phase; tries?: number; problem?: string;
  direction?: string;                         // the customer's note for new takes (step by step)
  picked?: boolean;                           // the customer chose the take (step by step)
  concepts?: any[]; choice?: { chosen: number; scores: any[]; notes: string[] };
  bible?: any;
  outline?: CardOut[][];                      // scene cards per episode
  scenes?: (SceneElement[] | null)[][];       // written scenes per episode, aligned with the cards
  critique?: { scores: any; scenes: any[] } | null;
  critiqued?: number;                         // episodes the script editor has read so far (long stories go in batches)
  revised?: number;                           // episodes polished so far
  notes?: string[];                           // what the polish did, for the report
}

/**
 * One step of the writers' room per call. Returns done=true once the final screenplay is saved.
 * State lives in projects.autopilot.writing, so a failed or restarted job resumes at its step.
 */
export async function writeStep(projectId: string, ctx: JobCtx): Promise<{ done: boolean; progress: string; wait?: number; pause?: 'story' }> {
  const [p] = await sql`select * from projects where id = ${projectId}`;
  if (!p) throw new PermanentError('project not found');
  const brief = p.brief as Brief;
  const f = FORMATS[brief.format];
  let st: WriteState = p.autopilot?.writing || {};
  if (st.phase && !PHASES.includes(st.phase)) st = {}; // state from an older engine: start over
  const phase: Phase = st.phase || 'pitch';
  const long = isLongForm(brief);
  const base = { format: f.label, formatNotes: f.notes, aspect: brief.aspect, episodes: brief.episodes, secondsPerEpisode: brief.seconds, language: brief.language, unit: f.unit };
  const retryNote = st.problem ? `\n\nYOUR PREVIOUS ANSWER WAS UNUSABLE: ${st.problem}. Fix that.` : '';
  const save = (patch: WriteState | null) => sql`update projects set autopilot = autopilot || ${sql.json({ writing: patch } as any)}, updated_at = now() where id = ${projectId}`;
  const fail = async (problem: string, what: string) => {
    const tries = (st.tries || 0) + 1;
    if (tries >= 2) throw new PermanentError(`The ${what} could not be written: ${problem}.`, 'write_failed');
    await save({ ...st, phase, tries, problem });
    return { done: false, progress: `Rewriting the ${what}` };
  };
  /** One Claude call of this project, with its cost recorded. */
  const ask = async <T>(call: ClaudeCall<T>, ref: string) => {
    const r = await claudeJSON<T>({ ...call, bulk: long });
    await recordUsage({ ownerId: p.owner_id, projectId, kind: 'llm', units: llmUnits(r.usage), cost: llmCost(r.model, r.usage), ref });
    return r.data;
  };
  const room = { p, brief, st, ask };

  if (phase === 'pitch') {
    await ctx.progress('Pitching takes on the idea');
    const input = { ...base, prompt: brief.prompt, sparks: sparksFor(projectId), recent: await recentWork(p.owner_id, projectId), direction: st.direction, previous: st.concepts };
    const pitched = await ask({ task: 'pitch', system: PITCH_SYSTEM(brief.format), prompt: pitchPrompt(input) + retryNote, input, schema: PitchSchema, effort: config.anthropic.effort, maxTokens: 24000 }, 'pitch');
    const concepts = (Array.isArray(pitched?.concepts) ? pitched.concepts : []).filter((c: any) => c && typeof c === 'object' && (c.logline || c.title)).slice(0, 3);
    if (!concepts.length) return fail('there were no takes on the idea', 'story');
    let choice = { chosen: 0, scores: [] as any[], notes: [] as string[] };
    if (concepts.length > 1) {
      try {
        const c = await ask({ task: 'choose', system: CHOOSE_SYSTEM, prompt: choosePrompt({ ...base, prompt: brief.prompt, concepts }), input: { concepts }, schema: ChooseSchema, effort: config.anthropic.planningEffort, maxTokens: 16000 }, 'choose');
        choice = { chosen: pickConcept(c, concepts.length), scores: Array.isArray(c?.scores) ? c.scores : [], notes: (Array.isArray(c?.notes) ? c.notes : []).map(String).slice(0, 4) };
      } catch (e: any) { if (e instanceof PermanentError && e.code === 'refused') throw e; } // without a verdict, the first take
    }
    await save({ phase: 'bible', concepts, choice, tries: 0 });
    return { done: false, progress: 'Takes pitched', ...(brief.review ? { pause: 'story' as const } : {}) };
  }

  if (phase === 'bible') {
    await ctx.progress('Developing the story');
    const concept = st.concepts?.[st.choice?.chosen || 0];
    const planned = long ? Math.min(brief.episodes, config.anthropic.seasonBatch) : brief.episodes; // the rest come from the season plan
    const input = { ...base, prompt: brief.prompt, concept, notes: st.choice?.notes || [], recent: await recentWork(p.owner_id, projectId), planned, minutes: Math.round((brief.episodes * brief.seconds) / 60) };
    const raw = await ask({ task: 'bible', system: BIBLE_SYSTEM(brief.format), prompt: biblePrompt(input) + retryNote, input, schema: BibleSchema, effort: config.anthropic.effort, maxTokens: 48000 }, 'bible');
    let { bible, problem } = cleanBible(raw, planned);
    if (problem) return fail(problem, 'story');
    // Every AI story reaches for the same few names; recast them here, where names are decided once for the film.
    const rename = overusedNames(bible.characters, brief.prompt);
    if (rename.length) {
      try {
        const r = await ask({ task: 'rename', system: RENAME_SYSTEM, prompt: renamePrompt({ bible, rename }), input: { bible, rename }, schema: RenameSchema, effort: 'low', maxTokens: 8000 }, 'rename');
        const names = (Array.isArray(r?.names) ? r.names : []).filter((x: any) => !overusedNames([{ name: x?.name }], brief.prompt).length);
        bible = applyRenames(bible, names);
      } catch (e: any) { if (e instanceof PermanentError && e.code === 'refused') throw e; } // keep the names rather than fail
    }
    bible.episodes = bible.episodes.slice(0, planned).map((e: any, i: number) => ({ ...e, number: i + 1 }));
    await save({ ...st, phase: bible.episodes.length < brief.episodes ? 'season' : 'outline', bible, outline: [], tries: 0, problem: undefined });
    return { done: false, progress: 'Story developed' };
  }

  if (phase === 'season') { // a long story's episodes, planned a batch at a time from the bible's season arc
    const have = st.bible.episodes.length, to = Math.min(brief.episodes, have + config.anthropic.seasonBatch);
    await ctx.progress(`Planning ${f.unit.toLowerCase()}s ${have + 1} to ${to} of ${brief.episodes}`);
    const input = { ...base, from: have + 1, to, open: openPlants(st.bible) };
    const raw = await ask({ task: 'season', system: SEASON_SYSTEM(brief.format), context: bibleText(st.bible, { language: brief.language }), prompt: seasonPrompt(input) + retryNote, input, schema: SeasonSchema, effort: config.anthropic.effort, maxTokens: 32000 }, `season:${have + 1}`);
    const next = (Array.isArray(raw?.episodes) ? raw.episodes : []).filter((e: any) => e && (e.summary || e.title)).slice(0, to - have)
      .map((e: any, i: number) => ({ title: String(e.title || ''), summary: String(e.summary || ''), opening: String(e.opening || ''), ending: String(e.ending || ''), number: have + i + 1 }));
    if (!next.length) return fail(`no ${f.unit.toLowerCase()}s were planned`, 'season plan');
    const bible = { ...st.bible, episodes: [...st.bible.episodes, ...next] };
    await save({ ...st, bible, phase: bible.episodes.length < brief.episodes ? 'season' : 'outline', tries: 0, problem: undefined });
    return { done: false, progress: `${f.unit}s ${have + 1} to ${have + next.length} planned` };
  }

  if (phase === 'outline') {
    const outline = st.outline || [];
    const e = outline.length;
    await ctx.progress(`Boarding episode ${e + 1}`);
    const episode = st.bible.episodes[e];
    const range = sceneRange(brief.format, brief.seconds);
    const input = {
      episode, episodes: brief.episodes, seconds: brief.seconds, range, rhythm: rhythm(brief.format, brief.seconds),
      // The two episodes before this one as boarded; the rest of the story so far is in the bible's episode list.
      earlier: outline.slice(Math.max(0, e - 2)).map((cards, i) => ({ number: Math.max(0, e - 2) + i + 1, cards })), open: e ? plantNotes(st.bible, outline) : [], bible: st.bible,
    };
    const raw = await ask({ task: 'outline', system: OUTLINE_SYSTEM(brief.format), context: bibleText(st.bible, { language: brief.language }), prompt: outlinePrompt(input) + retryNote, input, schema: OutlineSchema, effort: config.anthropic.effort, maxTokens: 32000 }, `outline:${e + 1}`);
    const { cards, problem } = cleanOutline(raw, st.bible, brief.seconds, range);
    if (problem) return fail(problem, `outline of episode ${e + 1}`);
    const next = [...outline, cards];
    await save({ ...st, outline: next, ...(next.length >= brief.episodes ? { phase: 'scenes', scenes: [] } : {}), tries: 0, problem: undefined });
    return { done: false, progress: `Episode ${e + 1} boarded` };
  }

  if (phase === 'scenes') {
    const outline = st.outline!, scenes = st.scenes || [];
    const e = outline.findIndex((cards, i) => !(scenes[i] && cards.every((_, k) => scenes[i][k]?.length)));
    if (e >= 0) {
      await ctx.progress(`Writing episode ${e + 1}`);
      const written = await writeEpisode(room, e);
      const next = [...scenes]; next[e] = written;
      const missing = written.filter((x) => !x?.length).length;
      if (missing) {
        const tries = (st.tries || 0) + 1;
        if (tries >= 3) throw new PermanentError(`The script could not be written: ${missing} scene(s) of episode ${e + 1} kept failing.`, 'write_failed');
        await save({ ...st, scenes: next, tries });
        return { done: false, progress: `Rewriting ${missing} scene(s)`, wait: 30 * tries }; // a moment for a passing outage
      }
      await save({ ...st, scenes: next, tries: 0 });
      return { done: false, progress: `Episode ${e + 1} written` };
    }
    if (!config.anthropic.scriptDoctor) return finish(room, []);
    await save({ ...st, phase: 'critique' });
    return { done: false, progress: 'First draft written' };
  }

  if (phase === 'critique') { // the script editor reads up to CRITIQUE_BATCH_SECONDS of screen time per call
    const from = st.critiqued || 0, all = st.outline!.length;
    const to = Math.min(all, from + Math.max(1, Math.floor(config.anthropic.critiqueBatchSeconds / brief.seconds)));
    await ctx.progress(all > to - from ? `Script editor's notes: ${f.unit.toLowerCase()}s ${from + 1} to ${to}` : "Script editor's notes");
    const lint = lintOf(room);
    const prev = st.critique || { scores: null, scenes: [] };
    let critique: WriteState['critique'] = prev;
    const notes = [...(st.notes || [])];
    try {
      const outline = st.outline!.slice(from, to);
      const scripts = scriptsWithCards(st).slice(from, to);
      const input = { prompt: brief.prompt, outline, scripts, first: from, checks: lint.issues, plants: plantNotes(st.bible, st.outline!) };
      const r = await ask({ task: 'critique', system: CRITIQUE_SYSTEM(brief.format), context: bibleText(st.bible, { language: brief.language }), prompt: critiquePrompt(input), input, schema: CritiqueSchema, effort: config.anthropic.effort, maxTokens: 32000 }, `critique:${from + 1}`);
      critique = { scores: mergeScores(prev.scores, r?.scores, from, to - from), scenes: [...prev.scenes, ...(Array.isArray(r?.scenes) ? r.scenes : [])] };
    } catch (e: any) {
      if (e instanceof PermanentError && e.code === 'refused') throw e;
      notes.push(`kept the first draft of ${all > 1 ? `${f.unit.toLowerCase()}s ${from + 1} to ${to}` : 'the script'}: the script editor's pass failed (${String(e.message).slice(0, 120)})`);
    }
    if (to < all) {
      await save({ ...st, critique, critiqued: to, notes });
      return { done: false, progress: `Notes in for ${f.unit.toLowerCase()}s ${from + 1} to ${to}` };
    }
    await save({ ...st, phase: 'revise', critique, critiqued: to, revised: 0, notes });
    return { done: false, progress: 'Notes in' };
  }

  // Polish, one episode per call: only the flagged scenes are rewritten, and only better rewrites are kept.
  const e = st.revised || 0;
  if (e < st.outline!.length) {
    await ctx.progress(`Polishing episode ${e + 1}`);
    const { scenes, notes } = await reviseEpisode(room, e);
    const next = [...st.scenes!]; next[e] = scenes;
    await save({ ...st, scenes: next, revised: e + 1, notes: [...(st.notes || []), ...notes] });
    return { done: false, progress: `Episode ${e + 1} polished` };
  }
  return finish(room, st.notes || []);
}

type Room = { p: any; brief: Brief; st: WriteState; ask: <T>(call: ClaudeCall<T>, ref: string) => Promise<T> };

const castIds = (bible: any) => (bible?.characters || []).map((c: any) => c.id);
const sceneText = (card: CardOut, els: SceneElement[] | null | undefined) => sceneFountain(card.heading, els || []);
const episodeScript = (st: WriteState, e: number) => st.outline![e].map((c, k) => sceneText(c, st.scenes?.[e]?.[k])).join('\n\n');
const scriptsWithCards = (st: WriteState) => st.outline!.map((cards, e) => cards.map((c, k) => `--- Scene ${k + 1}. Card: ${cardLine(c, k).replace(/^\d+\.\s*/, '')}\n${sceneText(c, st.scenes?.[e]?.[k])}`).join('\n\n'));

/** The written production in the shape storyLint and the importer read. */
function written(st: WriteState) {
  const b = st.bible || {};
  return {
    title: b.title, logline: b.logline, world: [b.world?.place, b.world?.era, b.world?.social_world].filter(Boolean).join('. '),
    characters: (b.characters || []).map((c: any) => ({ id: c.id, name: c.name, age: c.age, role: c.role, look: c.look })),
    episodes: (st.outline || []).map((_, e) => ({ title: b.episodes?.[e]?.title || '', script: episodeScript(st, e) })),
    bible: b,
  };
}
const lintOf = (r: Pick<Room, 'st' | 'brief'>) => storyLint(written(r.st), { seconds: r.brief.seconds, language: r.brief.language }, r.brief.prompt);

/** Write one scene from its card: a cleaned scene, retried once when it can't be used as written. */
async function draftScene(r: Room, e: number, k: number, o: { seed: string; variant?: string; current?: string; notes?: Note[] }): Promise<SceneElement[] | null> {
  const { st, brief } = r, cards = st.outline![e], card = cards[k];
  const examples = craftFor(craftTags({ first: k === 0, last: k === cards.length - 1, speakers: card.characters.length, text: [card.purpose, card.subtext, card.turn, card.key_image, card.exit].join(' '), format: brief.format }), o.seed);
  const prompt = scenePrompt({ episode: st.bible.episodes[e], episodes: brief.episodes, cards, k, plants: st.bible.plants, budget: budget(card.seconds), examples, draft: o });
  const call = (extra = '') => r.ask({ task: 'scene', system: SCENE_SYSTEM(brief.format), context: bibleText(st.bible, { language: brief.language }), prompt: prompt + extra, input: { card, cards, k, bible: st.bible, notes: o.notes, variant: o.variant }, schema: SceneSchema, effort: config.anthropic.effort, maxTokens: 20000 }, `scene:${e + 1}.${k + 1}`);
  try {
    let s = cleanScene(await call(), st.bible);
    const problem = sceneProblem(s, card.seconds, castIds(st.bible));
    if (problem) {
      const again = cleanScene(await call(`\n\nYOUR PREVIOUS VERSION COULD NOT BE USED: ${problem}. Write the scene again and fix that.`), st.bible);
      if (!sceneProblem(again, card.seconds, castIds(st.bible)) || !s.elements.length) s = again;
    }
    return s.elements.length ? s.elements : null;
  } catch (err: any) {
    if (err instanceof PermanentError) throw err; // a refusal, a bad key or request: another try won't help
    console.warn(`[writer] scene ${e + 1}.${k + 1}: ${String(err?.message || err).slice(0, 200)}`);
    return null; // written again on the next step; the scenes that worked are kept
  }
}

/** Compare pairs of versions of scenes; the judge sees each pair in a seeded order, so a position bias can't decide. */
async function judge(r: Room, pairs: { e: number; k: number; a: SceneElement[]; b: SceneElement[] }[], ref: string) {
  if (!pairs.length) return [];
  const flips = pairs.map((x) => shuffled(`${r.p.id}:${ref}:${x.e}.${x.k}`, [0, 1])[0] === 1);
  const shown = pairs.map((x, n) => {
    const card = r.st.outline![x.e][x.k], [a, b] = flips[n] ? [x.b, x.a] : [x.a, x.b];
    return { card: cardText(card, x.k, r.st.outline![x.e].length, r.st.bible.plants), a: sceneText(card, a), b: sceneText(card, b) };
  });
  try {
    const raw = await r.ask({ task: 'judge', system: JUDGE_SYSTEM, context: bibleText(r.st.bible, { language: r.brief.language }), prompt: judgePrompt({ pairs: shown }), input: { pairs: shown }, schema: JudgeSchema, effort: config.anthropic.planningEffort, maxTokens: 16000 }, ref);
    return judged(raw, flips);
  } catch (err: any) {
    if (err instanceof PermanentError && err.code === 'refused') throw err;
    return pairs.map(() => ({ winner: 0 as const, clear: false })); // no verdict: keep the first version
  }
}

/** Every missing scene of an episode, in parallel; the opening and the ending get extra drafts and a judge. */
async function writeEpisode(r: Room, e: number): Promise<(SceneElement[] | null)[]> {
  const cards = r.st.outline![e], have = r.st.scenes?.[e] || [];
  const key = (k: number) => r.st.outline![e].length > 1 && (k === 0 || k === cards.length - 1);
  const drafts = config.anthropic.keyDrafts;
  const jobs = cards.flatMap((_, k) => (have[k]?.length ? [] : Array.from({ length: key(k) ? drafts : 1 }, (_, d) => ({ k, d }))));
  const out = await inParallel(jobs, config.anthropic.planConcurrency, (j) => draftScene(r, e, j.k, {
    seed: `${r.p.id}:${e}:${j.k}:${j.d}`,
    variant: j.d ? 'Write a different version from the first one that comes to mind: a bolder, less expected route to the same turn and exit.' : undefined,
  }));
  const versions = cards.map((_, k) => jobs.map((j, i) => (j.k === k ? out[i] : null)).filter((x): x is SceneElement[] => !!x?.length));
  // Openings and endings decide whether anyone watches: a judge picks between the drafts (the first two).
  const contested = cards.map((_, k) => k).filter((k) => versions[k].length > 1);
  const verdicts = await judge(r, contested.map((k) => ({ e, k, a: versions[k][0], b: versions[k][1] })), `judge:key:${e + 1}`);
  return cards.map((_, k) => {
    if (have[k]?.length) return have[k];
    const v = contested.indexOf(k);
    return v >= 0 ? versions[k][verdicts[v].winner] : versions[k][0] || null;
  });
}

/** The polish for one episode: rewrite the scenes the editor or the checks flagged; keep a rewrite only if it's better. */
async function reviseEpisode(r: Room, e: number): Promise<{ scenes: (SceneElement[] | null)[]; notes: string[] }> {
  const { st } = r, cards = st.outline![e], current = st.scenes![e];
  const lint = lintOf(r);
  const flagged = new Map<number, Note[]>();
  for (const s of st.critique?.scenes || []) {
    const k = Math.round(+s?.scene) - 1;
    if (Math.round(+s?.episode || 1) !== e + 1 || !(k >= 0 && k < cards.length) || String(s?.verdict).toLowerCase() !== 'revise') continue;
    const notes = (Array.isArray(s.notes) ? s.notes : []).map((n: any) => ({ problem: String(n?.problem || '').trim(), fix: String(n?.fix || '').trim() })).filter((n: Note) => n.problem || n.fix);
    if (notes.length) flagged.set(k, notes.slice(0, 4));
  }
  for (const l of lint.located) if (l.episode === e + 1 && l.scene - 1 < cards.length) flagged.set(l.scene - 1, [...(flagged.get(l.scene - 1) || []), { problem: l.issue, fix: '' }].slice(0, 6));
  const todo = [...flagged.keys()].filter((k) => current[k]?.length).sort((a, b) => a - b);
  if (!todo.length) return { scenes: current, notes: [] };

  const rewrites = await inParallel(todo, config.anthropic.planConcurrency, (k) => draftScene(r, e, k, { seed: `${r.p.id}:${e}:${k}:rev`, current: sceneText(cards[k], current[k]), notes: flagged.get(k) }));
  // The checks must not get worse; then a judge decides, and a slight preference for the original yields to fewer issues.
  const issuesAt = (k: number, els: SceneElement[]) => {
    const scenes = [...st.scenes!]; scenes[e] = current.map((x, j) => (j === k ? els : x));
    return lintOf({ st: { ...st, scenes }, brief: r.brief }).located.filter((l) => l.episode === e + 1 && l.scene === k + 1).length;
  };
  const candidates = todo.map((k, i) => ({ k, els: rewrites[i] })).filter((x): x is { k: number; els: SceneElement[] } => !!x.els?.length)
    .map((x) => ({ ...x, before: issuesAt(x.k, current[x.k]!), after: issuesAt(x.k, x.els) }))
    .filter((x) => x.after <= x.before);
  const verdicts = await judge(r, candidates.map((x) => ({ e, k: x.k, a: current[x.k]!, b: x.els })), `judge:polish:${e + 1}`);
  const scenes = [...current], notes: string[] = [];
  candidates.forEach((x, i) => {
    const v = verdicts[i];
    const keep = v.winner === 1 || (!v.clear && x.after < x.before);
    if (keep) { scenes[x.k] = x.els; notes.push(`E${e + 1} scene ${x.k + 1}: ${(flagged.get(x.k)?.[0]?.problem || 'revised').slice(0, 140)}`); }
  });
  const rejected = todo.length - notes.length;
  if (rejected) notes.push(`E${e + 1}: kept ${rejected} scene(s) as written: the rewrite was not better`);
  return { scenes, notes };
}

/** Save the final screenplay: project title and look, story bible (with the cards and quality report), episodes. */
async function finish(r: Room, notes: string[]) {
  const { p, brief, st } = r;
  const str = (v: any) => (v == null ? '' : String(v));
  const b = st.bible || {}, w = written(st);
  const report = lintOf(r);
  const n = normalizeImport({
    title: str(b.title).slice(0, 200) || 'Untitled', format: brief.engineFormat, aspect: brief.aspect, resolution: '768P', language: brief.language,
    style: Object.fromEntries(Object.entries(b.style || {}).map(([k, v]) => [k, str(v)])),
    world: w.world,
    characters: (b.characters || []).map((c: any) => ({
      id: str(c.id), name: str(c.name || c.id), age: str(c.age), role: str(c.role),
      description: c.look ? `Distinct look: ${str(c.look)}` : '',
      voice: c.voice ? `Speaks ${str(c.voice.manner)}; ${str(c.voice.rhythm)}.` : '',
    })),
    episodes: w.episodes.map((x, i) => ({ label: w.episodes.length > 1 ? `${unitOf(brief.format)} ${i + 1}` : 'Episode 1', title: str(x.title), script: x.script })),
  });
  const outline = (st.outline || []).map((cards, e) => ({ episode: e + 1, scenes: cards }));
  const quality = { issues: report.issues, episodes: report.episodes, scores: st.critique?.scores || null, doctor_notes: notes, concepts: st.concepts || [], choice: st.choice || null };
  await begin(async (tx) => {
    await tx`delete from episodes where project_id = ${p.id}`; // a retried write replaces, never appends
    await tx`update projects set title = ${n.title}, format = ${n.format}, aspect = ${n.aspect}, language = ${n.language}, style = ${tx.json(n.style)},
      story_bible = ${tx.json({ ...n.story_bible, logline: str(b.logline), treatment: b, outline, quality } as any)},
      updated_at = now() where id = ${p.id}`;
    let i = 0;
    for (const e of n.episodes) await tx`insert into episodes (project_id, idx, label, title, script) values (${p.id}, ${++i}, ${e.label}, ${e.title}, ${e.script})`;
  });
  await sql`update projects set autopilot = autopilot || ${sql.json({ writing: null } as any)}, updated_at = now() where id = ${p.id}`;
  return { done: true, progress: 'Script written' };
}

/** The bible's setups, for the season planner: what the later episodes still have to pay off. */
const openPlants = (bible: any) => (bible?.plants || []).map((p: any) => `${p.id}: ${p.setup} → ${p.payoff}`);

/** The script editor's scores across batches: each batch weighted by how many episodes it read. */
export function mergeScores(prev: any, next: any, before: number, n: number) {
  if (!next || typeof next !== 'object') return prev ?? null;
  if (!prev || typeof prev !== 'object' || !before) return next;
  const out: any = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    const a = +prev[k], b = +(v as any);
    out[k] = Number.isFinite(a) && Number.isFinite(b) ? +((a * before + b * n) / (before + n)).toFixed(2) : v;
  }
  return out;
}

/** All writing steps in one go (tools and tests; the autopilot runs them one job at a time). */
export async function writeProduction(projectId: string, ctx: JobCtx) {
  for (let i = 0; i < 2000; i++) if ((await writeStep(projectId, ctx)).done) return;
  throw new PermanentError('The script could not be written.', 'write_failed');
}

/** The setup fee for a vibe project: the base fee covers the first minutes, each minute after that adds a little. */
export function setupFeeFor(b: Pick<Brief, 'episodes' | 'seconds'>) {
  const c = config.credits, minutes = (b.episodes * b.seconds) / 60;
  return +(c.setupFeeUsd + Math.max(0, Math.ceil(minutes - c.setupFeeIncludedMinutes)) * c.setupFeePerMinuteUsd).toFixed(2);
}

const HEADING_LINE = /^(\.[A-Za-z0-9]|(INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s])/i;
/** A screenplay cut at its scene headings: what comes before the first scene, then one block of text per scene. */
export function splitScenes(script: string): { preamble: string; scenes: string[] } {
  const lines = String(script || '').replace(/\r/g, '').split('\n');
  const heads = lines.map((l, i) => (HEADING_LINE.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  if (!heads.length) return { preamble: '', scenes: [lines.join('\n').trim()].filter(Boolean) };
  return {
    preamble: lines.slice(0, heads[0]).join('\n').trim(),
    scenes: heads.map((h, k) => lines.slice(h, heads[k + 1] ?? lines.length).join('\n').trim()),
  };
}
export const joinScenes = (x: { preamble: string; scenes: string[] }) => [x.preamble, ...x.scenes].filter(Boolean).join('\n\n') + '\n';

/**
 * Rewrite one scene of a written screenplay from the customer's note (step by step, paid). The writer gets the scene's
 * card, the story bible and the scene as it stands now, so a scene the customer edited by hand is rewritten from their text.
 */
export async function rewriteScene(episodeId: string, k: number, note: string) {
  const [ep] = await sql`select * from episodes where id = ${episodeId}`;
  if (!ep) throw new PermanentError('episode not found');
  const [p] = await sql`select * from projects where id = ${ep.project_id}`;
  const sb = p.story_bible || {}, bible = sb.treatment;
  const outline: CardOut[][] = (sb.outline || []).map((o: any) => o.scenes || []);
  const e = ep.idx - 1, cards = outline[e];
  if (!bible || !cards?.length) throw new PermanentError('This script has no scene cards to write from.', 'bad_state');
  const parts = splitScenes(ep.script);
  if (!(k >= 0 && k < parts.scenes.length)) throw new PermanentError('scene not found', 'not_found');
  const brief = p.brief as Brief, long = isLongForm(brief);
  const ask = async <T>(call: ClaudeCall<T>, ref: string) => {
    const r = await claudeJSON<T>({ ...call, bulk: long });
    await recordUsage({ ownerId: p.owner_id, projectId: p.id, kind: 'llm', units: llmUnits(r.usage), cost: llmCost(r.model, r.usage), ref });
    return r.data;
  };
  const room: Room = { p, brief, st: { bible, outline, scenes: [] }, ask };
  const card = Math.min(k, cards.length - 1);
  const els = await draftScene(room, e, card, { seed: `${p.id}:${e}:${k}:${Date.now()}`, current: parts.scenes[k], notes: [{ problem: `The customer asks: ${note}`, fix: '' }] });
  if (!els?.length) throw new Error('The scene could not be rewritten just now.');
  const heading = parts.scenes[k].split('\n')[0].trim();
  const before = parts.scenes[k];
  const rewritten = sceneFountain(heading, els).trim();
  // The script may have changed while this scene was being written (another scene's rewrite, an edit). Write only onto
  // the version this rewrite read; if it moved on, put the new scene into the latest script as long as this scene
  // itself wasn't changed in the meantime. Otherwise stop (and the customer is refunded) instead of losing an edit.
  let r: any = null;
  for (let tries = 0; tries < 3 && !r; tries++) {
    const [cur] = await sql`select script, script_version from episodes where id = ${ep.id}`;
    const now = splitScenes(cur.script);
    if (now.scenes.length !== parts.scenes.length || now.scenes[k] !== before) {
      throw new PermanentError(`Scene ${k + 1} was changed while it was being rewritten, so this rewrite was not applied. Ask again on the current version.`, 'conflict');
    }
    now.scenes[k] = rewritten;
    [r] = await sql`update episodes set script = ${joinScenes(now)}, script_version = script_version + 1, updated_at = now()
      where id = ${ep.id} and script_version = ${cur.script_version} returning id`;
  }
  if (!r) throw new Error('The script kept changing while the scene was being saved.');
  await sql`update projects set updated_at = now() where id = ${p.id}`;
  return { episode_id: r.id, scene: k + 1 };
}
