// PinPoint Setup — fit questionnaire intake.
//
// POST { name, email, site, answers, result, company? }   (public, no auth)
// Stores the lead in setup_leads and emails the team. `company` is a
// honeypot: real people never see it, so anything in it is dropped quietly.
// A caller is limited to a handful of submissions an hour by a salted hash
// of their address (we never store the address itself).
// Deploy: supabase functions deploy setup-intake --no-verify-jwt --use-api

import { db, json } from "../_shared/db.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { sendEmail, mailerConfigured, FOOTER_HTML, FOOTER_TEXT } from "../_shared/email.ts";

const TEAM = Deno.env.get("SETUP_LEADS_TO") ?? "projects@avalanchegr.com";
const PAY_LINK = Deno.env.get("SETUP_PAYMENT_LINK") ?? "https://buy.stripe.com/bJe00l60K3lrbI18Fccs800";

// What the person who filled it in gets, by verdict.
function confirmation(result: string, first: string, site: string) {
  const hi = `Hi ${first},`;
  const sign = "The PinPoint team at Avalanche Creative";
  const button = (href: string, label: string) => `<p><a href="${href}" style="display:inline-block;padding:10px 16px;background:#1D5F96;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${label}</a></p>`;
  switch (result) {
    case "support": return {
      subject: "PinPoint: hosting and support looks like the better fit",
      text: `${hi}\n\nThanks for answering the questions about ${site}. You said you would rather we made the changes, so hosting and support is the better fit: you make requests in PinPoint and we get them live.\n\nSomeone from our team will reach out with what that includes and what it costs.\n\n${sign}`,
      html: `<p>${esc(hi)}</p><p>Thanks for answering the questions about ${esc(site)}. You said you would rather we made the changes, so hosting and support is the better fit: you make requests in PinPoint and we get them live.</p><p>Someone from our team will reach out with what that includes and what it costs.</p><p>${sign}</p>`,
    };
    case "move": return {
      subject: "PinPoint Setup: your site needs a move first",
      text: `${hi}\n\nThanks for answering the questions about ${site}. Squarespace, Wix and Webflow keep a site inside their own editor, so there are no files for an AI assistant to change.\n\nSomeone from our team will reach out with a quote for moving the site somewhere this works.\n\n${sign}`,
      html: `<p>${esc(hi)}</p><p>Thanks for answering the questions about ${esc(site)}. Squarespace, Wix and Webflow keep a site inside their own editor, so there are no files for an AI assistant to change.</p><p>Someone from our team will reach out with a quote for moving the site somewhere this works.</p><p>${sign}</p>`,
    };
    case "hosting": return {
      subject: "PinPoint Setup: one thing to sort out first",
      text: `${hi}\n\nThanks for answering the questions about ${site}. Everything looks fine except one thing: we can't set anything up until someone can sign in where the site is hosted.\n\nSomeone from our team will reach out to help you track that account down. It usually takes a day.\n\n${sign}`,
      html: `<p>${esc(hi)}</p><p>Thanks for answering the questions about ${esc(site)}. Everything looks fine except one thing: we can't set anything up until someone can sign in where the site is hosted.</p><p>Someone from our team will reach out to help you track that account down. It usually takes a day.</p><p>${sign}</p>`,
    };
    default: return {
      subject: "Your site is a fit for PinPoint Setup",
      text: `${hi}\n\nGood news: based on your answers, ${site} is a fit. Setup is $497, one time.\n\nSomeone from our team will reach out to schedule a setup call. If you would like to pay ahead, you can do that here:\n${PAY_LINK}\n\n${sign}`,
      html: `<p>${esc(hi)}</p><p>Good news: based on your answers, <b>${esc(site)}</b> is a fit. Setup is $497, one time.</p><p>Someone from our team will reach out to schedule a setup call. If you would like to pay ahead, you can do that here:</p>${button(PAY_LINK, "Pay $497 now")}<p>${sign}</p>`,
    };
  }
}
const SALT = Deno.env.get("NOTIFY_SECRET") ?? "pinpoint";
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

