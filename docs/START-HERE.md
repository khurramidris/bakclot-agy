# Start here: put Backlot online and test it with a few people

Written for someone who has never set up a website. Follow it in order. Don't skip a step, and don't worry if a
screen looks slightly different from what's described: look for the words in **bold**.

There are two parts:

- **Part A** puts Backlot on the internet so your testers can use it in their browser. (About one afternoon.)
- **Part B** installs the desktop app on your own computer. (About 15 minutes.)

You can do Part B first. It's quicker, needs no website, and shows you what Backlot does.

---

## Before you start

You need:
- a computer with a web browser and a credit/debit card
- an email address you check
- a GitHub login (you already have one: Backlot lives there)

**Keep a private notes file open** (Notepad, Notes, anything). Many steps give you a long code to copy, such as
`ANTHROPIC_API_KEY`. Paste each one into your notes file next to its name in CAPITAL LETTERS. At the end you'll paste
them all in one place. **Never send these codes to anyone or post them anywhere public.** They are like passwords
that spend your money.

---

# Part A: Put Backlot online

## What it will cost (roughly)

| What | Cost |
|---|---|
| Railway (runs the website) | $5 to $20 a month |
| Supabase (sign-in, database, file storage) | $25 a month |
| Anthropic (writes the stories) | pay as you go: put in $50 to start |
| MiniMax (images, voices, video) | pay as you go: put in $50 to $100 to start |
| Resend (sends sign-in emails) | free |
| Lemon Squeezy (test payments) | free |
| A website name like `mybacklot.com` (optional) | about $10 to $15 a year |

Nobody is charged real money during the test. Testers "pay" with a fake card.

## Step 1. Anthropic (the AI that writes the story)

1. Open **console.anthropic.com** and sign up.
2. Click **Billing**, add your card, and buy **$50** of credit.
3. Click **API keys**, then **Create key**. Name it `backlot`. Click create.
4. **Copy the key** (it starts with `sk-ant-`). You can only see it once.
5. In your notes: `ANTHROPIC_API_KEY = ` and paste it.

## Step 2. MiniMax (images, voices and video)

1. Open **minimax.io**. Find **API platform** (or "Developer platform") and sign up.
2. Click **Billing** or **Top up** and add **$50 to $100**.
3. Find **API keys** and click **Create**. **Copy the key.**
4. In your notes, add these two lines:
   - `MINIMAX_API_KEY = ` (paste the key)
   - `VIDEO_PROVIDER = minimax`
5. If your account was made on the Chinese site (the address contains `minimaxi.com`), also add:
   `MINIMAX_BASE_URL = https://api.minimaxi.com`

## Step 3. Supabase (sign-in, database and file storage)

1. Open **supabase.com** and sign up. Click **New project**.
2. Name it `backlot`. Create a **database password** and **save it in your notes** (`Supabase password`).
3. Pick the **region closest to your testers**. Choose the **Pro plan** ($25 a month). The free plan runs out of
   space after a few videos. Click **Create new project** and wait about two minutes.
4. Click **Project Settings** (the cog at the bottom left), then **API**.
   - Copy **Project URL**. In your notes: `SUPABASE_URL = ` and paste it.
   - Copy the **anon** (also called **publishable**) key. In your notes: `SUPABASE_ANON_KEY = ` and paste it.
5. Click **Connect** at the top of the page, then find **Session pooler**. Copy the long address.
   - It has `[YOUR-PASSWORD]` inside it. Replace that part (brackets too) with your database password from step 2.
   - In your notes: `DATABASE_URL = ` and paste it.
6. Click **Storage** in the left menu, then **New bucket**.
   - Name: `backlot`. Leave **Public bucket** **off**. Click **Save**.
7. Go to **Project Settings**, then **Storage**, then **S3 Connection**.
   - Copy the **Endpoint** and the **Region**.
   - Click **New access key**. Copy both the **Access key ID** and the **Secret access key**.
   - In your notes add these lines:
     ```
     S3_ENDPOINT = (the endpoint)
     S3_REGION = (the region)
     S3_ACCESS_KEY_ID = (the access key id)
     S3_SECRET_ACCESS_KEY = (the secret access key)
     S3_BUCKET = backlot
     STORAGE_DRIVER = s3
     ```
8. Click **Authentication** in the left menu, then **Sign In / Providers**. Check that **Email** is switched on and
   **Confirm email** is switched on. Skip Google sign-in for now.

You'll come back to Supabase once more in step 7.

## Step 4. Resend (so sign-up emails actually arrive)

Supabase can only send a handful of emails an hour on its own, so your testers would get stuck waiting for their
confirmation email. Resend fixes that.

