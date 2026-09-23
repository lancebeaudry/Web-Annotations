// Outbound email. Resend (HTTP API) is the provider; the Gmail SMTP path is
// kept ONLY as a transitional fallback until mail.avalanchegr.com is
// verified, selected by MAIL_PROVIDER=gmail. Delete the Gmail branch (and
// the GMAIL_* secrets) once Resend is live.
//
// Secrets: RESEND_API_KEY, MAIL_FROM ("PinPoint by Avalanche <notify@mail.avalanchegr.com>")
//          MAIL_PROVIDER (optional: resend | gmail; default resend when a key is set)
//          GMAIL_USER, GMAIL_APP_PASSWORD (transitional)

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "";
const GMAIL_USER = Deno.env.get("GMAIL_USER") ?? "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") ?? "";
const PROVIDER = (Deno.env.get("MAIL_PROVIDER") ?? (RESEND_API_KEY ? "resend" : "gmail")).toLowerCase();

export type Mail = { to: string; subject: string; text: string; html: string; idempotencyKey?: string };

export function mailerConfigured(): boolean {
  return PROVIDER === "resend" ? !!(RESEND_API_KEY && MAIL_FROM) : !!(GMAIL_USER && GMAIL_APP_PASSWORD);
}

export function mailProvider(): string {
  return PROVIDER;
}

export async function sendEmail(m: Mail): Promise<string> {
  if (PROVIDER === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from: MAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
    return (await res.json()).id ?? "";
  }
  // Transitional Gmail SMTP path.
  const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD } },
  });
  try {
    await client.send({ from: `PinPoint by Avalanche <${GMAIL_USER}>`, to: m.to, subject: m.subject, content: m.text, html: m.html });
  } finally {
    await client.close();
  }
  return "";
}

// Branded footer appended to every notification.
export const FOOTER_HTML =
  `<p style="margin-top:20px;font-size:12px;color:#6b7a85">Sent by <a href="https://pinpoint.avalanchegr.com/?utm_source=pinpoint&amp;utm_medium=email&amp;utm_campaign=notify" style="color:#1B6493">PinPoint, by Avalanche Creative</a></p>`;
export const FOOTER_TEXT = `\n— PinPoint, by Avalanche Creative · https://pinpoint.avalanchegr.com\n`;
