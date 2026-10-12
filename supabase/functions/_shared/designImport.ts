// Import a design system from a web address: either the tokens file itself,
// or a style guide page that is built from one. Lets an owner paste the
// address of their design system page instead of an API or JSON.
//
// Only public https addresses are fetched (no IP literals, no local or
// internal names), redirects are followed by hand and re-checked, and
// responses are capped at 1 MB with an 8 s timeout.

const MAX_BYTES = 1_000_000;
const BAD_HOST = /^(localhost|.*\.(local|localhost|internal|lan|home|corp|test|invalid))$/i;

export function safeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host) || BAD_HOST.test(host)) return null;
  return u;
}

async function get(url: URL): Promise<{ url: URL; type: string; body: string } | null> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(cur, { redirect: "manual", signal: ctl.signal, headers: { Accept: "application/json, text/html;q=0.9, */*;q=0.5", "User-Agent": "PinPoint design import" } });
      if (res.status >= 300 && res.status < 400) {
        const next = safeUrl(new URL(res.headers.get("location") || "", cur).toString());
        clearTimeout(timer);
        if (!next) return null;
        cur = next;
        continue;
      }
      if (!res.ok || !res.body) { clearTimeout(timer); return null; }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > MAX_BYTES) { await reader.cancel(); clearTimeout(timer); return null; }
        chunks.push(value);
      }
      clearTimeout(timer);
      const buf = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) { buf.set(c, o); o += c.length; }
      return { url: cur, type: res.headers.get("content-type") || "", body: new TextDecoder().decode(buf) };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }
  return null;
}

const asTokens = (body: string): any | null => {
  try {
    const t = JSON.parse(body);
    return t && typeof t === "object" && !Array.isArray(t) && t.color && typeof t.color === "object" ? t : null;
  } catch { return null; }
};

/** Where the tokens behind a style guide page might live, best guess first. */
function candidates(page: URL, html: string): URL[] {
  const out: string[] = [];
  // An explicit pointer: <link rel="design-tokens" href="…">
  for (const m of html.matchAll(/<link[^>]+rel=["']?design-tokens["']?[^>]*>/gi)) {
    const href = m[0].match(/href=["']([^"']+)["']/i);
    if (href) out.push(new URL(href[1], page).toString());
  }
  // Any link or script that points at a tokens file.
  for (const m of html.matchAll(/(?:href|src)=["']([^"']*tokens[^"']*\.json[^"']*)["']/gi)) out.push(new URL(m[1], page).toString());
  // A path mentioned on the page ("generated from design-system/tokens.json"),
  // tried under each theme the page loads, then from the site root.
  const mentioned = [...new Set([...html.matchAll(/([\w./-]*tokens\.json)/gi)].map((m) => m[1].replace(/^\/+/, "")))].slice(0, 3);
  const themes = [...new Set([...html.matchAll(/\/wp-content\/themes\/([\w.-]+)\//gi)].map((m) => m[1]))].slice(0, 4);
  for (const rel of mentioned.length ? mentioned : ["design-system/tokens.json"]) {
    for (const th of themes) out.push(new URL(`/wp-content/themes/${th}/${rel}`, page).toString());
    out.push(new URL(`/${rel}`, page).toString());
  }
  return [...new Set(out)].map((u) => safeUrl(u)).filter((u): u is URL => !!u && u.host === page.host).slice(0, 10);
}

/** Fetch a design system from a tokens file or a style guide page. */
export async function importFromUrl(raw: string): Promise<{ tokens: any; from: string } | { error: string }> {
  const url = safeUrl(raw);
  if (!url) return { error: "Use a public https address, like https://example.com/design-system/." };
  const first = await get(url);
  if (!first) return { error: "Couldn't open that address. Check it loads in a browser without signing in." };
  const direct = asTokens(first.body);
  if (direct) return { tokens: direct, from: first.url.toString() };
  if (!/html/i.test(first.type) && !/<html|<body/i.test(first.body)) return { error: "That address isn't a design system page or tokens file." };
  for (const c of candidates(first.url, first.body)) {
    const r = await get(c);
    const t = r && asTokens(r.body);
    if (t) return { tokens: t, from: r!.url.toString() };
  }
  return { error: "Found the page, but not the design system file behind it. Paste the address of its tokens.json file instead." };
}
