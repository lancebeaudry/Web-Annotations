# Avalanche Markup

Click-to-comment visual feedback for Avalanche Creative client sites. Clients click anywhere on their live site and type plain-English feedback; the tool invisibly captures the CSS selector, current text, and computed styles. The Avalanche team exports everything as a Markdown task list ready to paste into Claude Code.

- One-line embed, completely invisible to normal visitors — only activates with `?markup=TOKEN` in the URL.
- Shadow-DOM overlay, so the tool's styles and the client site's styles never collide.
- Supabase backend (Postgres + magic-link auth + realtime). No custom server.

## Setup (Stage 1 — one time)

1. **Create a Supabase project** at [database.new](https://database.new) (any name, e.g. `avalanche-markup`).
2. **Run the schema**: in the dashboard, open *SQL Editor*, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the tables, RLS policies, realtime publication, and a seed project with token `test-token`.
3. **Configure auth**:
   - *Authentication → Sign In / Up*: make sure the **Email** provider is enabled (magic links are the default).
   - *Authentication → URL Configuration → Redirect URLs*: add `http://localhost:8123/**` for local testing, plus `https://CLIENTSITE.com/**` for each client site you embed on.
4. **Fill in `.env`**: copy `.env.example` to `.env` and paste your project's URL and anon/publishable key from *Settings → API Keys*.
5. **Build**:
   ```sh
   npm install
   npm run build        # writes dist/markup.js
   ```

## Local testing

```sh
npm run dev
```

Then open <http://localhost:8123/test/index.html?markup=test-token>. You should be prompted for your email; click the magic link, land back on the page, and the Comment button appears bottom-right. Open the same URL **without** `?markup=...` and confirm nothing renders.

To verify realtime, open the page in two browsers (or a normal + private window with two different emails) and confirm a comment placed in one appears live in the other.

## Embedding on a client site

One command registers the site (creates the project row **and** allowlists the
sign-in redirect via the Supabase Management API):

```sh
npm run new-site -- "Client Name" https://clientsite.com
```

It prints the embed line and the share link. Requires two admin secrets in
`.env` (see `.env.example`): the **service role key** (Settings → API Keys)
and a **personal access token** (account menu → Access Tokens). Both stay on
this machine — never in `markup.js`, never in a theme.

Then:

1. Host `dist/markup.js` somewhere public (any static host/CDN works — or copy
   it into the site's child theme and enqueue it).
2. Add the printed embed line to the site's `<head>`:
   ```html
   <script defer src="https://YOUR_CDN/markup.js" data-project="PROJECT_TOKEN"></script>
   ```
3. Send the client: `https://clientsite.com/?markup=PROJECT_TOKEN`

<details>
<summary>Manual fallback (no admin secrets)</summary>

1. SQL Editor: `insert into projects (token, name, site_url) values ('SOME-LONG-RANDOM-TOKEN', 'Client Name', 'https://clientsite.com');`
2. Authentication → URL Configuration → Redirect URLs: add `https://clientsite.com/**`
</details>

## Using it

- **Clients**: open the link, sign in via the emailed magic link, hit **Comment**, click any element, type what should change. Click numbered pins to read threads and reply.
- **Avalanche team** (any `@avalanchegr.com` email): same, plus a **resolve/reopen** toggle on each thread and an **Export** button — Markdown (per page or whole project, ready for Claude Code) or raw JSON.

## Project layout

```
build.mjs              esbuild bundler; injects .env values at build time
supabase/schema.sql    tables + RLS + realtime + seed row
src/main.js            activation gate (?markup=TOKEN)
src/app.js             boot, auth flow, comment mode, toolbar, realtime
src/capture.js         selector builder, landmark finder, style capture
src/data.js            Supabase queries + realtime subscription
src/export.js          Markdown / JSON export for Claude Code
src/ui/                shadow-DOM overlay, auth card, pins, popovers, styles
test/index.html        fake client page for local testing
```

## Known v1 tradeoffs

1. **Selector stability across deploys** — if the site changes between comment and fix, a selector may break. `selector_fallback` (tag + text + landmark) is captured now and used for pin re-resolution; deeper recovery only if it bites.
2. **RLS is permissive** — any authed user can read any project's comments. Fine while tokens stay private per client. Upgrade to a `project_members` table when cross-client isolation matters.
3. **Anon key is public** — by design; RLS is the boundary. Never put the service-role key anywhere near the snippet.
4. **SPA sites** — `page_path` is read at load. If a client site is an SPA, hook history/pushState to re-render pins on route change (not needed for typical WordPress builds).
