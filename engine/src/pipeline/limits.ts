// How much screenplay one request may hold, and the fees that grow with a script's length. Together they keep the
// AI work behind any one request bounded and paid for: nobody can hand in a 2 MB script for a flat fee.

import { config } from '../config.js';
import { sql } from '../db.js';
import { PermanentError } from '../queue.js';

const HEADING = /^(\.[A-Za-z0-9]|(INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s])/i;
const round = (usd: number) => Math.round(usd * 100) / 100;
const n = (v: number) => v.toLocaleString('en-US');

/** How many scenes a screenplay has, by its scene headings. A script without headings counts as one scene. */
export function countScenes(script: string): number {
  const heads = String(script || '').replace(/\r/g, '').split('\n').filter((l) => HEADING.test(l.trim())).length;
  return heads || (String(script || '').trim() ? 1 : 0);
}

/** A script a customer wrote, pasted or edited has to fit in one episode. Returns the script. */
export function checkScript(script: unknown, what = 'The script'): string {
  if (typeof script !== 'string') throw new PermanentError(`${what} must be text.`, 'bad_input');
  const { maxEpisodeChars, maxEpisodeScenes } = config.scripts;
  if (script.length > maxEpisodeChars) {
    throw new PermanentError(`${what} is ${n(script.length)} characters long; one episode holds up to ${n(maxEpisodeChars)}. Split it into more episodes.`, 'too_long');
  }
  const scenes = countScenes(script);
  if (scenes > maxEpisodeScenes) throw new PermanentError(`${what} has ${scenes} scenes; one episode holds up to ${maxEpisodeScenes}. Split it into more episodes.`, 'too_long');
  return script;
}

/** Casting, costume and set design from the script: the flat fee covers the included scenes, each one past them adds a little. */
export function breakdownFee(scenes: number): number {
  const c = config.credits;
  return round(c.actions.breakdown + Math.max(0, scenes - c.breakdownIncludedScenes) * c.breakdownPerSceneUsd);
}
/** The director's plan and shot list for one episode: the flat fee covers the included scenes, each one past them adds. */
export function planFee(scenes: number): number {
  const c = config.credits;
  return round(c.actions.plan + Math.max(0, scenes - c.planIncludedScenes) * c.planPerSceneUsd);
}

export async function projectScenes(projectId: string): Promise<number> {
  const eps = await sql`select script from episodes where project_id = ${projectId}`;
  return eps.reduce((t: number, e: any) => t + countScenes(e.script), 0);
}
export async function episodeScenes(episodeId: string): Promise<number> {
  const [e] = await sql`select script from episodes where id = ${episodeId}`;
  return e ? countScenes(e.script) : 0;
}
