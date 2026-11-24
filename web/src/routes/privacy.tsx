import { createFileRoute, Link } from "@tanstack/react-router";

import { LegalPage } from "@/components/layout/LegalPage";
import { LEGAL } from "@/lib/legal";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy Policy — Backlot" }] }),
  component: Privacy,
});

// Plain-language draft. It must be reviewed by a lawyer before launch (see docs/DEPLOY.md).
function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This policy explains what personal data {LEGAL.company} ("Backlot", "we") collects when you
        use Backlot, why, who we share it with, and your rights. We're the controller of this data.
        Contact: {LEGAL.email}.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account:</strong> your email address, name, and password (stored only as a secure
          hash by our sign-in provider). If you sign in with Google, we get your name and email from
          Google.
        </li>
        <li>
          <strong>Your content:</strong> prompts, scripts, generated and uploaded images and voices,
          video clips and finished films, and the notes you write when fixing shots.
        </li>
        <li>
          <strong>Billing:</strong> your plan status, credit balance and history, and payment
          records. Your card details go straight to Lemon Squeezy, and we never see or store them.
        </li>
        <li>
          <strong>Technical:</strong> server logs with your IP address, browser and request times,
          kept for security and to fix problems.
        </li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>
          To run the service you signed up for: making, storing and showing your videos (contract).
        </li>
        <li>To take payments and keep accounting records (contract and legal obligation).</li>
        <li>
          To keep Backlot secure and stop abuse, including checking content against our rules
          (legitimate interest).
        </li>
        <li>
          To email you about your account, billing and important changes (contract). We only send
          marketing email if you opt in.
        </li>
      </ul>
      <p>We don't sell your personal data, and we don't use your content to train AI models.</p>

      <h2>Who processes it for us</h2>
      <p>We use these service providers, and each gets only what it needs to do its job for us:</p>
      <ul>
        <li>
          <strong>Supabase:</strong> sign-in and our database.
        </li>
        <li>
          <strong>Cloudflare:</strong> storage for your files (pictures, voices and videos).
        </li>
        <li>
          <strong>Railway:</strong> hosting for our servers.
        </li>
        <li>
          <strong>RunPod:</strong> GPU servers that render your video clips.
        </li>
        <li>
          <strong>Anthropic:</strong> writes scripts and plans shots from your prompts (Claude).
        </li>
        <li>
          <strong>MiniMax:</strong> generates reference images and character voices, and, on some
          plans, video.
        </li>
        <li>
          <strong>Lemon Squeezy:</strong> checkout, subscriptions, invoices and tax, as Merchant of
          Record. It handles your payment details under its own privacy policy.
        </li>
      </ul>
      <p>
        Some of these providers process data outside your country, including in the United States.
        Where the law requires it, we rely on safeguards such as the European Commission's Standard
        Contractual Clauses.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          Your videos and project files stay until you delete them, or until after your account
          closes (see below).
        </li>
        <li>
          Deleting a video removes its files from our storage straight away. Copies in backups
          disappear within 30 days.
        </li>
        <li>
          If your subscription ends, we keep your files for at least 90 days, then may delete them
          after warning you by email.
        </li>
        <li>
          Payment and credit records are kept as long as tax and accounting law requires (usually 6
          to 10 years).
        </li>
        <li>Server logs, and the log of API requests, are kept for up to 30 days.</li>
        <li>
          Videos and films made through the API, and the files sent to make them, are deleted 7 days
          after they finish (1 day after a failure).
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you can ask to see, correct, download or delete your personal
        data, or object to how we use it. You can change your email and password on the Account page
        and delete videos from your dashboard. For anything else, including closing your account and
        deleting everything, email {LEGAL.email} from your account address. We'll reply within 30
        days. You can also complain to your local data protection authority.
      </p>

      <h2>Real people in your videos</h2>
      <p>
        If you upload a photo or voice of a real person, you confirm that you have their permission.
        If you believe Backlot holds your likeness without consent, email {LEGAL.email} and we'll
        investigate and remove it.
      </p>

      <h2>Cookies</h2>
      <p>
        We only use the storage your browser needs to keep you signed in. We don't use advertising
        or tracking cookies.
      </p>

      <h2>Children</h2>
      <p>Backlot isn't for anyone under 18, and we don't knowingly collect their data.</p>

      <h2>Changes</h2>
      <p>
        If we change this policy in a way that matters, we'll email you before it takes effect. See
        also our{" "}
        <Link to="/terms" className="underline underline-offset-2">
          Terms of Service
        </Link>
        . {LEGAL.company}, {LEGAL.address}.
      </p>
    </LegalPage>
  );
}
