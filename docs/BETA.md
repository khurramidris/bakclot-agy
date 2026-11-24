# Launching the private beta

This is the plain-language checklist for getting Backlot live for your first testers. The code is done. What's
left is creating accounts, pasting keys into one place (Railway), and checking it works.

**Time:** about one afternoon, plus waiting for sign-ups to be approved.
**How you'll know it's ready:** the **Setup check** page on your site shows everything green (step 8).

## The plan for the beta
- **No real money yet.** Lemon Squeezy stays in **test mode**. Testers "pay" with Lemon Squeezy's test card
  (`4242 4242 4242 4242`, any future date, any 3 digits). They get the full product, and nobody is charged.
  Live payments come later, once you've watched real costs for a couple of weeks.
- **Video comes from MiniMax's hosted H3** (`VIDEO_PROVIDER=minimax`). Our own H3 on RunPod is wired in but not yet
  tried on a real GPU: test it yourself first with `docs/SELF-HOSTED-H3.md`, then switch with `VIDEO_PROVIDER=runpod`.
- **Use Railway's free web address** (like `backlot-production.up.railway.app`) to begin with. A custom domain can
  come later (step 10).

## What's blocking launch
| # | What | Who | Time |
|---|---|---|---|
| 1 | Anthropic account and key (writes the scripts) | you | 10 min |
| 2 | MiniMax account and key (images, voices, video) | you | 15 min |
| 3 | Supabase project (sign-in, database), free plan | you | 20 min |
| 3b | Cloudflare R2 (video storage), free up to 10 GB | you | 10 min |
| 4 | An email sender for sign-in emails (Resend) | you | 15 min |
| 5 | Lemon Squeezy store in test mode (subscriptions) | you | 30 min |
| 6 | Railway (runs the site) | you | 20 min |
| 7 | Make yourself admin | you | 5 min |
| 7b | Optional: your ops dashboard, a second Railway service | you | 10 min |
| 8 | Setup check page all green | you, then me for anything odd | 10 min |
| 9 | Your own test film and clip, and look at the costs | you | 30 min |
| 10 | Company details on the Terms and Privacy pages (4 settings) | you | 5 min |
| 10c | An uptime monitor that tells you if the site goes down | you | 10 min |
| 11 | Invite testers | you | — |
| 11b | Open the developer API (`API_ENABLED=1`) once the costs check out | you | 10 min |
| 12 | Last: video on your own GPU (`docs/SELF-HOSTED-H3.md`), then `VIDEO_PROVIDER=runpod` | you, then me | 1–2 h |

Keep a private note open as you go (not in the repo, never in chat logs you share). Each step gives you a
value to paste into Railway in step 6. The name in `CAPITALS` is the setting's name.

---

