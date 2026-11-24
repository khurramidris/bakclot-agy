import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Check, Play } from "lucide-react";

import heroImage from "@/assets/hero-stage.jpg";
import { Logo, StoryLine } from "@/components/brand/Logo";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { usd } from "@/lib/engine";
import { PRICES } from "@/lib/publicConfig";
import { publicPlan } from "@/lib/supabase";
import { cn } from "@/lib/utils";

const DESCRIPTION =
  "Describe a story in a sentence. Backlot writes, casts, films and edits it into a finished microdrama, short film, web series or YouTube video. Or turn text, a photo or a video into a quick clip.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Backlot — an open studio for every story" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Backlot — an open studio for every story" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const STEPS = [
  {
    n: "01",
    title: "One sentence in",
    body: "Your idea becomes a full script with a hook, turns and an ending.",
  },
  {
    n: "02",
    title: "A cast that stays put",
    body: "Characters, wardrobe and sets are locked, so they look the same in every shot.",
  },
  {
    n: "03",
    title: "See the price first",
    body: "Read the script, meet the cast, check the price. Nothing is filmed until you say go.",
  },
  {
    n: "04",
    title: "A finished film out",
    body: "Lip-synced dialogue, every shot joined into one episode, ready for your captions and music. Fix any shot with a note.",
  },
];

const FORMATS = [
  {
    title: "Microdrama",
    line: "Vertical episodes that hook in three seconds.",
    meta: "9:16 · ~75 s",
    pos: "30% 50%",
  },
  {
    title: "Short film",
    line: "A complete story, start to finish.",
    meta: "16:9 · 1–5 min",
    pos: "70% 40%",
  },
  {
    title: "Web series",
    line: "Characters who come back every episode.",
    meta: "16:9 · 2–3 episodes",
    pos: "50% 60%",
  },
  {
    title: "YouTube story",
    line: "Hook-first storytelling for your channel.",
    meta: "16:9 · 1–5 min",
    pos: "90% 50%",
  },
];

const pill =
  "inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-colors";

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <Hero />
      <HowItWorks />
      <Formats />
      <Pricing />
      <section className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-24 text-center">
          <p className="script text-5xl text-primary sm:text-6xl">Create what’s next.</p>
          <p className="max-w-md text-muted-foreground">
            Your next story is one sentence away. Write it, and we’ll film it.
          </p>
          <Link
            to="/auth"
            search={{ mode: "signup" }}
            className={cn(pill, "bg-primary text-primary-foreground hover:bg-primary/90")}
          >
            Start creating <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-cinema">
      <img
        src={heroImage}
        alt="A film crew on a night backlot: camera rig, monitors and a warm key light"
        width={1920}
        height={1088}
        className="absolute inset-0 size-full object-cover opacity-70"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-cinema via-cinema/80 to-cinema/10" />
      <div className="absolute inset-0 bg-gradient-to-t from-cinema via-cinema/10 to-cinema/60" />
      <div className="absolute inset-0 [background-image:var(--gradient-key-light)]" />

      <header className="relative z-10">
        <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-6 px-6">
          <Link to="/" className="text-2xl" aria-label="Backlot home">
            <Logo />
          </Link>
          <nav className="flex items-center gap-2 sm:gap-6">
            <a
              href="#how"
              className="hidden text-sm text-foreground/75 hover:text-foreground md:inline"
            >
              How it works
            </a>
            <a
              href="#formats"
              className="hidden text-sm text-foreground/75 hover:text-foreground md:inline"
            >
              Formats
            </a>
            <a
              href="#pricing"
              className="hidden text-sm text-foreground/75 hover:text-foreground md:inline"
            >
              Pricing
            </a>
            <Link
              to="/auth"
              className="rounded-full border border-foreground/40 px-4 py-1.5 text-sm font-medium hover:border-foreground"
            >
              Log in
            </Link>
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              className="hidden rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 sm:inline-flex"
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <div className="relative z-10 mx-auto grid max-w-6xl gap-10 px-6 pb-24 pt-14 sm:pt-20 lg:grid-cols-[1fr_auto] lg:pb-32">
        <div>
          <StoryLine className="text-foreground/70" />
          <span className="brand-dash mt-4" />
          <h1 className="sr-only">Backlot: an open studio for every story</h1>
          <div className="mt-10 text-[64px] text-ivory sm:text-[104px] lg:text-[128px]" aria-hidden>
            <Logo />
          </div>
          <p className="mt-8 font-display text-2xl font-bold tracking-tight sm:text-3xl">
            An open studio for every story.
          </p>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-foreground/75">
            Type a story, get a film. Microdramas, short films, web series and YouTube stories from
            a single prompt. You approve the script and the price before anything is filmed. Need
            just one shot? Quick clips turn a line of text, a photo or a video into 5 to 15 seconds
            of footage with sound.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              className={cn(pill, "bg-primary pr-2 text-primary-foreground hover:bg-primary/90")}
            >
              Start creating
              <span className="flex size-7 items-center justify-center rounded-full bg-primary-foreground text-primary">
                <Play className="size-3.5 fill-current" />
              </span>
            </Link>
            <a
              href="#how"
              className={cn(pill, "border border-foreground/40 hover:border-foreground")}
            >
              <span className="flex size-5 items-center justify-center rounded-full border border-current">
                <Play className="size-2.5 fill-current" />
              </span>
              See how it works
            </a>
          </div>
        </div>
        <div className="hidden flex-col items-end justify-end gap-10 lg:flex">
          <p className="script max-w-[16rem] text-right text-5xl text-ivory">
            Make something worth watching.
            <span className="brand-dash ml-auto mt-4 w-24 -rotate-3" />
          </p>
          <div className="text-right">
            <p className="meta-label leading-loose text-foreground/80">
              Same stories.
              <br />
              New worlds.
            </p>
            <span className="brand-dash ml-auto mt-3" />
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="theme-ivory scroll-mt-4">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <span className="meta-label">How it works</span>
            <h2 className="mt-3 text-4xl sm:text-5xl">From idea to first shot.</h2>
            <span className="brand-dash mt-5" />
          </div>
          <p className="max-w-sm text-muted-foreground">
            A writers’ room, casting, a film crew and an editor, working on your story in minutes,
            not months.
          </p>
        </div>
        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className="bg-card p-8">
              <div className="font-display text-5xl font-black tracking-tight text-primary">
                {s.n}
              </div>
              <h3 className="mt-8 text-lg">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Title cards in the style of the brand's series artwork: condensed headline, orange dash, episode tag. */
