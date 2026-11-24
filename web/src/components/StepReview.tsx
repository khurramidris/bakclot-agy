// The step-by-step stops of a story film: choose the story, check the script, check the cast and sets. Everything
// the customer asks the AI to make again is paid (the price is on the button); their own edits and uploads are free.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  Upload,
  Wand2,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { engine, usd, type Asset, type Me, type ProjectDetail } from "@/lib/engine";
import { cn } from "@/lib/utils";

const useMe = () => useQuery({ queryKey: ["me"], queryFn: engine.me });
const priceLabel = (me: Me | undefined, usdValue: number | undefined) =>
  me?.credits_enforced && usdValue ? ` · ${usd(usdValue)}` : "";

function useRefresh(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["project", projectId] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
}

function StepHeader({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-primary/50 bg-card p-6 shadow-[var(--shadow-glow)] sm:flex-row sm:items-center">
      <div className="flex-1">
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{children}</p>
      </div>
      {action}
    </div>
  );
}

// ───────── 1. the story ─────────

export function StoryReview({ data }: { data: ProjectDetail }) {
  const { data: me } = useMe();
  const refresh = useRefresh(data.project.id);
  const w = data.project.autopilot?.writing;
  const concepts = w?.concepts ?? [];
  const recommended = w?.choice?.chosen ?? 0;
  const [pick, setPick] = useState(recommended);
  const [note, setNote] = useState("");
  const [direction, setDirection] = useState("");
  const [asking, setAsking] = useState(false);
  const go = useMutation({
    mutationFn: () => engine.next(data.project.id, { concept: pick, note: note.trim() }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const again = useMutation({
    mutationFn: () => engine.repitch(data.project.id, direction.trim()),
    onSuccess: () => {
      setAsking(false);
      setDirection("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section className="mt-8 space-y-4">
      <StepHeader
        title="Choose your story"
        action={
          <Button onClick={() => go.mutate()} disabled={go.isPending}>
            {go.isPending ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight />}
            Write this one
          </Button>
        }
      >
        Our writers pitched three takes on your idea. Pick one (we marked our favourite), add a note
        if you like, and we write the full story and script from it.
      </StepHeader>
      <div className="grid gap-3 md:grid-cols-3">
        {concepts.map((c, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setPick(i)}
            className={cn(
              "rounded-lg border bg-card p-4 text-left text-sm transition-colors",
              pick === i ? "border-primary bg-primary/10" : "border-border hover:border-primary/60",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{c.title}</span>
              {i === recommended ? (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
                  Our pick
                </span>
              ) : null}
            </div>
            <p className="mt-2">{c.logline}</p>
            <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
              <div>
                <dt className="inline font-semibold text-foreground/80">Opens on: </dt>
                <dd className="inline">{c.hook}</dd>
              </div>
              <div>
                <dt className="inline font-semibold text-foreground/80">The twist: </dt>
                <dd className="inline">{c.turn}</dd>
              </div>
              <div>
                <dt className="inline font-semibold text-foreground/80">Ends on: </dt>
                <dd className="inline">{c.ending}</dd>
              </div>
            </dl>
          </button>
        ))}
      </div>
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Optional: anything to change in the story you picked (a name, the ending, the tone)…"
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">None of these?</span>
        <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
          <RefreshCw className="size-4" /> Three new takes{priceLabel(me, me?.prices.actions.pitch)}
        </Button>
      </div>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Three new takes</DialogTitle>
            <DialogDescription>
              Say what you want different, or leave it empty for three fresh ideas.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Make it a revenge story, set in Karachi, with a happy ending."
          />
          <DialogFooter>
            <Button onClick={() => again.mutate()} disabled={again.isPending}>
              {again.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw />}
              Pitch again{priceLabel(me, me?.prices.actions.pitch)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ───────── 2. the script ─────────

export function ScriptReview({ data }: { data: ProjectDetail }) {
  const refresh = useRefresh(data.project.id);
  const go = useMutation({
    mutationFn: () => engine.next(data.project.id),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const many = data.episodes.length > 1;
  return (
    <section className="mt-8 space-y-4">
      <StepHeader
        title="Check your script"
        action={
          <Button onClick={() => go.mutate()} disabled={go.isPending}>
            {go.isPending ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight />}
            Script is good: cast it
          </Button>
        }
      >
        Read it scene by scene. Edit any scene yourself for free, or ask us to rewrite it from a
        note. When it reads right, we design the cast and sets.
      </StepHeader>
      {data.episodes.map((e, i) => (
        <details
          key={e.id}
          open={i === 0}
          className="overflow-hidden rounded-lg border border-border bg-card"
        >
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
            {many ? e.label : "Script"}
            {e.title ? ` · ${e.title}` : ""}
          </summary>
          <EpisodeEditor episodeId={e.id} projectId={data.project.id} />
        </details>
      ))}
    </section>
  );
}

function EpisodeEditor({ episodeId, projectId }: { episodeId: string; projectId: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: ep } = useQuery({
    queryKey: ["episode", episodeId],
    queryFn: () => engine.episode(episodeId),
  });
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [rewriting, setRewriting] = useState<number | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["episode", episodeId] });

  const save = useMutation({
    mutationFn: (i: number) => {
      const scenes = ep!.scenes.map((s, k) => (k === i ? draft.trim() : s.text));
      // What came before the first scene (a title page, if any) stays as it was.
      const head = ep!.script.slice(0, Math.max(0, ep!.script.indexOf(ep!.scenes[0]?.text ?? "")));
      return engine.saveScript(episodeId, `${head}${scenes.join("\n\n")}\n`);
    },
    onSuccess: () => {
      setEditing(null);
      void reload();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rewrite = useMutation({
    mutationFn: async (scene: number) => {
      const { job_id } = await engine.rewriteScene(episodeId, scene, note.trim());
      setNoteFor(null);
      setNote("");
      setRewriting(scene);
      for (let i = 0; i < 300; i++) {
        const j = await engine.job(job_id);
        if (j.status === "done") return;
        if (j.status === "failed") throw new Error(j.error || "The scene could not be rewritten.");
        await new Promise((r) => setTimeout(r, 2000));
      }
    },
    onSuccess: () => toast.success("Scene rewritten"),
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      setRewriting(null);
      void reload();
      void qc.invalidateQueries({ queryKey: ["me"] });
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  if (!ep) return <p className="border-t border-border px-4 py-3 text-sm">Loading…</p>;
  return (
    <div className="divide-y divide-border border-t border-border">
      {ep.scenes.map((s, i) => (
        <div key={i} className="px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">Scene {s.n}</span>
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setEditing(i);
                  setDraft(s.text);
                }}
              >
                <Pencil className="size-3" /> Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={rewriting !== null}
                onClick={() => setNoteFor(s.n)}
              >
                {rewriting === s.n ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Wand2 className="size-3" />
                )}
                Rewrite{priceLabel(me, me?.prices.actions.scene)}
              </Button>
            </span>
          </div>
          {editing === i ? (
            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(24, draft.split("\n").length + 2)}
                className="font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => save.mutate(i)} disabled={save.isPending}>
                  <Check className="size-4" /> Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{s.text}</pre>
          )}
        </div>
      ))}
      <Dialog open={noteFor !== null} onOpenChange={(o) => !o && setNoteFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rewrite scene {noteFor}</DialogTitle>
            <DialogDescription>
              Say what should change. The rest of the script stays as it is.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="He should find out here, not in the next scene. Make her angrier."
          />
          <DialogFooter>
            <Button
              onClick={() => noteFor && rewrite.mutate(noteFor)}
              disabled={note.trim().length < 3 || rewrite.isPending}
            >
              <Wand2 className="size-4" /> Rewrite{priceLabel(me, me?.prices.actions.scene)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────── 3. the cast and sets ─────────

const KIND_LABEL: Record<string, string> = {
  character: "Character",
  look: "Outfit",
  location: "Set",
  set_variant: "Set variation",
  prop: "Prop",
  voice: "Voice",
};

export function CastReview({ data }: { data: ProjectDetail }) {
  const refresh = useRefresh(data.project.id);
  const { data: assets } = useQuery({
    queryKey: ["assets", data.project.id],
    queryFn: () => engine.assets(data.project.id),
    refetchInterval: (q) =>
      q.state.data?.some((a) => a.status === "planned" || a.status === "generating") ? 3000 : false,
  });
  const shown = assets?.filter((a) => !a.meta?.unused && a.kind !== "voice") ?? [];
  const busy = shown.some((a) => a.status === "planned" || a.status === "generating");
  const go = useMutation({
    mutationFn: () => engine.next(data.project.id),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section className="mt-8 space-y-4">
      <StepHeader
        title="Check your cast and sets"
        action={
          <Button onClick={() => go.mutate()} disabled={go.isPending || busy}>
            {go.isPending || busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight />}
            {busy ? "Pictures in progress" : "All good: plan the shots"}
          </Button>
        }
      >
        These pictures keep every face and room the same from shot to shot. Make any of them again
        (with a note), change the description, or upload your own.
      </StepHeader>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((a) => (
          <AssetCard key={a.id} asset={a} projectId={data.project.id} />
        ))}
      </div>
    </section>
  );
}

function AssetCard({ asset: a, projectId }: { asset: Asset; projectId: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [description, setDescription] = useState(a.description);
  const [consent, setConsent] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const person = a.kind === "character" || a.kind === "look";
  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["assets", projectId] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const { data: history } = useQuery({
    queryKey: ["asset-history", a.id],
    queryFn: () => engine.assetHistory(a.id),
    enabled: open && !!a.history_count,
  });
  const again = useMutation({
    mutationFn: async () => {
      if (description.trim() !== a.description) await engine.describe(a.id, description.trim());
      return engine.regenerate(a.id, note.trim());
    },
    onSuccess: () => {
      setOpen(false);
      setNote("");
      reload();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const upload = useMutation({
    mutationFn: (f: File) => engine.uploadAsset(a.id, f, consent),
    onSuccess: () => {
      setOpen(false);
      reload();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: (i: number) => engine.restoreAsset(a.id, i),
    onSuccess: () => {
      setOpen(false);
      reload();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const working = a.status === "planned" || a.status === "generating";
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative flex aspect-[3/4] items-center justify-center bg-surface">
        {a.url ? (
          <img src={a.url} alt={a.name} className="size-full object-cover" loading="lazy" />
        ) : null}
        {working ? <Loader2 className="absolute size-5 animate-spin text-primary" /> : null}
        {a.status === "failed" ? (
          <span className="absolute px-2 text-center text-xs text-destructive">
            {a.error || "Couldn't be made"}
          </span>
        ) : null}
      </div>
      <figcaption className="space-y-1 p-2">
        <div className="text-xs font-semibold">{a.name}</div>
        <div className="font-mono text-[10px] uppercase text-muted-foreground">
          {KIND_LABEL[a.kind] ?? a.kind}
          {a.meta?.source === "upload" ? " · yours" : ""}
        </div>
        {a.meta?.stale_parent ? (
          <div className="text-[11px] text-destructive">
            Made from an older picture of the person or place. Approve it again or change it.
          </div>
        ) : a.meta?.place_ref_missing ? (
          <div className="text-[11px] text-muted-foreground">
            Drawn from the description only, so it may not match the original place exactly.
          </div>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full text-xs"
          disabled={working}
          onClick={() => setOpen(true)}
        >
          <RefreshCw className="size-3" /> Change
        </Button>
      </figcaption>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{a.name}</DialogTitle>
            <DialogDescription>
              Make it again from the description and your note, or upload your own picture.
            </DialogDescription>
          </DialogHeader>
          <label className="text-xs font-semibold">Description</label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Optional note: older, shorter hair, a red scarf…"
          />
          <Button onClick={() => again.mutate()} disabled={again.isPending}>
            {again.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw />}
            Make it again{priceLabel(me, me?.prices.actions.image)}
          </Button>
          <div className="border-t border-border pt-3">
            {person ? (
              <label className="mb-2 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5"
                />
                This is me, or I have this person&apos;s permission to use their face.
              </label>
            ) : null}
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              className="w-full"
              disabled={upload.isPending || (person && !consent)}
              onClick={() => file.current?.click()}
            >
              {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload />}
              Upload my own picture (free)
            </Button>
          </div>
          {history?.length ? (
            <div className="border-t border-border pt-3">
              <div className="mb-2 flex items-center gap-1 text-xs font-semibold">
                <History className="size-3" /> Earlier versions (free to go back)
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {history.map((h) =>
                  h.url ? (
                    <button
                      key={h.index}
                      type="button"
                      onClick={() => restore.mutate(h.index)}
                      className="shrink-0 overflow-hidden rounded border border-border hover:border-primary"
                      title="Use this version"
                    >
                      <img src={h.url} alt="" className="h-20 w-16 object-cover" />
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