1. Open **resend.com** and sign up (free).
2. You need a website name you own to send email from. If you don't have one, buy one now (for example at
   **cloudflare.com** or **namecheap.com**, about $10 a year). In Resend click **Domains**, then **Add domain**, and
   follow the on-screen steps. They ask you to paste a few lines into the place where you bought the name. Wait for
   Resend to say **Verified**.
3. In Resend click **API Keys**, then **Create API key**. **Copy it.**
4. Go back to **Supabase**. Click **Authentication**, then **Emails**, then **SMTP Settings**. Switch on **Enable custom SMTP**
   and fill in:
   - Sender email: `hello@` followed by your website name (for example `hello@mybacklot.com`)
   - Sender name: `Backlot`
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: the Resend key you just copied
5. Click **Save**.

## Step 5. Lemon Squeezy (payments, in test mode)

This is what lets testers "subscribe". In test mode no real money moves.

1. Open **lemonsqueezy.com**, sign up and **create a store**.
2. Look at the bottom left of the page for the **Test mode** switch. **Turn it on** and leave it on.
3. Click **Settings**, then **Stores**. Note the store's **number** (like `12345`).
   - In your notes: `LEMONSQUEEZY_STORE_ID = ` and the number.
4. Click **Products**, then **New product**.
   - Name: `Backlot Basic`. Pricing: **Subscription**. Price: **$20**, every **1 month**. Click **Publish**.
5. Make three more products the same way, but choose **Single payment**:
   - `Starter credits`, **$10**
   - `Creator credits`, **$50**
   - `Studio credits`, **$200**
   Publish each one.
6. Click **Settings**, then **API**, then the **+** button. Create a key named `backlot`. **Copy it.**
   - In your notes: `LEMONSQUEEZY_API_KEY = ` and paste it.
7. Click **Settings**, then **Webhooks**, then **+**. **Leave this screen open or come back to it in step 7** (you
   need your website address first).
8. Click **Settings**, then **Customer portal**. Switch it **on**, and allow customers to cancel and to update their card.

You'll finish the webhook in step 7, and fill in the product numbers in step 9.

## Step 6. Railway (the computer that runs the website)

1. Open **railway.com** and click **Login with GitHub**.
2. Click **New Project**, then **Deploy from GitHub repo**.
3. If it doesn't list `khurramidris/backlot`, click **Configure GitHub App**, allow Railway to see that
   repository, and come back.
4. Click **khurramidris/backlot**. Railway starts building. **It is normal for it to fail or crash the first time**:
   the settings aren't in yet.
5. Click the new service box, then **Settings**, then **Networking**, then **Generate Domain**.
   You get an address like `backlot-production.up.railway.app`.
   - In your notes: `Website address = https://` followed by it.
6. Click **Variables**, then **Raw Editor**. Paste in **every line from your notes file** that is in the form
   `NAME = value`. Write them without spaces around the `=` sign, like this:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   MINIMAX_API_KEY=...
   VIDEO_PROVIDER=minimax
   SUPABASE_URL=...
   (and the rest of your lines)
   ```
   Then add these five lines at the bottom. Replace `ADDRESS` with your website address from the previous step and
   make up a long random text (at least 40 letters and numbers) for the last one:
   ```
   NODE_ENV=production
   PUBLIC_BASE_URL=https://ADDRESS
   APP_URL=https://ADDRESS
   CORS_ORIGINS=https://ADDRESS
   FILE_SIGNING_SECRET=anyLongRandomTextOf40LettersAndNumbers
   ```
   **Do not** add anything called `MOCK_PROVIDERS` or `ALLOW_DEV_TOKENS`. The website will refuse to start if they
   are there.
7. Click **Update Variables**. Railway restarts the site by itself (wait about 3 minutes).
8. In your browser open `https://ADDRESS/health`. You should see `{"ok":true,"mock":false}`. If you do, the site is
   running. If you don't, wait one more minute and refresh; if it still fails, send me what the **Deployments**
   tab says.

## Step 7. Tell Supabase and Lemon Squeezy your website address

Now that the site has an address, finish the two things you left open.

**In Supabase:** click **Authentication**, then **URL Configuration**.
1. **Site URL:** `https://ADDRESS`
2. **Redirect URLs:** click **Add URL** three times and add:
   - `https://ADDRESS/dashboard`
   - `https://ADDRESS/reset-password`
   - `https://ADDRESS/account`
3. Click **Save**.

**In Lemon Squeezy** (make sure **Test mode** is still on): click **Settings**, **Webhooks**, **+**.
1. **URL:** `https://ADDRESS/webhooks/lemonsqueezy`
2. **Signing secret:** make up another long random text (at least 32 letters and numbers). **Paste it in your notes** as
   `LEMONSQUEEZY_WEBHOOK_SECRET = ` and also here.