function Formats() {
  return (
    <section id="formats" className="scroll-mt-4">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <span className="meta-label">Formats</span>
        <h2 className="mt-3 text-4xl sm:text-5xl">Same stories. New worlds.</h2>
        <span className="brand-dash mt-5" />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FORMATS.map((f, i) => (
            <article
              key={f.title}
              className="group relative flex aspect-[3/4] flex-col justify-end overflow-hidden rounded-xl border border-border bg-cinema p-6"
            >
              <img
                src={heroImage}
                alt=""
                aria-hidden
                style={{ objectPosition: f.pos }}
                className="absolute inset-0 size-full object-cover opacity-55 transition-transform duration-700 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-cinema via-cinema/70 to-cinema/10" />
              <div className="relative">
                <p className="meta-label text-foreground/70">A Backlot original</p>
                <h3 className="mt-3 font-logo text-4xl font-normal uppercase leading-[0.95] tracking-normal text-ivory">
                  {f.title}
                </h3>
                <span className="brand-dash mt-4" />
                <p className="mt-4 text-sm text-foreground/80">{f.line}</p>
                <p className="meta-label mt-4 text-foreground/60">
                  Ep. {String(i + 1).padStart(2, "0")} · {f.meta}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  const plan = publicPlan;
  return (
    <section id="pricing" className="relative scroll-mt-4 overflow-hidden border-t border-border">
      <div className="absolute inset-0 [background-image:var(--gradient-key-light)]" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2">
        <div>
          <span className="meta-label">Pricing</span>
          <h2 className="mt-3 text-4xl leading-tight sm:text-5xl">
            One plan. Everything included.
          </h2>
          <span className="brand-dash mt-5" />
          <p className="mt-6 max-w-md text-muted-foreground">
            Your monthly credits cover writing, casting, filming and editing. You see the price of
            every film and approve it before anything is rendered. Need more? Top up any time.
          </p>
          <div className="mt-8 max-w-md border-l-2 border-primary pl-4">
            <div className="meta-label">For developers</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Make clips and whole microdramas from your own code with the Backlot API. Pay as you
              go at {usd(PRICES.per_second_usd)} per second of finished video, no plan needed.{" "}
              <Link
                to="/docs/api"
                className="text-foreground underline underline-offset-2 hover:text-primary"
              >
                Read the API docs
              </Link>
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-primary/50 bg-card p-8 shadow-[var(--shadow-glow)]">
          <div className="meta-label text-primary">{plan.name}</div>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="font-display text-6xl font-black tracking-tight">
              {usd(plan.price_usd)}
            </span>
            <span className="text-muted-foreground">/month</span>
          </div>
          <ul className="mt-6 space-y-3 text-sm">
            {[
              `${usd(plan.credits_usd)} of credits every month`,
              `${plan.storage_gb} GB of storage for your films and clips`,
              "Quick clips from text, a photo or a video",
              "Top-up credit packs any time, and they never expire",
              "Failed renders refunded automatically",
              "Cancel any time",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                {line}
              </li>
            ))}
          </ul>
          <Link
            to="/auth"
            search={{ mode: "signup" }}
            className={cn(
              pill,
              "mt-8 w-full bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            Get started
          </Link>
        </div>
      </div>
    </section>
  );
}
