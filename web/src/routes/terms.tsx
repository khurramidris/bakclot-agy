import { createFileRoute, Link } from "@tanstack/react-router";

import { LegalPage } from "@/components/layout/LegalPage";
import { LEGAL } from "@/lib/legal";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of Service — Backlot" }] }),
  component: Terms,
});

// Plain-language draft. It must be reviewed by a lawyer before launch (see docs/DEPLOY.md).
function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        These terms are an agreement between you and {LEGAL.company} ("Backlot", "we"), registered
        in {LEGAL.jurisdiction}. By creating an account or using Backlot you agree to them. If you
        don't agree, please don't use the service.
      </p>

      <h2>1. What Backlot does</h2>
      <p>
        Backlot turns a written idea into a video. It uses AI models to write a script, design
        characters and sets, plan shots, render video with dialogue, and edit the result. AI output
        can be unpredictable: it may contain mistakes, and it may not match what you had in mind.
        You can fix individual shots, but we can't promise any particular result.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>You must be at least 18 years old, or the age of majority where you live.</li>
        <li>Keep your password safe. You're responsible for what happens under your account.</li>
        <li>One person per account. Tell us straight away if you think someone else got in.</li>
      </ul>

      <h2>3. The Basic plan, credits and payment</h2>
      <ul>
        <li>
          Creating videos in the studio requires the Basic subscription. The current price, included
          credits and storage are shown on the Billing page before you subscribe. The API (section
          11) needs credit but no subscription.
        </li>
        <li>
          Payments are handled by Lemon Squeezy, which acts as the reseller and Merchant of Record
          for all orders. Lemon Squeezy charges your card, adds any sales tax or VAT, and issues
          your invoices. Its own buyer terms also apply to the purchase.
        </li>
        <li>
          The subscription renews automatically each month until you cancel. Each renewal includes a
          fresh allowance of monthly credits. Monthly credits that you haven't used expire at the
          next renewal and don't roll over.
        </li>
        <li>
          Anyone with an account can buy top-up credit packs. Top-up credit doesn't expire while
          your account exists, and it's used only after your monthly credits run out.
        </li>
        <li>
          Credits pay for writing, casting and planning each video (a small setup fee) and for each
          second of rendered footage. You see the price of a render and approve it before anything
          is rendered.
        </li>
        <li>
          Credits have no cash value. They can't be transferred, and they aren't refundable except
          where these terms say so or the law requires it.
        </li>
      </ul>

      <h2>4. Failed renders are refunded automatically</h2>
      <p>
        If a shot fails to render or produces an unusable file, the credit held for it goes back to
        your balance automatically. If writing or casting fails before you approve a render, the
        setup fee comes back too. Refunded credit is added as top-up credit, so it doesn't expire.
      </p>

      <h2>5. Cancelling</h2>
      <p>
        You can cancel any time from Billing → Manage subscription. You keep access, and your
        monthly credits, until the end of the period you've already paid for. After that you can't
        create new videos, but you can still sign in, watch and download your films, and delete
        them. If you think you were charged by mistake, contact us at {LEGAL.email} and we'll work
        it out with Lemon Squeezy. This doesn't limit any statutory right you have to cancel or get
        a refund.
      </p>

      <h2>6. Acceptable use</h2>
      <p>You must not use Backlot to create, upload or share content that:</p>
      <ul>
        <li>
          shows a real, identifiable person without their permission, including uploading someone's
          face or voice as a reference;
        </li>
        <li>
          sexualises minors in any way, or is sexual content involving anyone who hasn't consented;
        </li>
        <li>
          impersonates a real person or organisation, or is meant to deceive people into thinking
          something real happened (such as fake news footage, fraud or scams);
        </li>
        <li>harasses, threatens or promotes violence or hatred against people or groups;</li>
        <li>infringes someone else's copyright, trademark or other rights;</li>
        <li>is illegal where you live or where it will be shown.</li>
      </ul>
      <p>
        You also must not try to get around our safety filters, overload or attack the service,
        scrape it, or resell access without our written agreement. Our model providers run their own
        safety filters, and some content will be refused. We may remove content, and suspend or
        close accounts, that break these rules. Where the law requires, we report illegal content to
        the authorities.
      </p>

      <h2>7. Who owns what</h2>
      <ul>
        <li>
          You own the ideas and prompts you give us, and, as between you and us, the videos Backlot
          makes for you. You can use them commercially.
        </li>
        <li>
          Copyright law in some countries may not protect purely AI-generated material, and a
          similar output could be generated for someone else. We can't guarantee you exclusive
          rights.
        </li>
        <li>
          You give us permission to store, process and display your content only as needed to run
          the service for you. We don't use your videos to advertise Backlot without asking you.
        </li>
        <li>The Backlot software, brand and website belong to us.</li>
      </ul>

      <h2>8. Storage and deletion</h2>
      <p>
        Your plan includes a storage allowance for scripts, reference images, clips and finished
        films. When you reach it you'll need to delete old videos before you can make new ones.
        Deleting a video removes its files from our storage for good. Please download anything you
        want to keep. If your subscription ends, we keep your files for at least 90 days. After that
        we may delete them, after emailing you a warning first. We're not a backup service. Keep
        your own copies of anything important.
      </p>

      <h2>9. Availability and changes</h2>
      <p>
        We work hard to keep Backlot running, but it may sometimes be unavailable or change. We may
        change prices or these terms. We'll give you at least 30 days' notice by email of anything
        that affects your subscription, and the change applies from your next renewal. If you don't
        agree, you can cancel before it takes effect.
      </p>

      <h2>10. Liability</h2>
      <p>
        Backlot is provided "as is". To the extent the law allows, we aren't liable for indirect or
        consequential losses. Our total liability to you for any claim is limited to the amount you
        paid us in the 12 months before it. Nothing here limits liability that can't be limited by
        law, such as for fraud or for death or personal injury caused by negligence.
      </p>

      <h2>11. The API</h2>
      <p>
        If you use the Backlot API (Backlot's programming interface for developers), these terms
        apply to it too, and so does the following:
      </p>
      <ul>
        <li>
          You're responsible for everything made with your API keys, including requests your own
          users send through your product. You must have the rights to every file you send,
          including the permission of anyone shown or heard in it, and pass on these rules to your
          users.
        </li>
        <li>
          Keep your keys secret and on your server. Revoke a key at once if it may have leaked.
        </li>
        <li>
          Videos and films made through the API are deleted 7 days after they finish (1 day after a
          failure). Download what you want to keep. They don't count toward your plan's storage.
        </li>
        <li>
          We log API requests (time, address, status and timing) for 30 days, for security, support
          and billing.
        </li>
        <li>
          The same content rules apply as in section 6. Repeated refused requests suspend API access
          until we review it. We may also suspend keys that put the service at risk.
        </li>
        <li>
          During the beta there is no uptime commitment. Prices are listed on the API pricing page;
          changes take effect for new requests.
        </li>
      </ul>

      <h2>12. Law and contact</h2>
      <p>
        These terms are governed by the laws of {LEGAL.jurisdiction}. If you're a consumer, you also
        keep any protections given to you by the law where you live. Questions: {LEGAL.email},{" "}
        {LEGAL.company}, {LEGAL.address}. See also our{" "}
        <Link to="/privacy" className="underline underline-offset-2">
          Privacy Policy
        </Link>
        .
      </p>
    </LegalPage>
  );
}
