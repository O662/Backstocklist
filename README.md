# Backstock List

A shared backstock to-do list for phones. Snap a photo of the shelf tag, pick the aisle, and send it. Teammates see it within seconds, then mark it **Found**, **Can't get** (with a reason), or **Hold**. Closed items and their photos are deleted automatically, and the person who reported the item is notified.

- **Report:** camera, location, optional name and note, plus an optional "notify me when found" toggle
- **Checklist:** grouped by aisle and endcap, with a location filter and an "On hold" section
- **Updates:** results for items you reported, as push notifications and an in-app list
- Works in iPhone Safari and Android Chrome. Free to run: Supabase free tier plus GitHub Pages.

## How it works

| Piece | Service | Notes |
|---|---|---|
| Web app | GitHub Pages | Plain HTML, CSS and JS with no build step |
| Tasks + names | Supabase Postgres + Auth (anonymous sign-in) | Row Level Security: only people who joined can read or write, with an optional store code |
| Photos | Supabase Storage (private bucket) | Shrunk to about 150 KB on the phone before upload, viewed through short-lived signed links |
| Live list | Supabase Realtime | Changes appear in about 1–2 seconds, with a 45-second refresh as a fallback |
| Notifications | Supabase Edge Function + Web Push | `supabase/functions/send-push` |

---

## Setup

### 1. Create the Supabase project
1. At [supabase.com](https://supabase.com), create a new project named `backstock-list`.
   - Click **Generate a password** and save it somewhere. The app doesn't use it.
   - Under **Data access**, keep **Enable Data API** checked and check **Enable RLS on new tables automatically**.
2. Open **SQL Editor → New query**, paste all of [`supabase/setup.sql`](supabase/setup.sql), and click **Run**.

### 2. Let people join with just their name
No accounts or passwords: anyone with the link types their name and taps **Join**. Behind the scenes each phone gets an anonymous account. Their name is shown on items they report and is how "found / can't get" notices reach them.

1. Go to **Authentication → Sign In / Providers**. Make sure **Allow new users to sign up** is **on**, and turn **on** **Allow anonymous sign-ins**. Click **Save**.
2. **Set the admin password** (shared by you and your other leads). In the **SQL Editor**, run this with your own password (8+ characters):
   ```sql
   update public.team_settings
     set admin_password_hash = extensions.crypt('your-admin-password', extensions.gen_salt('bf'))
     where id = 1;
   ```
   It's stored scrambled, so nobody can read it from the database. After this, everything else is done from the app.

#### Admin mode (in the app)
Open **Settings → Admin**, enter the admin password, and tap **Unlock**. That phone stays an admin until you tap **Lock admin on this phone**. Admins can:
- **Store code:** set or change one (new people must enter it to join), or turn it off so anyone with the link can join. People who already joined aren't affected.
- **People:** see everyone who has joined and **Remove** anyone. Removing someone locks them out right away and deletes their open requests. Turn the store code on first (or change it), or they can just join again.
- **Admin password:** change it. If it leaked, change it and tap **Remove admin from everyone but me**.

Good to know:
- A person's identity lives in that browser on that phone. If they clear their browser data or tap **Leave on this phone**, they join again as a new person. They won't get updates for items they reported before.
- **iPhone:** Safari and the Home Screen app keep separate data, so join (and report) from the **Home Screen app** to get notifications.

### 3. Connect the app
In Supabase, click **Connect** (top bar) or go to **Project Settings → API Keys**. Copy:
- the **Project URL**, into `SUPABASE_URL` in [`config.js`](config.js)
- the **Publishable key** (`sb_publishable_…`), into `SUPABASE_KEY`

> Never put the **secret** / **service_role** key in `config.js`.

### 4. Put it online (GitHub Pages)
1. Push this repo to GitHub. Free Pages requires a **public** repo. That's fine: nothing in the code is secret, and the database only lets people who joined read the list.
2. Go to **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`, then click **Save**.
3. After about a minute it's live at `https://<your-github-username>.github.io/Backstocklist/`.

The app now works: join on two phones, report an item on one, and it appears on the other.

### 5. Turn on push notifications
Your keys were generated into **`secrets.local.txt`**. That file is git-ignored, so keep it private. `VAPID_PUBLIC_KEY` is already filled in `config.js`.

1. **Add secrets:** go to **Edge Functions → Secrets** and add:
   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | from `secrets.local.txt` |
   | `VAPID_PRIVATE_KEY` | from `secrets.local.txt` |
   | `WEBHOOK_SECRET` | from `secrets.local.txt` |
   | `VAPID_SUBJECT` | `mailto:` followed by your email address, e.g. `mailto:you@gmail.com` |
2. **Deploy the function:** go to **Edge Functions → Deploy a new function → Via Editor**. Name it **`send-push`**, replace the sample code with [`supabase/functions/send-push/index.ts`](supabase/functions/send-push/index.ts), and click **Deploy**.
3. In the function's **Details / Settings**, turn **off** "Verify JWT" ("Enforce JWT verification"). The function checks `WEBHOOK_SECRET` instead.
4. **Connect the database to it:** open [`supabase/push.sql`](supabase/push.sql) and replace `YOUR-PROJECT-REF` (the part before `.supabase.co` in your URL) and `YOUR-WEBHOOK-SECRET`. Then paste it into the **SQL Editor** and click **Run**. Don't commit the edited version.
5. **Test it:** on a phone, open the app, go to **Settings → Turn on notifications → Send me a test notification**.

### 6. Install on phones
- **iPhone (iOS 16.4+):** open the link in **Safari**, tap **Share → Add to Home Screen**, and open Backstock from the home screen. Then go to **Settings → Turn on notifications**. iPhones only allow web notifications for home-screen apps, and the home-screen app needs you to join again (just your name).
- **Android:** open the link in **Chrome**, tap **⋮ → Add to Home screen / Install app**, then go to **Settings → Turn on notifications**.

---

## Customizing
Edit [`config.js`](config.js):
- `LOCATIONS`: the location buttons and the checklist order. For example, split into `"Aisle 6 Front Endcap"` and `"Aisle 6 Back Endcap"`.
- `REASONS`: the quick-pick reasons for "Can't get".

## Troubleshooting
- **"Not set up yet" on the sign-in page:** fill in `config.js` (step 3).
- **Grey dot instead of green in the top bar:** the live connection dropped. The list still refreshes every 45 seconds and whenever you reopen the app.
- **No notifications:** check **Edge Functions → send-push → Logs**. A `403` means `WEBHOOK_SECRET` doesn't match `push.sql`, and "Missing secret" means a secret isn't set. On iPhone, make sure you're using the home-screen app.
- **Project paused:** free Supabase projects pause after about a week with no activity. Open the Supabase dashboard and click **Restore**. No data is lost.
