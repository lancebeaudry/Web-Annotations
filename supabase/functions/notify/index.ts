// PinPoint — new-comment notifier.
//
// Triggered by the `comments_notify` Postgres trigger (see
// supabase/notifications.sql) on every comment INSERT. Works out who to
// email and sends through the provider in _shared/email.ts (Resend):
//   * @mentions    -> the people tagged in the comment (always)
//   * notify list  -> the project's notify_recipients, on any new pin or
//                     reply, whoever wrote it
// The comment author is never emailed about their own comment. Guests have
// no email (author_email is 'guest:<uid>'), so they can't be notified, but
// their comments do notify the list.
//
// Secrets: NOTIFY_SECRET (shared with the trigger), RESEND_API_KEY,
//          MAIL_FROM, optional MAIL_PROVIDER (see _shared/email.ts).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// Deploy: supabase functions deploy notify --no-verify-jwt

import { db, json } from "../_shared/db.ts";
import { sendEmail, mailerConfigured, mailProvider, FOOTER_HTML, FOOTER_TEXT } from "../_shared/email.ts";
import { dispatchIntegrations, deepLink } from "../_shared/integrations.ts";

const NOTIFY_SECRET = Deno.env.get("NOTIFY_SECRET") ?? "";

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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (NOTIFY_SECRET && req.headers.get("x-notify-secret") !== NOTIFY_SECRET) {
    return json(401, { error: "bad secret" });
  }

  let record: Comment; let payload: any;
  try {
    payload = await req.json();
    record = payload.record;
    if (!record?.id) throw new Error("no record");
  } catch {
    return json(400, { error: "bad payload" });
  }
  const eventKind: "insert" | "update" = payload.event === "update" ? "update" : "insert";

  const author = (record.author_email || "").toLowerCase();
  const isReply = !!record.parent_id;

  const projects = await db<{ name: string; site_url: string; token: string }[]>(
    `projects?id=eq.${record.project_id}&select=name,site_url,token`,
  );
  const project = projects[0];
  if (!project) return json(200, { skipped: "unknown project" });

  // Slack / ClickUp (Agency plan). Status and assignee changes only go here.
  const integrations = await dispatchIntegrations(eventKind, record as any, payload.old_record ?? null, { id: record.project_id, ...project }).catch((e) => {
    console.error("integrations failed", e);
    return { ran: 0 };
  });
  if (eventKind === "update") {
    // Moved to "waiting on client" with someone assigned: tell that person.
    const old = payload.old_record ?? {};
    const assignee = (record.assignee_email || "").toLowerCase().trim();
    const becameWaiting = record.status === "waiting" && (old.status !== "waiting" || (old.assignee_email || "").toLowerCase() !== assignee);
    if (becameWaiting && assignee && mailerConfigured()) {
      const link = deepLink({ id: record.project_id, ...project }, record as any);
      const snippet = record.comment_text.length > 300 ? record.comment_text.slice(0, 300) + "…" : record.comment_text;
      const lead = `An item on ${project.name} needs your decision before work can continue.`;
      const text = `${lead}\n\nPage: ${record.page_path}\n"${snippet}"\n\nOpen it and reply: ${link}\n${FOOTER_TEXT}`;
      const html = `<p>${esc(lead)}</p><p style="color:#555">Page: ${esc(record.page_path)}</p>` +
        `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #ddd;color:#333">${esc(snippet)}</blockquote>` +
        `<p><a href="${esc(link)}" style="display:inline-block;padding:8px 14px;background:#1B6493;color:#fff;border-radius:6px;text-decoration:none">Open and reply</a></p>` + FOOTER_HTML;
      try { await sendEmail({ to: assignee, subject: `Needs your decision — ${project.name}`, text, html, idempotencyKey: `waiting-${record.id}-${assignee}-${Date.now()}` }); }
      catch (e) { console.error("waiting email failed", e); }
      return json(200, { sent: 1, integrations: integrations.ran });
    }
    return json(200, { sent: 0, integrations: integrations.ran });
  }

  // recipient email -> reason. "mention" wins over "team" for wording.
  const recipients = new Map<string, "mention" | "team">();
  for (const raw of record.mentions ?? []) {
    const e = (raw || "").toLowerCase().trim();
    if (e && e !== author) recipients.set(e, "mention");
  }
  const list = await db<{ email: string }[]>(`notify_recipients?project_id=eq.${record.project_id}&select=email`);
  for (const r of list) {
    const e = (r.email || "").toLowerCase().trim();
    if (e && e !== author && !recipients.has(e)) recipients.set(e, "team");
  }
  if (recipients.size === 0) return json(200, { sent: 0 });

  if (!mailerConfigured()) {
    // 200 so pg_net never retries a configuration problem; loud in the logs.
    console.error(`mailer not configured (provider=${mailProvider()}) — ${recipients.size} notification(s) dropped`);
    return json(200, { error: "mailer not configured", pending: recipients.size });
  }

  const who = author.startsWith("guest:")
    ? (record.author_name || "A guest")
    : author.startsWith("agent:")
    ? `${record.author_name || "AI assistant"} (AI assistant)`
    : (record.author_name ? `${record.author_name} (${author})` : author);
  const deepLinkUrl = deepLink({ id: record.project_id, ...project }, record as any);
  const kind = isReply ? "replied" : (record as any).kind === "reference" ? `saved a reference from ${(((record as any).source || {}).host) || "another site"}` : "left a comment";
  const snippet = record.comment_text.length > 300 ? record.comment_text.slice(0, 300) + "…" : record.comment_text;

  let sent = 0;
  for (const [email, reason] of recipients) {
    const subject = reason === "mention" ? `${who} mentioned you on ${project.name}` : `New comment on ${project.name}`;
    const lead = reason === "mention" ? `${who} mentioned you in feedback on ${project.name}.` : `${who} ${kind} on ${project.name}.`;
    const text = `${lead}\n\nPage: ${record.page_path}\n"${snippet}"\n\nOpen it: ${deepLinkUrl}\n${FOOTER_TEXT}`;
    const html =
      `<p>${esc(lead)}</p>` +
      `<p style="color:#555">Page: ${esc(record.page_path)}</p>` +
      `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #ddd;color:#333">${esc(snippet)}</blockquote>` +
      `<p><a href="${esc(deepLinkUrl)}" style="display:inline-block;padding:8px 14px;background:#1B6493;color:#fff;border-radius:6px;text-decoration:none">Open in PinPoint</a></p>` +
      FOOTER_HTML;
    try {
      await sendEmail({ to: email, subject, text, html, idempotencyKey: `notify-${record.id}-${email}` });
      sent++;
    } catch (e) {
      console.error(`send to ${email} failed:`, e);
    }
  }
  return json(200, { sent, recipients: recipients.size, provider: mailProvider(), integrations: integrations.ran });
});