const LABELS: Record<string, Record<string, string>> = {
  platform: { wordpress: "WordPress", shopify: "Shopify", code: "Custom code or plain files", builder: "Squarespace, Wix or Webflow", unknown: "Not sure" },
  hosting: { yes: "Has the login", can: "Can get it", unknown: "Doesn't know who has it" },
  staging: { yes: "Yes", no: "No", unknown: "Not sure" },
  ai: { none: "Doesn't use AI", chat: "Chat tools", code: "Has used a coding assistant" },
  changes: { copy: "Text and photos", layout: "Layout and new sections", build: "New pages and features" },
  run: { self: "Will run it themselves", avalanche: "Wants Avalanche to do it" },
};
const QUESTION: Record<string, string> = { platform: "Built on", hosting: "Hosting login", staging: "Staging copy", ai: "AI today", changes: "Changes most", run: "Who runs it" };
const RESULT: Record<string, string> = { fit: "Fit for the $497 setup", support: "Hosting and support lead", move: "Needs a platform move first", hosting: "Needs to find the hosting account" };

async function hash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SALT}:${s}`));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  const cors = corsHeaders(req);
  if (req.method !== "POST") return json(405, { error: "POST only" }, cors);
  let b: any;
  try { b = await req.json(); } catch { return json(400, { error: "bad JSON" }, cors); }
  if (clip(b.company, 200)) return json(200, { ok: true }, cors); // honeypot

  const name = clip(b.name, 120), email = clip(b.email, 200).toLowerCase(), site = clip(b.site, 300);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !site) return json(400, { error: "Name, a valid email and your site are required." }, cors);
  const answers: Record<string, string> = {};
  for (const k of Object.keys(LABELS)) { const v = clip(b.answers?.[k], 40); if (LABELS[k][v]) answers[k] = v; }
  const result = RESULT[clip(b.result, 20)] ? clip(b.result, 20) : "fit";

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const who = await hash(ip);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await db<any[]>(`setup_leads?ip_hash=eq.${who}&created_at=gte.${since}&select=id`);
  if (recent.length >= 5) return json(429, { error: "Too many submissions. Email projects@avalanchegr.com instead." }, cors);

  // One confirmation per address per day, so the form can't be used to
  // send repeated mail to someone who never asked for it.
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const already = await db<any[]>(`setup_leads?email=eq.${encodeURIComponent(email)}&created_at=gte.${dayAgo}&select=id&limit=1`);

  await db("setup_leads", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ name, email, site, answers, result, ip_hash: who, user_agent: clip(req.headers.get("user-agent"), 300) }) });

  if (mailerConfigured()) {
    const rows = Object.keys(QUESTION).map((k) => [QUESTION[k], LABELS[k][answers[k]] ?? "—"]);
    const text = `${name} <${email}>\nSite: ${site}\nResult: ${RESULT[result]}\n\n${rows.map(([q, a]) => `${q}: ${a}`).join("\n")}\n${FOOTER_TEXT}`;
    const html = `<p><b>${esc(name)}</b> &lt;<a href="mailto:${esc(email)}">${esc(email)}</a>&gt;<br>Site: ${esc(site)}</p>` +
      `<p style="font-size:16px"><b>${esc(RESULT[result])}</b></p>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-size:14px">${rows.map(([q, a]) => `<tr><td style="color:#555;border-bottom:1px solid #eee">${esc(q)}</td><td style="border-bottom:1px solid #eee">${esc(a)}</td></tr>`).join("")}</table>` + FOOTER_HTML;
    try { await sendEmail({ to: TEAM, subject: `Setup questionnaire: ${name} — ${RESULT[result]}`, text, html }); }
    catch (e) { console.error("setup lead email failed", e); }
    if (!already.length) {
      const c = confirmation(result, name.split(/\s+/)[0], site);
      try { await sendEmail({ to: email, subject: c.subject, text: c.text + FOOTER_TEXT, html: c.html + FOOTER_HTML }); }
      catch (e) { console.error("setup confirmation email failed", e); }
    }
  }
  return json(200, { ok: true }, cors);
});
