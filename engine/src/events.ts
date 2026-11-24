// A tiny in-process notice board. The pipeline says what happened to a project; other parts of the engine (the
// public API: webhooks, expiry dates, automatic approval) react. Listeners must be safe to call more than once for
// the same event, because the pipeline's steps can run again after a restart.

export type ProjectStage = 'ready' | 'done' | 'failed';
export interface ProjectEvent { projectId: string; stage: ProjectStage }
type Listener = (e: ProjectEvent) => Promise<void>;

const listeners: Listener[] = [];
export function onProjectEvent(f: Listener) { listeners.push(f); }

/** Tell everyone a project reached a stage that matters outside the pipeline. A failing listener never fails the pipeline. */
export async function projectEvent(e: ProjectEvent) {
  for (const f of listeners) await f(e).catch((x) => console.error(`[events] ${e.stage} ${e.projectId}:`, x?.message || x));
}

/**
 * Asked when a film reaches the price checkpoint: may it start filming without anyone pressing the button?
 * (The public API answers for films made through it; the app's films always wait for the customer.)
 */
let autoApprove: ((project: any) => Promise<boolean>) | null = null;
export function setAutoApprove(f: (project: any) => Promise<boolean>) { autoApprove = f; }
export const mayAutoApprove = async (project: any) => (autoApprove ? autoApprove(project).catch((x) => { console.error('[events] auto-approve:', x?.message || x); return false; }) : false);
