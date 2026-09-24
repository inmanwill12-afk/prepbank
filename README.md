# PrepBank

A crowdsourced practice-test site for your school: anyone signs up, adds a
class, pastes or uploads study material, and PrepBank turns it into
multiple-choice questions, short-answer questions, and flashcards that
everyone taking that class can practice with.

This is a **real, deployable website** -- not a one-off demo. It has actual
accounts, a shared database, and a placeholder "subscription" you can wire
up to real payments later. You'll need to create two free accounts and
paste a couple of keys in -- about 15 minutes, no cost to start.

## How it fits together

- **Supabase** (free tier) is your database *and* your login system. The
  browser talks to it directly using a public key -- there's no separate
  backend server for accounts or data.
- **Vercel** (free tier) hosts the site and one small serverless function,
  `/api/ai`, which is the only part of the code that talks to Claude to
  generate questions and grade short answers. It's separate from the rest
  of the site specifically so your Claude API key never reaches the browser.
- **Row Level Security (RLS)** rules in `supabase/schema.sql` are what
  actually enforce who can read and write what -- for example, "a locked
  test's questions are only readable by someone with an active
  subscription." This runs on Supabase's servers, so it can't be bypassed
  from the browser.

## 1. Create your Supabase project (free)

1. Go to supabase.com, sign up, and create a new project (pick any name/password/region).
2. Once it's ready, open the **SQL Editor**, paste in the entire contents
   of `supabase/schema.sql` from this folder, and click **Run**. This
   creates all the tables and security rules.
3. Go to **Project Settings -> API**. Copy the **Project URL** and the
   **anon public** key.
4. Open `config.js` in this folder and paste them in:

   ```js
   window.PREPBANK_CONFIG = {
     SUPABASE_URL: "https://your-project-ref.supabase.co",
     SUPABASE_ANON_KEY: "eyJ...",
   };
   ```

   Both of these are meant to be public -- they're safe to ship in the
   website's code. They only ever do what the RLS rules in `schema.sql`
   allow.

5. Optional but recommended for a real pilot: under **Authentication ->
   Providers -> Email**, you can turn off "Confirm email" while testing so
   sign-ups don't need to click a confirmation link (turn it back on before
   a wider launch, or configure a custom email sender).

## 2. Get a Claude API key

1. Go to console.anthropic.com and create an API key. This is billed
   pay-as-you-go and generating a typical practice test costs a small
   fraction of a cent -- keep an eye on usage in the console once real
   people are using it.
2. **Do not** put this key in `config.js` or anywhere in the frontend --
   it goes only into Vercel's environment variables in the next step.

## 3. Deploy to Vercel (free)

The easiest path is via GitHub:

1. Create a new GitHub repository and push this whole folder to it.
2. Go to vercel.com, sign up, click **Add New -> Project**, and import
   that repository. Leave the framework preset as "Other" -- no build
   step is needed.
3. Before deploying (or right after, then redeploy), go to **Settings ->
   Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = the key from step 2 (mark it as a secret)
   - `ANTHROPIC_MODEL` (optional) -- see the note below
4. Deploy. Vercel gives you a URL like `prepbank-yourname.vercel.app` --
   that's the site you share with your school.

No GitHub? Vercel's CLI also works: install it (`npm i -g vercel`), run
`vercel` inside this folder, and follow the prompts -- it'll ask about
environment variables too.

### Picking a model