## 1. Anthropic (the AI that writes scripts and plans shots)
1. Go to **console.anthropic.com** and sign up.
2. **Billing**: add a card and buy some credit. $20 is plenty to set up and test (a film's writing costs $1–3).
3. **API keys → Create key**. Name it "backlot". Copy it.
   - Save as `ANTHROPIC_API_KEY`.
4. **Settings → Limits**: note your monthly spend cap ($500 on the Start tier). When it's reached, Claude stops answering
   until the 1st of the next month, so new films fail. Writing one film costs about $1–2; request a tier increase there
   well before you get close.

## 2. MiniMax (cast and set images, voices, and the video itself)
1. Go to **minimax.io**, open the **API platform**, and sign up.
2. Add balance (top up). $20 is enough: MiniMax makes the cast and set pictures and the voices, and the video only
   for your few test films, until your own GPU on RunPod takes over at the very end.
3. Create an **API key** and copy it.
   - Save as `MINIMAX_API_KEY`.
   - If your account is on the China site (minimaxi.com), also save `MINIMAX_BASE_URL=https://api.minimaxi.com`.
4. Also save `VIDEO_PROVIDER=minimax`.
5. Backlot sends MiniMax up to 10 videos at once. If MiniMax limits your account to fewer videos in progress at once
   (check the rate limits for your account), save that number as `VIDEO_MAX_INFLIGHT`.

## 3. Supabase (sign-in and the database)
1. Go to **supabase.com** → **New project**.
   - Pick the region closest to your customers.
   - Save the database password somewhere safe.
   - The **Free plan** is enough: Supabase only signs people in and holds the database. Videos go to Cloudflare R2
     (step 3b), which is free up to 10 GB. A free project pauses after a week with nobody using it; **Restore**
     it from the dashboard. Upgrade to Pro ($25/month) once you have customers.
2. **Project Settings → API**: copy the **Project URL** and the **anon / publishable key**.
   - Save as `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. **Connect** (top bar) → **Session pooler**: copy the connection string, and put your database password into
   it where it says `[YOUR-PASSWORD]`.
   - Save as `DATABASE_URL`.
4. **Authentication → Sign In / Providers**: Email is on. Make sure **Confirm email** is on too.
   - Google sign-in is optional. You can skip it for the beta: the "Continue with Google" button only appears on the
     sign-in page once Google is switched on here.
   - If you want it, you'll need a Google Cloud OAuth client; `docs/DEPLOY.md` step 1 covers it.
5. **Authentication → URL Configuration** (fill in after step 6, once you have the Railway address):
   - **Site URL:** `https://<your-railway-address>`
   - **Redirect URLs**, add all three:
     - `https://<your-railway-address>/dashboard`
     - `https://<your-railway-address>/reset-password`
     - `https://<your-railway-address>/account`

## 3b. Cloudflare R2 (where the videos are kept)
Free up to 10 GB, then about $0.015 per GB a month. Unlike most storage, it never charges when customers watch or
download their videos.
1. Go to **dash.cloudflare.com** and sign up. Open **R2 Object Storage** and enable it (it asks for a card, but the
   free tier costs nothing).
2. **Create bucket**: name it `backlot`, location **Automatic**. Leave public access **off**.
3. Note your **Account ID** (on the R2 overview page).
   - Save `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET=backlot` and
     `STORAGE_DRIVER=s3`.
4. **Manage R2 API tokens → Create API token**: permission **Object Read & Write**, limited to the `backlot`
   bucket. Copy the **Access Key ID** and **Secret Access Key** (the secret is shown once).
   - Save as `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

(Prefer Supabase Storage instead? On Supabase Pro: **Storage → New bucket** `backlot` (private), then
**Project Settings → Storage → S3 connection** for the endpoint, region and a new access key.)

## 4. Email sender (so sign-up and password emails actually arrive)
Supabase's built-in email only sends a few messages an hour, so testers would get stuck.
1. Go to **resend.com** and sign up. The free plan is fine.
2. **Domains**: add a domain you own and follow the DNS instructions.
   - No domain yet? Resend's test sender only mails your own address, so buy a domain first (step 10) or ask me
     for another option.
3. **API Keys → Create**. Copy it.
4. In **Supabase → Authentication → Emails → SMTP Settings**, turn on custom SMTP and enter:
   - Host `smtp.resend.com`, port `465`, username `resend`, password: the Resend key.
   - Sender: something like `hello@yourdomain.com`, name "Backlot".

## 5. Lemon Squeezy (subscriptions, in test mode)
1. Go to **lemonsqueezy.com**, sign up, and create a store. Keep the **Test mode** switch (bottom left) **on**.
2. **Settings → Stores**: note the store's number (e.g. `12345`).
   - Save as `LEMONSQUEEZY_STORE_ID`.
3. **Products → + New product**: name "Backlot Basic", pricing **Subscription**, **$20** every **1 month**.
   Publish it.
4. Three more products, pricing **Single payment**: "Starter credits" $10, "Creator credits" $50, "Studio credits"
   $200. Publish them.
   - Each product has a "variant id" the site needs. Don't dig for them in the dashboard: the Setup check page
     (step 8) lists your products with their ids. You'll copy them from there into
     `LEMONSQUEEZY_BASIC_VARIANT_ID` and `CREDIT_PACKS=starter:10:<id>,creator:50:<id>,studio:200:<id>`.
5. **Settings → API → +**: create a key and copy it.
   - Save as `LEMONSQUEEZY_API_KEY`.
6. **Settings → Webhooks → +**:
   - **URL:** `https://<your-railway-address>/webhooks/lemonsqueezy` (fill in after step 6).
   - **Signing secret:** make up a long random string (at least 32 letters and numbers) and save it.
     - Save as `LEMONSQUEEZY_WEBHOOK_SECRET`.
   - **Events:** tick `order_created` and every `subscription_…` event (created, updated, cancelled, resumed,
     expired, paused, unpaused, payment_success).
7. **Settings → Customer portal**: turn it on, and allow cancelling and updating the payment method.

## 6. Railway (runs the website)
1. Go to **railway.com** and sign up with your GitHub account.
2. **New Project → Deploy from GitHub repo → khurramidris/backlot**. It starts building. The first build fails
   or crashes: that's expected, because the settings aren't there yet.
3. Open the service → **Settings → Networking → Generate Domain**. This is your address
   (e.g. `backlot-production.up.railway.app`).
   - Now go back and finish Supabase step 3.5 and the Lemon Squeezy webhook URL (5.6).
4. Open **Variables → Raw Editor** and paste everything you saved, plus these:
   ```
   NODE_ENV=production
   PUBLIC_BASE_URL=https://<your-railway-address>
   APP_URL=https://<your-railway-address>
   CORS_ORIGINS=https://<your-railway-address>
   FILE_SIGNING_SECRET=<another long random string, at least 32 characters>
   ```
   Don't add `MOCK_PROVIDERS` or `ALLOW_DEV_TOKENS`: they're for development only, and the site refuses to start
   with them.
5. Railway redeploys by itself. When it's done, open `https://<your-railway-address>/health`. It should say
   `{"ok":true,"mock":false}`.
6. Open the service → **Settings → Deploy**: check that **Healthcheck Path** says `/health`, and set **Restart Policy**
   to **Always**. (It needs Railway's Hobby plan, $5 a month; on the free trial leave it on "On Failure".) If the site
   ever gets stuck, it restarts itself, and this makes sure Railway always starts it again.

## 7. Make yourself admin
1. Open your site, **Get started**, and sign up with your own email. Confirm it from the email.
2. Go to **Account**. At the bottom, click **Your user id** to copy it.
3. In Railway → Variables, add `ADMIN_USER_IDS=<your user id>`. It redeploys.

## 7b. Your ops dashboard (optional, 10 minutes)
Everything happening on Backlot on one site of its own: whether it's all up, what needs you, money, customers,
what's being made, the servers and every provider's spend. It keeps working if the main site has trouble.
1. In your Railway project: **New → GitHub Repo → khurramidris/backlot**. A second service starts building.
2. Open it → **Settings → Deploy → Custom Start Command** → `node dist/ops.js`.
3. **Variables → Raw Editor**: paste exactly what the main service has (copy it from the main service's Raw Editor).
4. **Settings → Networking → Generate Domain**. Open that address and sign in with your Backlot email and password.
   Only accounts in `ADMIN_USER_IDS` get in.
5. Optional: add `PROVIDER_BUDGETS_MONTHLY=anthropic:100,minimax:100` (your monthly limits) to both services, and
   the Providers page shows what's left and how many days it lasts.

## 8. Setup check
1. Refresh the site. A **Setup check** item appears in the sidebar (admins only). Open it.
2. It tests every key and setting for real. Fix anything **red**; each line says how. Amber lines are notes.
   - Under Payments, **Your products** lists each Lemon Squeezy product with its variant id. Copy them into
     `LEMONSQUEEZY_BASIC_VARIANT_ID` and `CREDIT_PACKS` in Railway (see step 5.4), then wait for the redeploy.
3. Press **Check again** until nothing is red. If a red line doesn't make sense, paste it to me.

## 9. Your own test film
1. Go to **Billing → Subscribe** and pay with the test card `4242 4242 4242 4242`. Billing should show the plan
   as active with $20 of credit within a few seconds.
2. On **Home**, type a one-sentence story and press **Create**. After a few minutes it stops at "Ready for your
   approval" with the script, cast and price.
3. Press **Make my video** and wait for "Finished". Play it and download it.
4. Try **Fix this shot** on one shot, **Buy** a top-up pack (test card again), and **Forgot password**.
5. On **Home**, switch to **Quick clip**, type one sentence and make a 5-second clip. Then one from a picture.
6. **Look at the costs:** open **Admin**. "Where the money goes" shows what that film cost you in writing,
   pictures, voices and video, next to what you charged. Check the Anthropic console and the MiniMax balance
   too, since the dashboard's figures are estimates from list prices. Tell me the numbers and I'll check the
   pricing still makes money.

## 10. Company details and a domain
1. In Railway → Variables, add your company's details. The Terms, the Privacy Policy and the support links show them
   (no code change: the site picks them up when it restarts):
   ```
   LEGAL_COMPANY=<your company's legal name>
   LEGAL_JURISDICTION=<the country or state it's registered in>
   LEGAL_ADDRESS=<its registered address>
   SUPPORT_EMAIL=<a support email you read>
   ```
   Until they're set, the pages show placeholders and the Setup check shows them in red.
   A lawyer's review can wait for a small invite-only beta. Do it before you take real money.
2. **Domain (optional for beta):** buy one (e.g. at Cloudflare or Namecheap). In Railway → Settings →
   Networking → Custom Domain, add it and follow the DNS instructions. Then:
   - Change `PUBLIC_BASE_URL`, `APP_URL` and `CORS_ORIGINS` to the new address.
   - Update the Supabase Site URL and Redirect URLs (3.5) and the Lemon Squeezy webhook URL (5.6).
   - Run the Setup check again.

## 10b. Error alerts (optional, 10 minutes, recommended)
So you hear about problems before testers tell you:
1. Go to **sentry.io** and sign up. The free plan is enough.
2. Create a project and choose **Node.js**. Copy the **DSN** (a long address that starts with `https://`).
3. In Railway → Variables, add `SENTRY_DSN=<the DSN>`.
From then on, Sentry emails you when something breaks, such as a render that fails for good or a server error.

## 10c. Uptime monitor (10 minutes, recommended)
Railway doesn't tell you when the site stops answering. A free monitor does:
1. Go to **uptimerobot.com** (or betterstack.com) and sign up. The free plan is enough.
2. **New monitor**: type **HTTP(s)**, URL `https://<your-address>/health`, every 5 minutes.
3. Alerts: your email, and the phone app if you want a push.
It warns you if the site is down or the database stops answering (the health page then says so).

## 11. Invite testers
Send each tester:
- the link to your site
- "Sign up, then on Billing pay with the test card 4242 4242 4242 4242 (any future date, any CVC). Nothing is
  charged during the beta."
- where to send feedback (an email address or a WhatsApp group)

Start with 10–20 people. The **Admin** page (sidebar, admins only) is the company dashboard, for the last 7 days,
30 days, 90 days or 12 months:
- money in, costs out (AI, GPU, your monthly bills, payment fees), profit and monthly recurring revenue
- where the money goes, line by line, and what a second of video costs you against what you charge
- what customers made, what failed or was refused, and whether anything is stuck right now
- customers: new, paying, cancelling, payment problems, and the top spenders

Click a customer to see their films, what each cost you against what they paid, and their credit history. You
can also **give or take back credit** there with a note, for example if a film came out badly.

With the ops dashboard (step 7b), open its **Overview** each day: the "Needs you" list at the top says what to look
at first. Also keep an eye on the MiniMax balance, and send me anything that looks wrong.

## 11b. Open the developer API (when the costs check out)
The API lets other companies make clips and microdramas from their own code, paying from prepaid credit (no plan
needed). It's built and tested, and stays off until you switch it on.
1. Make sure step 9's costs make sense: a second of video costs you less than you charge, and writing a film costs
   less than the setup fee.
2. In Railway → Variables, add `API_ENABLED=1`. It redeploys.
3. Open **Developers** in the sidebar, create a key with a $5 monthly limit, and follow the quick start on
   `https://<your-address>/docs/api` with it. The clip should arrive and your balance drop by its price.
4. Revoke that key. Point developers at `/docs/api`; the Admin page shows their use under API, and a developer whose
   requests are refused by the content check too often is suspended automatically (you can lift it on their
   customer page).

## Going live with real payments (later)
1. **Lemon Squeezy:** activate the store (they verify your identity and what you sell, which can take a few days: apply
   early, and describe Backlot plainly as AI video generation for creators and businesses). Then switch Test mode
   **off**. If they ask you to move to Stripe Managed Payments instead, tell me before you do: billing needs changing.
2. Live mode has its own API key, products and webhook. Repeat step 5 in live mode and replace the five
   `LEMONSQUEEZY_*` / `CREDIT_PACKS` values in Railway.
3. Get the lawyer's review of Terms and Privacy done first.
4. Run the Setup check: the webhook line turns from amber ("test mode") to green ("live mode").

## Monthly running costs during the beta (rough)
- **Railway:** $5 (Hobby plan, includes $5 of use), more as traffic grows; the ops dashboard adds a few dollars
- **Supabase:** free (Pro, $25, once you have customers)
- **Cloudflare R2:** free up to 10 GB of videos
- **Resend:** free. A domain for the sender address is about $10 a year.
- **Lemon Squeezy:** no monthly fee (a cut of each real sale later)
- **Anthropic and MiniMax:** pay per use. You'll see the real per-film cost in step 9.
- **RunPod (the last step):** about $5 a month for the model's storage, plus GPU seconds while rendering.
