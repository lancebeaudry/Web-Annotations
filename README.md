# PinPoint by Avalanche

Click-to-comment website feedback, by Avalanche Creative. (Product name since 2.1; the code, plugin slug `avalanche-markup`, `?markup=` parameter, bucket and constants keep their original identifiers on purpose — renaming them would break every installed site.) A reviewer opens a page with a special link, clicks anywhere, and leaves a pinned, threaded comment — with screenshots, @mentions, device previews, and email notifications.

**Proprietary — all rights reserved.** See `LICENSE`. This repository is the internal source; it is not for distribution and cannot go on wordpress.org (which requires GPL).

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Overlay | `src/` → `dist/markup.js` | The feedback UI. One self-contained bundle (esbuild, IIFE). Runs on WordPress and any other site. |
| WordPress plugin | `wordpress-plugin/avalanche-markup/` | Injects the bundle (shipped *inside* the plugin), settings page, editor auto-sign-in bridge, self-updater. |
| Hosted bundle | Supabase Storage bucket `markup` → `…/storage/v1/object/public/markup/markup.js` | For non-WordPress sites: one `<script>` tag. Also holds the plugin zip + `plugin/update.json` the updater polls. |
| Backend | Supabase (`supabase/`) | Postgres + RLS, Auth (email code + anonymous guests), Storage (`comment-media`), Edge Functions. |
| Customer dashboard | `dashboard/` → GitHub Pages (`lancebeaudry/avalanche-markup-app`, custom domain `pinpoint.avalanchegr.com`: landing at `/`, dashboard at `/app/`) | Sign up, projects, install instructions, collaborators, notifications, site secret, plan/billing. Static, hash-routed. supabase.co refuses to serve HTML, hence Pages. |
| Release tooling | `admin/release.mjs`, `admin/deploy-app.mjs`, `build.mjs`, `build-app.mjs` | See *Releasing*. |

## Access model (2.0)

- **Operator** — Avalanche staff. A row in `operators` (not an email-domain rule). Sees and can moderate every project. Disclosed in the privacy policy. Manage with `add_operator(email)` / `remove_operator(email)` (operator-only RPCs).
- **Owner** — the account that created a project (`projects.owner_id`). Full control of that project: invite, export, resolve, settings, site secret, delete.
- **Collaborator** — an email the owner invited (`project_members`). Comment, reply, edit/delete own.
- **Guest** — on a project with *open feedback*, anyone with the link who types a name (anonymous session). Comment, reply, edit/delete own.

Plans: **free = 1 project, 50 comments + 10 images per project**, **Pro = 10 projects ($19/mo or $149/yr)**, **Agency = unlimited projects + integrations + page approvals ($39/mo or $349/yr)**. Limits are enforced by the database (a `BEFORE INSERT` trigger on `projects`, error `PROJECT_LIMIT_REACHED`). If a plan lapses, the owner's *oldest* projects stay live up to the free limit and newer ones become read-only — nothing is deleted. `subscriptions.plan` is written **only** by the Stripe webhook.

Every permission lives in RLS + `SECURITY DEFINER` helpers (`is_operator`, `is_project_owner`, `can_read_project`, `project_is_writable`, `my_project_role`, …). The anon key is public by design, so nothing may rely on client-side checks.

## Setup (one time)

