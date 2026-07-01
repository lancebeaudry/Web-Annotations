// Avalanche Markup — new-comment notifier.
//
// Triggered by the `comments_notify` Postgres trigger (see
// supabase/notifications.sql) on every comment INSERT. It works out who
// to email and sends via Gmail SMTP:
//   * @mentions    -> the people tagged in the comment (always)
//   * team notify  -> the project's notify_recipients, but only for
//                     CLIENT comments (skip our own team's, to avoid
//                     self-noise). Fires for new pins AND replies.
// The comment author is never emailed about their own comment.
//
// Secrets (supabase secrets set ...):
//   NOTIFY_SECRET        shared with the trigger; rejects forged calls
//   GMAIL_USER           e.g. noreply@avalanchegr.com
//   GMAIL_APP_PASSWORD   16-char Google app password
//   TEAM_DOMAIN          optional, defaults to avalanchegr.com
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";
const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const TEAM_DOMAIN = (Deno.env.get("TEAM_DOMAIN") ?? "avalanchegr.com").toLowerCase();

type Comment = {
  id: string;
  project_id: string;
  parent_id: string | null;
  page_url: string;
  page_path: string;
  comment_text: string;
  author_email: string;
  author_name: string | null;
  mentions: string[] | null;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Thin PostgREST helper using the service-role key (bypasses RLS).
async function db(path: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`db ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (NOTIFY_SECRET && req.headers.get("x-notify-secret") !== NOTIFY_SECRET) {
    return json(401, { error: "bad secret" });
  }

  let record: Comment;
  try {
    record = (await req.json()).record;
    if (!record?.id) throw new Error("no record");
  } catch {
    return json(400, { error: "bad payload" });
  }

  const author = (record.author_email || "").toLowerCase();
  const isReply = !!record.parent_id;

  // Look up the project for naming + deep links.
  const projects = await db(
    `projects?id=eq.${record.project_id}&select=name,site_url,token`,
  );
  const project = projects[0];
  if (!project) return json(200, { skipped: "unknown project" });

  // recipient email -> reason. "mention" wins over "team" for wording.
  const recipients = new Map<string, "mention" | "team">();

  // @mentions: always notify the tagged people.
  for (const raw of record.mentions ?? []) {
    const e = (raw || "").toLowerCase().trim();
    if (e && e !== author) recipients.set(e, "mention");
  }

  // Team notify list: alert the project's recipients on any new comment
  // (pins + replies), whether the author is a client or a teammate. The
  // author themselves is never emailed about their own comment.
  {
    const list = await db(
      `notify_recipients?project_id=eq.${record.project_id}&select=email`,
    );
    for (const r of list) {
      const e = (r.email || "").toLowerCase().trim();
      if (e && e !== author && !recipients.has(e)) recipients.set(e, "team");
    }
  }

  if (recipients.size === 0) return json(200, { sent: 0 });

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error("Gmail credentials missing — cannot send");
    return json(200, { error: "mailer not configured", pending: recipients.size });
  }

  const who = record.author_name ? `${record.author_name} (${author})` : author;
  const deepLink = `${record.page_url}?markup=${encodeURIComponent(project.token)}`;
  const kind = isReply ? "replied" : "left a comment";
  const snippet = record.comment_text.length > 300
    ? record.comment_text.slice(0, 300) + "…"
    : record.comment_text;

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
    },
  });

  let sent = 0;
  try {
    for (const [email, reason] of recipients) {
      const subject = reason === "mention"
        ? `${who} mentioned you on ${project.name}`
        : `New comment on ${project.name}`;
      const lead = reason === "mention"
        ? `${who} mentioned you in feedback on ${project.name}.`
        : `${who} ${kind} on ${project.name}.`;

      const text =
        `${lead}\n\n` +
        `Page: ${record.page_path}\n` +
        `"${snippet}"\n\n` +
        `Open it: ${deepLink}\n`;

      const html =
        `<p>${esc(lead)}</p>` +
        `<p style="color:#555">Page: ${esc(record.page_path)}</p>` +
        `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #ddd;color:#333">${esc(snippet)}</blockquote>` +
        `<p><a href="${esc(deepLink)}" style="display:inline-block;padding:8px 14px;background:#2f6fed;color:#fff;border-radius:6px;text-decoration:none">Open in Markup</a></p>`;

      try {
        await client.send({
          from: `Avalanche Markup <${GMAIL_USER}>`,
          to: email,
          subject,
          content: text,
          html,
        });
        sent++;
      } catch (e) {
        console.error(`send to ${email} failed:`, e);
      }
    }
  } finally {
    await client.close();
  }

  return json(200, { sent, recipients: recipients.size });
});
