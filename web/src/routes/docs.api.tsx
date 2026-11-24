import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/Logo";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { API_INFO, PRICES } from "@/lib/publicConfig";

export const Route = createFileRoute("/docs/api")({
  head: () => ({
    meta: [
      { title: "API — Backlot" },
      {
        name: "description",
        content: "Make videos and microdramas from your own code. Pay as you go.",
      },
    ],
  }),
  component: ApiDocs,
});

const usd = (n: number) => `$${n.toFixed(2)}`;

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-[#141414] p-4 font-mono text-[12.5px] leading-relaxed text-[#f3efe6]">
      {children}
    </pre>
  );
}
const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[0.9em]">
    {children}
  </code>
);

const SECTIONS: [string, string][] = [
  ["start", "Quick start"],
  ["auth", "Keys"],
  ["videos", "Videos"],
  ["films", "Microdramas and films"],
  ["webhooks", "Webhooks"],
  ["errors", "Errors"],
  ["limits", "Limits and retention"],
  ["pricing", "Pricing"],
];

function ApiDocs() {
  const base = API_INFO.base_url;
  const [minS, maxS] = API_INFO.clip_seconds;
  return (
    <div className="theme-ivory min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="text-xl" aria-label="Backlot home">
            <Logo />
          </Link>
          <nav className="flex gap-5 text-sm text-muted-foreground">
            <a href="/api/v1/openapi.json" className="hover:text-primary">
              openapi.json
            </a>
            <Link to="/developers" className="hover:text-primary">
              Your keys
            </Link>
          </nav>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-[180px_1fr]">
        <aside className="hidden lg:block">
          <nav className="sticky top-8 flex flex-col gap-2 text-sm text-muted-foreground">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="hover:text-primary">
                {label}
              </a>
            ))}
          </nav>
        </aside>
        <main className="min-w-0">
          <h1 className="text-4xl">Backlot API</h1>
          <span className="brand-dash mt-4" />
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-foreground/90">
            Make a 5 to 15 second video from a sentence, a picture, people and products, or a video
            to remix, or a whole microdrama from one idea: written, cast, filmed and edited. Every
            video has sound. You pay as you go from prepaid credit, only for what is delivered.
          </p>
          {!API_INFO.enabled ? (
            <p className="mt-6 max-w-2xl rounded-md border border-border bg-foreground/[0.04] p-4 text-sm">
              The API opens soon. You can make keys on the Developers page now.
            </p>
          ) : null}

          <div className="docs mt-10 space-y-4 text-[15px] leading-relaxed text-foreground/90 [&_h2]:scroll-mt-8 [&_h2]:pt-6 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:pt-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
            <h2 id="start">Quick start</h2>
            <ol className="ml-5 list-decimal space-y-1">
              <li>
                Sign in, add credit on{" "}
                <Link to="/billing" className="underline">
                  Billing
                </Link>
                , and make a key on{" "}
                <Link to="/developers" className="underline">
                  Developers
                </Link>
                .
              </li>
              <li>Ask for a video. It starts at once and takes a minute or two.</li>
              <li>
                Get it when its <C>status</C> is <C>succeeded</C>, or receive a webhook.
              </li>
            </ol>
            <Code>{`curl ${base}/videos \\
  -H "Authorization: Bearer $BACKLOT_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: 6f1d2c1e-order-1042" \\
  -d '{
    "prompt": "A red kite climbs over a windy beach at golden hour.",
    "duration": 5,
    "aspect_ratio": "9:16",
    "webhook_url": "https://example.com/hooks/backlot"
  }'`}</Code>
            <Code>{`{
  "id": "6f1d…", "object": "video", "status": "queued", "mode": "text",
  "duration": 5, "aspect_ratio": "9:16", "resolution": "768P", "cost_usd": ${(PRICES.per_second_usd * 5).toFixed(2)},
  "output": null, "error": null, "created_at": "…", "expires_at": null
}`}</Code>

            <h2 id="auth">Keys</h2>
            <p>
              Send your key in every request: <C>Authorization: Bearer bk_live_…</C>. A key is shown
              once when you make it; keep it on your server, never in an app or a web page. Each key
              can have a monthly spending limit. Revoking a key stops it at once.
            </p>

            <h2 id="videos">Videos</h2>
            <p>
              <C>POST /videos</C> makes one clip of {minS} to {maxS} seconds at 768P (an MP4 with
              sound). What you send decides the kind:
            </p>
            <ul>
              <li>
                <strong>Text to video:</strong> just a <C>prompt</C>.
              </li>
              <li>
                <strong>Image to video:</strong> <C>first_frame</C>: the picture becomes the first
                frame.
              </li>
              <li>
                <strong>People and products:</strong> <C>images</C> (up to 9, each with an optional{" "}
                <C>label</C>) and an optional <C>audio</C> voice (2 to 14 seconds).
              </li>
              <li>
                <strong>Remix:</strong> a <C>video</C> (the first 15 seconds are used) and up to 8{" "}
                <C>images</C>.
              </li>
            </ul>
            <p>
              Files are an https URL we download, or a data URI (<C>data:image/png;base64,…</C>).
              Pictures up to 20 MB (JPEG, PNG or WebP), videos up to 100 MB (MP4 or MOV), voices up
              to 25 MB (MP3, WAV or M4A). In the prompt, refer to them as “image 2”, “video 1” or
              “voice 1”, or with the model’s tags <C>&lt;Picture 2&gt;</C>, <C>&lt;Video 1&gt;</C>,{" "}
              <C>&lt;Audio 1&gt;</C>. Any request with files must say{" "}
              <C>"rights_confirmed": true</C>: you have the rights to them, including the permission
              of anyone shown or heard.
            </p>
            <Code>{`POST /videos
{
  "prompt": "Maya in image 1 holds up the sneaker in image 2 and says: These changed my mornings.",
  "duration": 8,
  "images": [
    { "url": "https://cdn.example.com/maya.jpg", "label": "Maya" },
    { "url": "data:image/png;base64,iVBORw0…" }
  ],
  "audio": { "url": "https://cdn.example.com/maya.mp3", "label": "Maya" },
  "rights_confirmed": true,
  "metadata": { "order": "A-1042" }
}`}</Code>
            <p>
              <C>GET /videos/{"{id}"}</C> returns the video; its <C>status</C> goes <C>queued</C> →{" "}
              <C>processing</C> → <C>succeeded</C>, or <C>failed</C> / <C>refused</C> (never
              charged), and <C>expired</C> after the retention period. A succeeded video has{" "}
              <C>output.url</C>, a signed link valid for 24 hours (get the video again for a fresh
              one). <C>GET /videos?limit=20&starting_after={"{id}"}</C> lists yours, newest first.{" "}
              <C>DELETE /videos/{"{id}"}</C> stops it if it is still being made (refunding its hold)
              and deletes its files.
            </p>

            <h2 id="films">Microdramas and films</h2>
            <p>
              <C>POST /films</C> turns an idea into finished episodes: a writers’ room writes the
              story and the screenplay, characters and sets are cast and designed, every shot is
              planned and filmed with dialogue, and each episode is edited into one video. A{" "}
              <C>microdrama</C> is vertical (9:16); <C>short_film</C>, <C>web_series</C> and{" "}
              <C>youtube</C> are 16:9. A film made through the API is at most{" "}
              {Math.round(API_INFO.film_max_seconds / 60)} minutes long.
            </p>
            <Code>{`POST /films
{
  "prompt": "A night-shift nurse finds a letter that proves her husband is alive.",
  "format": "microdrama",
  "episodes": 3,
  "episode_seconds": 60,
  "max_cost_usd": 40,
  "webhook_url": "https://example.com/hooks/backlot"
}`}</Code>
            <p>
              The setup fee is taken when the film starts. Once its shots are planned, the film
              stops at its price (<C>status: "awaiting_approval"</C>). With <C>auto_approve</C> (the
              default) it goes on by itself if the total is within <C>max_cost_usd</C> and your
              credit covers it; otherwise it waits for <C>POST /films/{"{id}"}/approve</C>, and{" "}
              <C>approval.reason</C> says why. Statuses: <C>writing</C> → <C>awaiting_approval</C> →{" "}
              <C>filming</C> → <C>editing</C> → <C>succeeded</C>, or <C>failed</C>. Each episode has
              its own <C>output.url</C>. <C>POST /films/{"{id}"}/retry</C> continues a failed film
              from where it stopped; <C>POST /films/quote</C> prices a film before you make it.
            </p>

            <h2 id="webhooks">Webhooks</h2>
            <p>
              With a <C>webhook_url</C> we POST the object when it changes state:{" "}
              <C>video.succeeded</C>, <C>video.failed</C>, <C>film.awaiting_approval</C>,{" "}
              <C>film.succeeded</C>, <C>film.failed</C>. Reply with any 2xx within 10 seconds.
              Otherwise we try again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 12
              hours. Every delivery is signed with your account’s signing secret (Developers page):
            </p>
            <Code>{`Backlot-Signature: t=1731600000,v1=5257a869e7…
signed text: "<t>.<raw request body>"   HMAC-SHA256 with your secret, hex`}</Code>
            <Code>{`// Node.js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // older than 5 minutes
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}`}</Code>
            <Code>{`# Python
import hashlib, hmac, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{parts['t']}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])`}</Code>

            <h2 id="errors">Errors</h2>
            <p>
              Every error has the same shape, and every response has an <C>X-Request-Id</C> (quote
              it to support):
            </p>
            <Code>{`{ "error": { "type": "invalid_request", "code": "invalid_request", "message": "duration: …", "param": "duration" } }`}</Code>
            <ul>
              <li>
                <C>400 invalid_request</C>: a field is wrong (<C>param</C> names it)
              </li>
              <li>
                <C>401 authentication_error</C>: missing, unknown or revoked key
              </li>
              <li>
                <C>402 insufficient_credit</C>: add credit; nothing was made
              </li>
              <li>
                <C>403 permission_error</C>: the key’s monthly limit, or API access suspended
              </li>
              <li>
                <C>404 not_found</C>, <C>409</C>: wrong state, or the same Idempotency-Key still
                running
              </li>
              <li>
                <C>422 content_refused</C>: refused by the content check (never charged)
              </li>
              <li>
                <C>429 rate_limited</C>: slow down; see <C>Retry-After</C>
              </li>
              <li>
                <C>5xx</C>: our side; safe to retry with the same <C>Idempotency-Key</C>
              </li>
            </ul>
            <p>
              Send an <C>Idempotency-Key</C> header (up to 255 characters) with every{" "}
              <C>POST /videos</C> and <C>POST /films</C>: retrying with the same key returns the
              first answer and never makes or charges twice. The same key with a different body is a
              422. Keys are kept 24 hours.
            </p>

            <h2 id="limits">Limits and retention</h2>
            <ul>
              <li>
                {API_INFO.requests_per_minute} requests a minute per key (see the{" "}
                <C>X-RateLimit-*</C> headers)
              </li>
              <li>
                {API_INFO.creates_per_minute} new videos and films a minute per account;{" "}
                {API_INFO.max_active} videos and {API_INFO.max_active_films} films in progress at
                once
              </li>
              <li>Request bodies up to 40 MB (for data URIs)</li>
              <li>
                Videos and films are deleted {API_INFO.retention_days} days after they finish (1 day
                after a failure). Download what you keep.
              </li>
              <li>Repeated content refusals suspend a key’s account until we review it.</li>
            </ul>

            <h2 id="pricing">Pricing</h2>
            <ul>
              <li>
                Video: {usd(PRICES.per_second_usd)} per second of finished video (a 5-second clip is{" "}
                {usd(PRICES.per_second_usd * 5)}). The price is held while it is made and refunded
                if it fails or is refused.
              </li>
              <li>
                Films: a {usd(PRICES.setup_fee_usd)} setup fee for writing, casting and planning,
                then {usd(PRICES.per_second_usd)} per second filmed. Failed shots are refunded.
              </li>
              <li>
                No subscription needed: top up on{" "}
                <Link to="/billing" className="underline">
                  Billing
                </Link>
                . <C>GET /pricing</C> returns current prices and limits (no key needed).
              </li>
            </ul>
            <p>
              The full contract is in{" "}
              <a href="/api/v1/openapi.json" className="underline">
                openapi.json
              </a>
              . By using the API you agree to the{" "}
              <Link to="/terms" className="underline">
                Terms
              </Link>
              .
            </p>
          </div>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