1. `.env` from `.env.example` — public values (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DASHBOARD_URL`, …) plus server-only `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ACCESS_TOKEN` (never shipped).
2. Database, in this order (each is idempotent): `schema.sql` → `notifications.sql` → `project-scoping.sql` → `attachments.sql` → `open-access.sql` → `team-create-projects.sql` → `lock-down-reads.sql` → `distribution.sql` → `tenancy.sql` → `dashboard.sql` → `agent.sql` → `v22.sql` → `v22b.sql`. Apply via the SQL editor or the Management API. Do not run the older files *after* `tenancy.sql` — they would reintroduce the pre-2.0 policies.
3. Auth: anonymous sign-ins on; email OTP 6 digits; rate limits (anonymous 20/h/IP, email 100/h); URL allowlist includes `DASHBOARD_URL/**`.
4. Edge functions (all `--no-verify-jwt`): `notify`, `notify-sync`, `project-settings`, `wp-session`, `media-sweep`, `billing-checkout`, `billing-portal`, `stripe-webhook`, `agent`, `mcp`, `integration-test`. Deploy with `supabase functions deploy <name> --project-ref <ref> --no-verify-jwt --use-api` (`--use-api` avoids the Docker/TTY hang).
5. Secrets: `NOTIFY_SECRET` (must equal `private.app_settings.notify_secret`), mail (`RESEND_API_KEY`, `MAIL_FROM`, `MAIL_PROVIDER`; transitional `GMAIL_USER`/`GMAIL_APP_PASSWORD`), `LEGACY_WP_AUTH_SECRET` (old global bridge secret, until every plugin is on 2.0), `DASHBOARD_URL`, Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`).

## Local development

```bash
npm run dev          # overlay: rebuild on change + serve http://localhost:8123/test/index.html?markup=test-token (real backend)
npm run build:mock   # overlay against test/mock-supabase.js, no backend: test/mock.html?markup=test-token&mockRole=owner
npm run dev:app      # dashboard on http://localhost:8124
```

Mock roles: `?mockRole=operator|owner|collaborator|guest|none`, `?mockLimit=1` to hit the plan limit, an unseeded `?markup=` token to exercise auto-register. Note the overlay retries a token lookup 4×200 ms before registering — in a background browser tab, timers throttle, so allow several seconds.

Always verify a rebuild actually landed before shipping (function names minify; grep a string literal from your change in `dist/markup.js`). The release script does this for you.

## Releasing

```bash
npm run release -- 2.1.0 --changelog "What changed" --marker "some string from the change"
```

`admin/release.mjs` refuses a dirty tree or a non-increasing version, builds with `MARKUP_VERSION` baked in, verifies the bundle carries that literal (plus the Supabase URL and your markers), stages it into the plugin, bumps the plugin header and `update.json`, builds and verifies the zip, **commits and tags first**, then uploads to the bucket in dependency order — the versioned zip and bundle (immutable), `markup.js` and the alias zip (60 s cache), and `plugin/update.json` **last** (it is the switch) — verifying each object's bytes, then pushes. Dry run: `npm run release:dry -- 2.1.0`.

Dashboard: `npm run build:app && npm run deploy:app` (pushes `dist/app` to the Pages repo; live in about a minute). `npm run deploy:bundle` uploads the overlay bundle only.

Both scripts spawn `git`/`zip`; in environments that block child processes, run the same steps by hand (they are listed at the top of each script).

**Sites do not auto-update.** WordPress polls `plugin/update.json` hourly (or on *Updates → Check again*), shows "update available", and an admin clicks Update. Non-WordPress embeds follow `markup.js` automatically within a minute.

## Installing on a site

**WordPress:** upload `avalanche-markup.zip`, set the token under *Settings → PinPoint*, and add the project's **site secret** to `wp-config.php`:

```php
define( 'AVALANCHE_MARKUP_PROJECT_SECRET', '…' ); // Markup → Invite → Site secret, or the dashboard
```

The secret is per project and rotatable; it lets the plugin sync the notify list / open-feedback flag and sign editors in (owner or invited collaborators only — never operators). No service key ever goes on a customer server.

**Any other site:**

```html
<script defer src="https://vaculezzigjtgbysnajf.supabase.co/storage/v1/object/public/markup/markup.js" data-project="TOKEN" data-open="1"></script>
```

A project is registered the first time its owner opens `?markup=TOKEN` while signed in, or from the dashboard. Guests can't register a site; they get a card pointing at the dashboard.

## Email

Notifications (`notify`) and sign-in codes go through the provider in `supabase/functions/_shared/email.ts`. Target: **Resend** on `mail.avalanchegr.com` (never the company mailbox). Until the domain is verified, `MAIL_PROVIDER=gmail` keeps the old Gmail SMTP path. Cut-over: verify the domain in Resend → set `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_PROVIDER=resend` → redeploy `notify` → switch Auth SMTP to Resend's relay → delete the Gmail branch and secrets. Details in `supabase/NOTIFICATIONS_SETUP.md`.

## Billing

Stripe Checkout (`billing-checkout`), Customer Portal (`billing-portal`), and the webhook (`stripe-webhook`, the only writer of `subscriptions`). Functions answer `503 billing not configured` until the `STRIPE_*` secrets exist. Owner checklist: product "PinPoint Pro" with a yearly price → `STRIPE_PRICE_ID`; webhook endpoint `…/functions/v1/stripe-webhook` with `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed` → `STRIPE_WEBHOOK_SECRET`; portal enabled; smart retries with "cancel after final retry".

## Operating

- Persona check after any RLS change (via the Management API): set `request.jwt.claims` + `set local role authenticated`, count projects/comments as operator (real uid), a collaborator, a stranger, and an anonymous guest.
- Attachments: uploads are scoped to a writable project prefix and the plan quota; deleted comments tombstone their images; `media-sweep` runs hourly (pg_cron) and refuses to sweep when it can't read comments.
- Bridges log `legacy-secret-used <token>` while a site is still on the old global secret; when that goes quiet, unset `LEGACY_WP_AUTH_SECRET`/`WP_AUTH_SECRET` and rotate the service-role key (it lived on customer servers before 2.0).
- Repo privacy: the plugin updater and hosted bundle no longer depend on GitHub, so this repository can be private. The dashboard's Pages repo must stay public (compiled files only, no secrets).

## AI-assistant loop (2.1)

Owner/operator Markdown exports end with an "For AI coding assistants" block: each item carries its comment ID, and the block gives the per-project **agent key** (`get_agent_key()` / `rotate_agent_key()`, stored in `project_secrets.agent_key`) plus the `agent` edge function endpoint. The assistant can `GET ?status=open` to list items and `POST {comment_id, reply, resolve:true}` to close them; replies land as `author_role = 'agent'` and are labelled "AI assistant". The dashboard's project page shows the key and a CLAUDE.md snippet that tells the assistant to always close the loop.

## Pin anchoring (2.1)

`capture()` stores a v2 fingerprint in `selector_fallback` (tag, text, stable classes, key attributes, id ancestor / preceding heading, twin index). `locateElement()` scores every candidate — the stored selector is only one source of candidates, never trusted blindly, because positional `nth-of-type` paths keep matching *something* after a wrapper or banner is inserted. Pins re-render on resize, load, font/image load, and (debounced) DOM mutation; a pin that could only be placed approximately gets an amber ring.

## 2.2: inbox, approvals, integrations, MCP

- **Statuses** `open | in_progress | resolved | wont_fix` + `assignee_email` on comments. Owner/operator set both; an assignee may set status on their own items (RLS). "Open" everywhere means open **or** in progress.
- **Free caps** are enforced in the DB: `comments_before_write` raises `COMMENT_LIMIT_REACHED` at `plans.comment_limit`; `storage_upload_allowed` refuses uploads past `plans.image_limit`. The overlay shows `n/50` in the toolbar and a cap card.
- **Page approvals** (`page_approvals`, Agency feature): `approve_page()` locks new pins on that page (trigger raises `PAGE_APPROVED`); `revoke_approval()` reopens. Overlay shows "Approved by …" and hides the Comment button.
- **Integrations** (`integrations`, Agency): Slack incoming webhook and ClickUp token+list, dispatched from `notify` on insert and on status/assignee updates (`comments_notify_update` trigger). ClickUp task ids live in `comments.external_ref`. Secrets never leave the service role; the dashboard sees a masked summary.
- **Context + screenshots**: `comments.context` (browser, viewport, console errors) and an automatic html2canvas capture (cdnjs, lazy) unless `projects.auto_screenshot` is off.
- **MCP**: `functions/mcp` is a stateless Streamable-HTTP MCP server (JSON responses). `claude mcp add --transport http pinpoint <url> --header "x-pinpoint-agent-key: …"`. Tools: list_feedback, list_pages, get_feedback, reply, set_status, assign, project_info.
- **Stripe**: prices carry `metadata.plan`; the webhook maps a paid subscription to that plan. `billing-checkout` takes `{plan, interval}` and switches an active subscription in place.

## 2.3: triage — waiting on client, labels, effort, digest

- **Status `waiting`** ("Waiting on client") joins the open states; it counts as open everywhere. Moving an item to waiting with an assignee emails that person a "Needs your decision" note (`notify`, update event).
- **Labels** `comments.labels text[]` ⊂ `bug copy design content photo decision`; **effort** `comments.effort` ∈ `quick medium large`. Editable by whoever can set status: chips + select in the overlay popover, chips + select in the dashboard inbox. Exports lead with a Summary grouped by waiting / quick / medium / large / photos-and-content.
- **MCP `triage` tool** (`{id, labels?, effort?}`), `list_feedback` gains `label`; the server instructions tell the assistant to triage untriaged items first and mark client decisions as waiting.
- **Digest** (`functions/digest`): owner/operator POST `{project_id, to?}` emails collaborators (+ assignees of waiting items) the waiting list grouped by page with deep links; `{all:true}` + `x-notify-secret` is the weekly run (pg_cron `pinpoint-digest-weekly`, Mondays 13:00 UTC) for projects with `projects.digest_weekly`. Dashboard inbox has "Email the client now" and the weekly toggle (`update_digest_settings`). Migration: `supabase/v23.sql`.
- **AI replies as a person** (2.2.3): `agent_persona()` / `update_agent_settings()`; `comments.via_agent` keeps the assistant name. Migration: `supabase/v223.sql`.