`api/ai.js` defaults to `claude-3-5-haiku-latest`, a small and cheap model
that's plenty capable for turning a study guide into quiz questions.
Model names change over time -- check
[docs.claude.com](https://docs.claude.com) for current model IDs and
pricing, and override the default by setting `ANTHROPIC_MODEL` in Vercel
if you want a different one.

## 4. Try it

Open your Vercel URL, create an account, add a class, paste in a real
study guide, and generate a test. The first test added to each class is
always free for everyone; anything after that is gated behind
"PrepBank+," which right now just has a demo "Unlock" button.

## 5. Make yourself an admin

At the bottom of `supabase/schema.sql` there's a commented-out line:

```sql
update public.profiles set is_admin = true where email = 'you@example.com';
```

After you've signed up on the live site, uncomment it, swap in the email
you signed up with, and run it in the Supabase SQL Editor. Reload the
site and you'll see an **Admin** tab in the top bar. From there you can:

- toggle any test between free and PrepBank+
- delete a bad test or an entire class
- **import a test I (Claude) generate for you in chat**, instead of using
  the paste-and-generate flow on the site itself

### Sending me materials directly

Next time you want a test made, just paste your notes into our chat and
ask something like *"make this a PrepBank import for my AP World History
class."* I'll write back a block of JSON in exactly the shape the Admin
page's importer expects:

```json
{
  "className": "AP World History - Mr. Diaz",
  "subject": "AP World History",
  "title": "Unit 3 Practice Test",
  "isFree": false,
  "mc": [{"prompt": "...", "choices": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "..."}],
  "short": [{"prompt": "...", "answer": "...", "acceptableKeywords": ["...", "..."]}],
  "flashcards": [{"term": "...", "definition": "..."}]
}
```

Copy that whole block, paste it into the "Import a test from Claude" box
on your Admin page, and click Import. It creates the class automatically
if it doesn't exist yet. This skips the site's own AI-generation call
entirely (I write the questions right here in chat), so it doesn't use
your Anthropic API budget at all -- only tests that *other* students
generate through the site itself do that.

I'm not able to reach your live database directly or sign in as you --
this import box is the bridge between "talk to Claude in chat" and "show
up on the website," without ever having to hand me a password or a
database key.

## Getting future changes without downloading a new zip

Once your code is on GitHub and Vercel is importing straight from that
repo (step 3 above), you're done with zip files for good: any time the
code on GitHub changes, Vercel automatically rebuilds and redeploys the
live site within about a minute, with no manual redeploy step.

So next time you want a change (a new feature, a bug fix, a design
tweak), tell me what you want in chat. I'll hand you back just the
specific file(s) that changed -- open that same file in your GitHub repo,
replace its contents, and commit. That's it; Vercel takes it from there.
For a really small change I can usually give you the exact lines to
paste in rather than a whole file.

## What's a placeholder right now

- **Payments.** The subscription is a single `status` column
  (`free`/`active`) in the `subscriptions` table. The "Unlock" button in
  the app (`demoUnlock()` in `app.js`) just flips it to `active` directly
  -- no money changes hands. When you're ready to charge:
  1. Set up a [Stripe](https://stripe.com) account and a Checkout page or
     Payment Link for your subscription price.
  2. **Important:** Stripe requires the account holder to be 18+, or the
     account to be set up under a registered business (sometimes with a
     parent/guardian). Worth sorting out before you tell people it's a
     paid product.
  3. Add a Stripe webhook (a small addition to `/api`) that listens for
     successful payments and updates the same `subscriptions` row --
     everything else in the app (the RLS rules, the lock icons) already
     reads that column, so nothing else needs to change.
- **"My school."** There's currently no check that a signup is actually
  from your school -- anyone with the link can create an account. An easy
  first step is restricting signup to email addresses ending in your
  school's domain (a small check in `handleAuthSubmit` in `app.js`, or a
  Supabase Auth email-domain restriction).
- **Photos of handwritten notes.** File upload currently supports `.txt`
  and text-based `.pdf` (one with real selectable text, not a scanned
  image). Reading handwritten photos would mean adding an OCR step --
  ask me if you want that added later.

## Where things live, if you want to change something

- `index.html` / `style.css` / `app.js` -- the whole frontend (no
  framework, no build step).
- `api/ai.js` -- the only server-side code; calls Claude to generate
  questions and grade short answers.
- `supabase/schema.sql` -- database tables and the security rules that
  enforce the free/paid split.
- `config.js` -- your Supabase URL/key (public, safe to commit).

If something breaks after deploying, the browser's console (right-click
-> Inspect -> Console) and Vercel's function logs (Project -> Deployments
-> the function) are the first places to look -- bring me the error and
I can help debug it.
