import { Link } from "@tanstack/react-router";

import { Logo, StoryLine } from "@/components/brand/Logo";

/** The brand's black footer bar: logo, orange dash, "An open studio for every story.", and the script sign-off. */
export function SiteFooter() {
  return (
    <footer className="theme-cinema border-t border-border bg-black">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-10 gap-y-6 px-6 py-8">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-xl text-ivory" aria-label="Backlot home">
            <Logo />
          </Link>
          <span className="brand-dash w-10" />
          <span className="meta-label hidden text-foreground/70 sm:inline">
            An open studio for every story.
          </span>
        </div>
        <StoryLine className="hidden text-foreground/60 lg:inline" />
        <div className="flex items-center gap-6">
          <Link to="/docs/api" className="meta-label hover:text-primary">
            API
          </Link>
          <Link to="/terms" className="meta-label hover:text-primary">
            Terms
          </Link>
          <Link to="/privacy" className="meta-label hover:text-primary">
            Privacy
          </Link>
          <span className="script text-2xl text-primary">Create what’s next.</span>
        </div>
      </div>
    </footer>
  );
}
