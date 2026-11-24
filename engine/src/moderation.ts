// Content check for what customers write and upload before it reaches a video model. MiniMax's hosted API has a filter
// of its own; our self-hosted H3 has none, so quick-clip prompts and uploads, hand-edited shot prompts and uploaded
// reference images pass through here first. Claude (the fast model, low effort) reads the text and pictures and says
// whether they may be made. Verdicts are cached by content hash, so retries and identical retakes cost nothing.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';
import { claudeJSON, llmCost, llmUnits } from './providers/claude.js';
import { PermanentError } from './queue.js';
import { recordUsage } from './usage.js';

export type Verdict = { allowed: boolean; category: string; reason: string };

const VerdictSchema = z.object({
  allowed: z.boolean(),
  category: z.enum(['none', 'minors', 'sexual', 'violence', 'real_person', 'hate', 'self_harm', 'illegal', 'other']),
  reason: z.string(),
});

const SYSTEM = `You check requests for an AI video studio before anything is generated. Customers make short films, ads,
social clips and microdramas. Read the customer's text and look at any pictures, then decide whether the video may be made.

Allow ordinary creative work, including drama, romance without nudity or sex, comedy, action, crime, thriller and horror
violence that isn't gory, product and brand videos, and people in uploaded photos (the customer has confirmed they have
the right to use them).

Refuse when the request or pictures involve:
- minors: anyone who looks under 18 in any sexual, sexualised, romantic-intimate or abusive context (always refuse)
- sexual: nudity, sexual acts, fetish or pornographic content
- violence: graphic gore, torture, mutilation, or real terrorist or extremist propaganda
- real_person: a recognisable celebrity, politician or other public figure by name or likeness (deepfakes), or any real
  person shown in a sexual, violent, humiliating, defamatory or deceptive (fake news, scam) situation
- hate: content attacking people for a protected characteristic
- self_harm: encouraging or showing how to self-harm or commit suicide
- illegal: instructions for weapons or drugs, fraud, or other serious crime

When in doubt about fiction, allow it. When in doubt about minors, sexual content or real public figures, refuse.
Answer with allowed, the category (none when allowed) and a one-sentence reason addressed to the customer.`;

const hashOf = (text: string, images: { data: Buffer }[]) => {
  const h = createHash('sha256').update('v1\n').update(text);
  for (const im of images) h.update(createHash('sha256').update(im.data).digest());
  return h.digest('hex');
};

const CHUNK = 6000;
/** A long text cut into pieces the check reads whole, at paragraph breaks where it can. */
export function chunksOf(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    for (let rest = para; rest.length;) {
      if (cur.length + rest.length + 2 <= size) { cur += (cur ? '\n\n' : '') + rest; rest = ''; }
      else if (cur) { out.push(cur); cur = ''; }
      else { out.push(rest.slice(0, size)); rest = rest.slice(size); }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Whether this text (and pictures, JPEG or PNG) may be sent to a video model. A long text without pictures (a whole
 * screenplay) is read in pieces, so nothing past the first page goes unchecked; the first refusal is the answer.
 */
export async function moderate(o: { ownerId: string; projectId?: string | null; text: string; images?: { mime: string; data: Buffer }[] }): Promise<Verdict> {
  if (!(o.images || []).length && o.text.length > CHUNK && config.moderation && !config.mock) {
    for (const part of chunksOf(o.text).slice(0, 16)) {
      const v = await moderateOne({ ...o, text: part });
      if (!v.allowed) return v;
    }
    return { allowed: true, category: 'none', reason: 'ok' };
  }
  return moderateOne(o);
}

async function moderateOne(o: { ownerId: string; projectId?: string | null; text: string; images?: { mime: string; data: Buffer }[] }): Promise<Verdict> {
  const images = o.images || [];
  if (!config.moderation) return { allowed: true, category: 'none', reason: 'checks are off' };
  if (config.mock) { // the e2e suites use FORCE_SENSITIVE to exercise refusals
    const bad = /FORCE_SENSITIVE/.test(o.text);
    return { allowed: !bad, category: bad ? 'other' : 'none', reason: bad ? 'The mock check refuses FORCE_SENSITIVE.' : 'ok' };
  }
  const hash = hashOf(o.text, images);
  const [hit] = await sql`select allowed, category, reason from moderations where hash = ${hash}`;
  if (hit) return { allowed: hit.allowed, category: hit.category, reason: hit.reason };

  let verdict: Verdict;
  try {
    const r = await claudeJSON({
      task: 'moderation', system: SYSTEM, schema: VerdictSchema, fast: true, effort: 'low', maxTokens: 4000,
      prompt: `Customer request:\n"""\n${o.text.slice(0, 6000)}\n"""\n${images.length ? `${images.length} picture(s) attached.` : 'No pictures.'}`,
      images: images.map((im) => ({ mime: im.mime, b64: im.data.toString('base64') })),
    });
    verdict = { allowed: !!r.data.allowed, category: r.data.allowed ? 'none' : r.data.category || 'other', reason: String(r.data.reason || '').slice(0, 300) };
    await recordUsage({ ownerId: o.ownerId, projectId: o.projectId ?? null, kind: 'llm', units: llmUnits(r.usage), cost: llmCost(r.model, r.usage), ref: 'moderation' });
  } catch (e) {
    // Claude declining to look at it is an answer too.
    if (e instanceof PermanentError && e.code === 'refused') verdict = { allowed: false, category: 'other', reason: 'This request can’t be made on Backlot.' };
    else throw e;
  }
  await sql`insert into moderations (hash, allowed, category, reason) values (${hash}, ${verdict.allowed}, ${verdict.category}, ${verdict.reason})
    on conflict (hash) do nothing`;
  return verdict;
}

/** The error a customer sees when a request is refused (HTTP 422, code sensitive_content). */
export const refusal = (v: Verdict) => Object.assign(
  new PermanentError(`We can’t make this video: ${v.reason || 'it goes against our content rules.'}`, 'sensitive_content'), { status: 422, category: v.category });