3. **Events:** tick `order_created` and **every** event that starts with `subscription_`.
4. Click **Save**.
5. Back in **Railway** → **Variables**, add the line `LEMONSQUEEZY_WEBHOOK_SECRET=...` and add `LEMONSQUEEZY_STORE_ID=...`
   and `LEMONSQUEEZY_API_KEY=...` if you haven't already.

## Step 8. Make yourself the administrator

1. Open your website (`https://ADDRESS`). Click **Get started** and sign up with **your own** email.
2. Open the confirmation email and click the link.
3. Click **Account** in the left menu. At the bottom, click **Your user id** to copy it.
4. In **Railway** → **Variables**, add the line `ADMIN_USER_IDS=` followed by what you copied. Railway restarts.

## Step 9. The Setup check (the site checks itself for you)

1. Refresh your website. A new item called **Setup check** appears in the left menu. Click it.
2. It tests every key and setting for real. Each line is **green** (good), **amber** (just a note) or **red** (fix it).
   Each red line says in plain words what to do.
3. Under **Payments**, find **Your products**. It lists your four Lemon Squeezy products and a number beside each
   one. In **Railway** → **Variables**, add:
   ```
   LEMONSQUEEZY_BASIC_VARIANT_ID=(the number next to Backlot Basic)
   CREDIT_PACKS=starter:10:NUMBER1,creator:50:NUMBER2,studio:200:NUMBER3
   ```
   (NUMBER1 is the number next to Starter credits, NUMBER2 next to Creator credits, NUMBER3 next to Studio credits.)
4. Wait for Railway to restart, then click **Check again**. Repeat until nothing is red.

## Step 10. Make your own test film first

Do this before inviting anyone.

1. Click **Billing**, then **Subscribe**. On the payment page use the **fake card**:
   `4242 4242 4242 4242`, any future date, any 3 numbers. Within a few seconds Billing shows your plan as active.
2. Click **Home**. Type a one-sentence story, for example *"A night nurse finds a letter that proves her husband is alive."*
   Press **Create**.
3. After a few minutes it stops at **Ready for your approval** and shows the script, cast and the price.
4. Press **Make my video**. Wait for **Finished**. Play it and download it.
5. **Look at what it cost you.** Check your Anthropic and MiniMax balances before and after one film. Send me the
   two numbers and I'll check the prices still make money.

## Step 11. Legal pages

In **Railway** → **Variables**, add four lines with your company's details. The Terms and Privacy pages and the
support links show them (Railway restarts; nothing else to do):
```
LEGAL_COMPANY=Your Company Ltd
LEGAL_JURISDICTION=England and Wales
LEGAL_ADDRESS=1 Example Street, London
SUPPORT_EMAIL=support@yourdomain.com
```
Until they're in, the pages show placeholders and the Setup check shows them in red. A lawyer should read the pages
before you take **real** money; that can wait for a small test.

Also: in **Railway**, open the service, then **Settings**, then **Deploy**, and set **Restart Policy** to **Always**
(on the $5 Hobby plan; on the free trial leave it). And sign up at **uptimerobot.com** (free) with a monitor on
`https://ADDRESS/health`, so you get an email if the site ever stops answering.

## Step 12. Invite your testers

1. Pick **5 to 10 people** you trust.
2. Send each one this message:
   > Please try Backlot: `https://ADDRESS`
   > 1. Click **Get started** and sign up. Confirm your email.
   > 2. Click **Billing**, then **Subscribe**. Pay with the test card **4242 4242 4242 4242**, any future date, any
   >    3 numbers. Nothing is really charged.
   > 3. Make a film from one sentence and tell me what you think.
   > Send feedback to: (your email or WhatsApp group)
3. Watch the **Admin** page (left menu). It shows who signed up, films finished and failed, what each film cost you,
   and lets you **give or take back credit** for a customer.
4. Keep an eye on your MiniMax and Anthropic balances while testers are using it.

**Anyone who finds your link can sign up**, so share it only with people you trust and watch the Admin page.

## Optional: alerts when something breaks

1. Open **sentry.io** and sign up (free). Create a project and choose **Node.js**.
2. Copy the **DSN** (a long address starting with `https://`).
3. In **Railway** → **Variables**, add `SENTRY_DSN=` and the DSN. Sentry now emails you when something fails.

## Optional: your own website name

In **Railway** → **Settings** → **Networking** → **Custom Domain**, add your name and follow the on-screen
instructions. Then change `PUBLIC_BASE_URL`, `APP_URL` and `CORS_ORIGINS` in Railway to the new address, update the
three addresses in Supabase (step 7) and the Lemon Squeezy webhook address, and run the Setup check again.

