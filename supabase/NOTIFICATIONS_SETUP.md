# Mentions & notifications — activation runbook

The code is shipped. These are the live steps to switch it on. Nothing
emails anyone until step 5 is done (the trigger is a no-op until the
`notify_url` row exists).

Project ref: `vaculezzigjtgbysnajf`

## 1. Apply the database migration

Run `supabase/notifications.sql` once against the live DB (Supabase
dashboard → SQL Editor → paste the file → Run). It is idempotent.

Adds: `comments.mentions`, `notify_recipients` table, `list_mentionable()`
RPC, `private.app_settings`, and the `comments_notify` trigger.

> ⚠️ This must be applied **before** shipping the rebuilt `markup.js`,
> because the new client writes the `mentions` column on every insert.

## 2. Deploy the Edge Function

```bash
# one-time
brew install supabase/tap/supabase
supabase login
supabase link --project-ref vaculezzigjtgbysnajf

# deploy (the function checks a shared secret, so skip JWT verification)
supabase functions deploy notify --no-verify-jwt
```

## 3. Set the function secrets

Needs the Gmail **app password** (the same one for sign-in email — still
to be generated for `noreply@avalanchegr.com`).

Generate a shared secret and keep it OUT of this (public) repo —
paste it straight into the commands below and step 4:

```bash
openssl rand -hex 24          # -> <NOTIFY_SECRET>

supabase secrets set \
  NOTIFY_SECRET=<NOTIFY_SECRET> \
  GMAIL_USER=noreply@avalanchegr.com \
  GMAIL_APP_PASSWORD='xxxx xxxx xxxx xxxx' \
  TEAM_DOMAIN=avalanchegr.com
```

## 4. Point the trigger at the function

Run in the SQL Editor (the secret must match step 3):

```sql
insert into private.app_settings (key, value) values
  ('notify_url',    'https://vaculezzigjtgbysnajf.supabase.co/functions/v1/notify'),
  ('notify_secret', '<NOTIFY_SECRET>')   -- same value as the secret in step 3
on conflict (key) do update set value = excluded.value;
```

## 5. Ship the client

`release.mjs` pins the plugin to a pushed commit, so build and push the
new `dist/markup.js` *first*:

```bash
npm run build              # bakes the new overlay into dist/markup.js
git add -A && git commit -m "Mentions + notifications" && git push
npm run release            # stamps AVMK_REF to that commit, redeploys
                           # the plugin locally, refreshes the zip
git add -A && git commit -m "Bump plugin ref" && git push
```

Live (WP Engine) sites pick up the new ref on their next plugin upload
from `~/Desktop/avalanche-markup.zip`.

## 6. Set the notify list per site

In WordPress → Settings → Avalanche Markup → "Email notifications", add
the addresses that should hear about new client comments. Saving pushes
them to `notify_recipients` (requires the wp-config Supabase constants).

## Test

1. Open a site with `?markup=TOKEN`, sign in as a **non**-team email
   (a client/invited address).
2. Leave a comment that `@mentions` a teammate.
3. Expect: the mentioned teammate gets a "mentioned you" email, and
   everyone on that site's notify list gets a "new comment" email.
4. A comment from an `@avalanchegr.com` address should **not** trigger
   the team-notify email (mentions still fire).