## If something goes wrong

- **The site shows an error or `/health` doesn't answer:** Railway → **Deployments** → open the latest one → **View logs**.
  Send me the last 20 lines.
- **A red line in Setup check I don't understand:** copy it and send it to me.
- **Confirmation emails don't arrive:** check the spam folder, then check Resend shows the domain as **Verified**
  and the SMTP settings in step 4.
- **A film failed:** Admin → **Recent failures** shows the reason. The customer is refunded automatically.

---

# Part B: Install the desktop app on your computer

The desktop app is Backlot in a normal window on your own computer. You use your own keys, and it needs **no website**
and no setup of databases. It can also run in **demo mode** with no keys at all.

## Step 1. Download it

1. Open **github.com/khurramidris/backlot** and sign in.
2. Click **Actions** (the tab near the top).
3. Click the newest run called **Desktop** that has a green tick.
4. Scroll to the bottom to **Artifacts**. You'll see three downloads:
   - `backlot-desktop-windows-latest` for **Windows**
   - `backlot-desktop-macos-latest` for **Mac** (only Macs with an Apple chip: M1, M2, M3 or newer. Not older Intel Macs)
   - `backlot-desktop-ubuntu-latest` for **Linux**
5. Click the one for your computer. A zip file downloads.
6. Open the zip file (double-click it). The installer is inside.

Downloads stay on GitHub for 90 days. After that, ask me to build new ones.

## Step 2. Install it

**On Windows**
1. Double-click the file that ends in **.exe**.
2. Windows may say **"Windows protected your PC"**. This only appears because the app isn't signed with a paid
   certificate yet. Click **More info**, then **Run anyway**.
3. Follow the installer. Open **Backlot** from the Start menu.

**On a Mac**
1. Double-click the file that ends in **.dmg** (not the one ending in .zip). Drag **Backlot** into **Applications**.
2. Open **Applications** and double-click **Backlot**. The Mac will say it **can't check Backlot** and won't open it.
   That's expected: the app isn't signed with a paid Apple certificate yet. Click **Done** (or **OK**).
3. Open **System Settings** (the Apple menu, top left), then **Privacy & Security**. Scroll down to the line that
   says **"Backlot" was blocked** and click **Open Anyway**. Type your Mac password if asked, then click
   **Open Anyway** once more.
   - On an older Mac (macOS 14 or earlier) you can instead **right-click Backlot** in Applications, choose **Open**,
     then click **Open** again.
4. You only do this the first time. After that Backlot opens normally.
5. If the Mac says Backlot **"is damaged and can't be opened"**, you have an older download: get the newest one
   from Actions (Step 1) and install that instead.

**On Linux** (Ubuntu or similar)
1. Right-click the **.AppImage** file, choose **Properties**, then **Permissions**, tick **Allow executing as a program**.
2. Double-click it. If nothing happens, open **Terminal**, paste this line, press Enter, type your password, and
   then double-click the file again:
   `sudo apt install -y libfuse2t64 || sudo apt install -y libfuse2`

## Step 3. First start

1. A **Welcome to Backlot** window opens. Pick one:
   - **Try it now** to look around with no keys. Everything is placeholder pictures, but the whole studio works.
   - **Use my own accounts** for real films.
2. If you chose your own accounts, paste in:
   - your **Anthropic API key** (Part A step 1). Click **Test**: it says if the key works.
   - your **MiniMax API key** (Part A step 2)
   - for video: pick **MiniMax's hosted H3** (simplest, uses the same MiniMax key) or **My H3 on RunPod** (then paste
     your RunPod key and endpoint ID and click **Test**; setting up that endpoint is in `docs/SELF-HOSTED-H3.md`)
   - **Longest film** is set to 120 seconds to keep a first test small and cheap. Leave it.
3. Click **Save and start**. A window shows the steps while it starts (the first start takes a minute or two; with
   RunPod it also downloads a small helper once).
4. The Backlot studio opens. You're signed in automatically. Type a one-sentence story and press **Create**.

## Step 4. Everyday use

- **Change keys later:** Windows/Linux **File → Settings**; Mac **Backlot → Settings**.
- **Something not working?** **Tools → Setup check** tells you in plain words.
- **Your films live on your computer**, in the folder from **Tools → Open films folder**.
- **To update:** download the newest installer and install it over the old one. Your films and settings stay.

## If something goes wrong

- **"Backlot could not start":** click **Show logs** and send me the last lines. **Try again** often fixes it.
- **A film fails with a download or upload error (RunPod only):** **Tools → Restart studio**.
- **Nothing in Artifacts at the bottom of the Actions page:** tell me and I'll rebuild the installers.
