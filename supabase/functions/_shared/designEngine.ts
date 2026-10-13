// PinPoint design rules — the check engine.
//
// One place that decides whether a requested style change fits a project's
// design system, and what the three choices are when it doesn't. Pure code,
// no I/O, so the same file runs in the `design-rules` edge function, the
// MCP server and the overlay's no-backend test harness.
//
// Tokens shape (pinpoint-design-tokens/1; the WordPress connector's
// tokens.json uses the same shape):
//   name, version, updated
//   color:    { key: { value: "#hex", label, usage } }
//   font:     { family: { value, label }, css?: "https://fonts.googleapis.com/..." }
//   type | radius | space | shadow: { key: { value, label } }
//   surfaces: { key: { label, bg: colorKey, text: colorKey, heading?, accent?, match?: "css selector" } }
//   buttons:  { key: { label, bg: colorKey, text: colorKey, match?: "css selector" } }
//   variants: { module: { setting: [allowed values] } }
//   space entries may carry scale: true (a spacing-scale step, e.g. 4/8/12/16…)
//   and use: "what it's for"; entries without it are layout values (content
//   width, gutter, section padding).
//   anatomy:  [{ id, label, value: "space.md" | "760px", alt?, note? }]  — the
//             spacing between the parts of a section, in reading order
//   rules:    { hard: [{ id, label, check, applies_to }], soft: [...] }
//   locked?:  [element names that can't be changed from the page]  (default logo, form, tracking)

export type Tokens = Record<string, any>;
export type Request = {
  element?: string;          // button | heading | display | text | section | logo | form | ...
  property?: string;         // background-color | color | border-color | border-radius | padding | margin | font-size | variant
  value?: string;
  context?: {
    surface?: string;        // surface key the element sits on (if the site marks it)
    button?: string;         // button style key the element uses (if the site marks it)
    background?: string;     // effective background color measured in the browser
    text?: string;           // text color measured in the browser
    current?: string;        // the current value of the property, for undo
  };
  target?: { page_id?: number; node_id?: string; module?: string; setting?: string; selector?: string; page_path?: string };
  viewport_w?: number;
};
export type Option = Record<string, any>;
export type Result = {
  status: "allowed" | "needs_decision" | "blocked";
  rule: { id: string; type: "hard" | "soft"; label: string; check: string };
  message: string;
  target: Record<string, any>;
  tokens_version: string;
  contrast?: { ratio: number | null; min: number | null; against: string | null };
  token?: string;
  apply?: Record<string, any>;
  options?: Option[];
  device_note?: string;
  info?: boolean;            // guidance only (nothing was asked that breaks a rule)
};

const COLOR_PROPS = ["color", "background-color", "border-color", "background"];
const DEFAULT_LOCKED = ["logo", "form", "tracking"];
const PATH_RE = /^(color|type|radius|space|shadow|surfaces|buttons|variants|font)\.[a-z0-9_\-.]+$/;
const key = (v: string) => String(v || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48);

// ---------------------------------------------------------------- colors
export function normalizeHex(v: string): string {
  const s = String(v || "").trim().toLowerCase();
  let m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
    return "#" + h;
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return "#" + [m[1], m[2], m[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, "0")).join("");
  return "";
}
function rgb(hex: string): number[] | null {
  const h = normalizeHex(hex);
  if (!h) return null;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(c: number[]): number {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number | null {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return null;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}
function distance(a: string, b: string): number {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return Infinity;
  const rm = (x[0] + y[0]) / 2, dr = x[0] - y[0], dg = x[1] - y[1], db = x[2] - y[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
/** Hex for a palette key, or the value itself when it is already a color. */
export function colorOf(key: string | undefined, t: Tokens): string {
  if (!key) return "";
  const c = t.color?.[key];
  return c ? normalizeHex(c.value) : normalizeHex(key);
}
function paletteKeyFor(hex: string, t: Tokens): string | null {
  for (const [k, c] of Object.entries<any>(t.color || {})) if (normalizeHex(c.value) === hex) return k;
  return null;
}

// ------------------------------------------------------------ helpers
function ruleInfo(t: Tokens, id: string) {
  const all = [...(t.rules?.hard || []), ...(t.rules?.soft || [])];
  return all.find((r: any) => r.id === id) || null;
}
function result(t: Tokens, status: Result["status"], ruleId: string, type: "hard" | "soft", message: string, target: Record<string, any>, extra: Partial<Result> = {}): Result {
  const r = ruleInfo(t, ruleId);
  return {
    status,
    rule: { id: ruleId, type, label: r?.label || defaultLabel(ruleId), check: r?.check || "" },
    message,
    target,
    tokens_version: String(t.version || "1.0.0"),
    ...extra,
  };
}
function defaultLabel(id: string) {
  return ({ contrast: "Text contrast", palette: "Brand colors", radius: "Corner radius", spacing: "Spacing", type: "Type scale", variants: "Variants", buttons: "Button styles", anatomy: "Section anatomy", logo: "Logo", tracking: "Forms and tracking", manual: "Needs review" } as Record<string, string>)[id] || id;
}
function slug(v: string) { return String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "custom"; }
function label(group: Record<string, any> | undefined, key: string) { return group?.[key]?.label || key; }

/** The background/text pair a color change creates, so contrast can be tested. */
function contrastPair(t: Tokens, req: Request, hex: string) {
  const el = req.element || "text", prop = req.property || "";
  const ctx = req.context || {};
  const surface = t.surfaces?.[ctx.surface || ""] || null;
  const button = t.buttons?.[ctx.button || ""] || null;
  const measuredBg = normalizeHex(ctx.background || ""), measuredText = normalizeHex(ctx.text || "");
  if (prop === "border-color") return null;
  if (el === "button") {
    if (prop === "background-color" || prop === "background") {
      const against = button ? colorOf(button.text, t) : measuredText || "#ffffff";
      return { against, min: 4.5 };
    }
    const against = button ? colorOf(button.bg, t) : measuredBg || "#ffffff";
    return { against, min: 4.5 };
  }
  if (prop === "background-color" || prop === "background") {
    const against = surface ? colorOf(surface.text, t) : measuredText;
    return against ? { against, min: 4.5 } : null;
  }
  const against = surface ? colorOf(surface.bg, t) : measuredBg || "#ffffff";
  const min = ["heading", "display"].includes(el) ? 3.0 : 4.5;
  return { against, min };
}
function closestColor(hex: string, t: Tokens, pair: { against: string; min: number } | null, req: Request): string | null {
  let keys = Object.keys(t.color || {});
  const prop = req.property || "";
  if (req.element === "button" && (prop === "background-color" || prop === "background") && t.buttons) {
    keys = [...new Set(Object.values<any>(t.buttons).map((b) => b.bg))].filter((k) => t.color?.[k]);
  } else if ((prop === "background-color" || prop === "background") && t.surfaces) {
    keys = [...new Set(Object.values<any>(t.surfaces).map((s) => s.bg))].filter((k) => t.color?.[k]);
  }
  // Suggesting the color the element already has isn't a choice, so skip
  // it unless it's the only approved color that fits.
  const cur = normalizeHex(req.context?.current || "");
  let best: string | null = null, bd = Infinity, same: string | null = null;
  for (const k of keys) {
    const v = colorOf(k, t);
    if (pair) { const r = contrast(v, pair.against); if (r !== null && r < pair.min) continue; }
    if (cur && normalizeHex(v) === cur) { same = same || k; continue; }
    const d = distance(hex, v);
    if (d < bd) { bd = d; best = k; }
  }
  return best || same;
}
/** How an approved color maps onto a button/surface style, when the site has them. */
function applyForColor(key: string, req: Request, t: Tokens) {
  const isButton = req.element === "button";
  const map = isButton ? t.buttons : t.surfaces;
  const field = isButton ? "bg" : ((req.property === "background-color" || req.property === "background") ? "bg" : "text");
  for (const [k, v] of Object.entries<any>(map || {})) {
    if (v?.[field] === key) return { type: "set_variant", kind: isButton ? "button" : "surface", value: k, label: v.label || k };
  }
  return { type: "set_style", property: req.property, value: colorOf(key, t) };
}
function optClosestColor(key: string, requested: string, req: Request, t: Tokens): Option {
  return {
    id: "closest",
    label: "Use the closest approved style",
    summary: `Use ${colorOf(key, t)} (${label(t.color, key)}) instead of ${requested}.`,
    token: `color.${key}`,
    value: colorOf(key, t),
    action: applyForColor(key, req, t),
  };
}
function optException(target: Record<string, any>, property: string, value: string): Option {
  return {
    id: "exception",
    label: "Make a one-off exception",
    summary: "Apply it to this element only. It's logged and listed on the design system page, and nothing else changes.",
    request: { page_id: target.page_id || 0, page_path: target.page_path || "", selector: target.selector || "", property, value },
  };
}
function optRuleChangeColor(hex: string, req: Request, t: Tokens): Option {
  const key = "custom-" + hex.slice(1, 7);
  const scopes: Option[] = [];
  const isButtonFill = req.element === "button" && (req.property === "background-color" || req.property === "background") && t.buttons;
  if (isButtonFill) {
    const textKey = (contrast(hex, "#ffffff") || 0) >= 4.5 ? (paletteKeyFor("#ffffff", t) || "#ffffff") : (Object.keys(t.color || {}).find((k) => (contrast(colorOf(k, t), hex) || 0) >= 4.5) || "#000000");
    // The style this button already uses; the first button style otherwise.
    const cur = req.context?.button && t.buttons[req.context.button] ? req.context.button : "";
    const primary = cur || Object.keys(t.buttons)[0];
    scopes.push({
      id: "add",
      label: `Add ${hex} as a new approved button style`,
      impact: "Only buttons someone switches to the new style change.",
      changes: [
        { path: `color.${key}`, value: { value: hex, label: `Custom ${hex}`, usage: "Added by rule change" } },
        { path: `buttons.${key}`, value: { label: `Custom ${hex}`, bg: key, text: textKey } },
      ],
      then: { type: "set_variant", kind: "button", value: key },
    });
    if (primary) scopes.push({
      id: "replace",
      label: `Change every ${label(t.buttons, primary)} button to ${hex}`,
      impact: `Every ${label(t.buttons, primary)} button on the site changes.`,
      changes: [
        { path: `color.${key}`, value: { value: hex, label: `Custom ${hex}`, usage: `${label(t.buttons, primary)} buttons` } },
        { path: `buttons.${primary}.bg`, value: key },
        { path: `buttons.${primary}.text`, value: textKey },
      ],
    });
  } else {
    scopes.push({
      id: "add",
      label: `Add ${hex} to the brand palette`,
      impact: "It becomes available everywhere, but nothing changes until it's used.",
      changes: [{ path: `color.${key}`, value: { value: hex, label: `Custom ${hex}`, usage: "Added by rule change" } }],
    });
  }
  return { id: "rule_change", label: "Change the rule", summary: "Update the design system, preview every affected page, then approve.", scopes };
}
const SPACE_PROPS = ["padding", "margin", "gap"];
/** The spacing-scale steps (space entries marked scale: true). */
export function spacingScale(t: Tokens): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries<any>(t.space || {})) if (v && v.scale) out[k] = v;
  return out;
}
function scaleFor(property: string, t: Tokens, element = ""): [string | null, Record<string, any>] {
  if (property === "border-radius") return ["radius", t.radius || {}];
  if (SPACE_PROPS.includes(property)) {
    const steps = spacingScale(t);
    // Section padding is a layout value; everything else uses the scale
    // when the design system has one.
    if (Object.keys(steps).length && !(element === "section" && property === "padding")) return ["space", steps];
    return ["space", t.space || {}];
  }
  if (property === "font-size") return ["type", t.type || {}];
  return [null, {}];
}
/** Section anatomy parts with their values resolved ("space.md" -> 24px). */
export function anatomyParts(t: Tokens): { id: string; label: string; ref: string; value: string; alt: string; note: string }[] {
  const resolve = (v: any) => {
    const m = String(v ?? "").match(/^space\.([A-Za-z0-9_-]+)$/);
    return m ? String(t.space?.[m[1]]?.value ?? v) : String(v ?? "");
  };
  return (Array.isArray(t.anatomy) ? t.anatomy : []).filter((p: any) => p && p.label && p.value).map((p: any) => ({
    id: String(p.id || ""), label: String(p.label), ref: String(p.value), value: resolve(p.value), alt: p.alt ? resolve(p.alt) : "", note: String(p.note || ""),
  }));
}
function closestScale(value: string, scale: Record<string, any>): string | null {
  const n = parseFloat(value);
  if (!n) return null;
  let best: string | null = null, bd = Infinity;
  for (const [k, tok] of Object.entries<any>(scale)) {
    const m = String(tok.value).trim().match(/^([\d.]+)px$/);
    if (!m) continue;
    const d = Math.abs(+m[1] - n);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
function deviceNote(req: Request): string | undefined {
  const w = Number(req.viewport_w || 0);
  if (w && w < 1024) return `You asked from a ${w < 600 ? "phone" : "tablet"}-width screen. Design rules apply at every screen size.`;
  return undefined;
}

// ------------------------------------------------- button style props
const BUTTON_STYLE_PROPS = ["padding", "font-size", "height", "min-height"];
const styleField = (p: string) => (p === "font-size" ? "font_size" : p === "padding" ? "padding" : "height");
const propWord = (p: string) => (p === "font-size" ? "text size" : p === "padding" ? "padding" : "height");
function buttonKey(t: Tokens, req: Request): string | null {
  const k = req.context?.button;
  if (k && t.buttons?.[k]) return k;
  return null;
}
function buttonStyleMessage(t: Tokens, bk: string | null, property: string): string {
  const set = bk ? t.buttons?.[bk]?.[styleField(property)] : null;
  const which = bk ? `the ${label(t.buttons, bk)} button style${set ? ` (${set})` : ""}` : "the button styles";
  return `Button ${propWord(property)} is set by ${which}, so every button matches. Changing this one button would be a one-off exception; changing all of them is a rule change.`;
}

// ------------------------------------------------------------------ check
export function check(t: Tokens, req: Request): Result {
  const element = String(req.element || "text").toLowerCase();
  const property = String(req.property || "").toLowerCase();
  const value = String(req.value || "").trim();
  const target = { ...(req.target || {}) };
  const note = deviceNote(req);
  const withNote = (r: Result) => (note ? { ...r, device_note: note } : r);

  // Locked elements (hard).
  const locked: string[] = Array.isArray(t.locked) ? t.locked : DEFAULT_LOCKED;
  if (locked.includes(element) || ["form", "tracking"].includes(property)) {
    const rid = element === "logo" ? "logo" : "tracking";
    const r = ruleInfo(t, rid);
    return withNote(result(t, "blocked", rid, "hard", r?.check || (rid === "logo" ? "The logo is fixed. It can only change by updating the brand standards." : "Forms and tracking are locked so leads and conversion tracking keep working. The team can make this change for you."), target, { options: [] }));
  }

  // Section/module variant.
  if (property === "variant") {
    const allowed: string[] = t.variants?.[target.module || ""]?.[target.setting || ""] || [];
    if (allowed.includes(value)) {
      return withNote(result(t, "allowed", "variants", "soft", "That variant is approved for this section. It can be applied right away.", target, { apply: { type: "set_setting", setting: target.setting, value } }));
    }
    return withNote(result(t, "needs_decision", "variants", "soft", allowed.length ? "That isn't one of the approved variants for this section." : "This section has no approved variants listed yet.", target, {
      options: [
        ...(allowed.length ? [{ id: "closest", label: "Use an approved variant", summary: `Approved for this section: ${allowed.join(", ")}`, choices: allowed, action: { type: "set_setting", setting: target.setting } }] : []),
        optException(target, "variant", value),
        { id: "rule_change", label: "Change the rule", summary: `Allow "${value}" on this section type.`, scopes: [{
          id: "add", label: `Approve "${value}" for every ${target.module || "matching"} section`, impact: "Every section of this type can use it.",
          changes: [{ path: `variants.${key(target.module || "section")}.${key(target.setting || "style")}`, value: [...new Set([...allowed, value])] }],
        }] },
      ],
    }));
  }

  // Colors.
  if (COLOR_PROPS.includes(property)) {
    const hex = normalizeHex(value);
    if (!hex) return withNote(result(t, "blocked", "palette", "soft", "Couldn't read that color. Use a hex value such as #1a7f37.", target, { options: [] }));
    const pair = contrastPair(t, { ...req, element, property }, hex);
    const ratio = pair ? contrast(hex, pair.against) : null;
    const contrastInfo = { ratio, min: pair?.min ?? null, against: pair?.against ?? null };
    if (pair && ratio !== null && ratio < pair.min) {
      const ck = closestColor(hex, t, pair, { ...req, element, property });
      return withNote(result(t, "blocked", "contrast", "hard", `${hex} against ${pair.against} is ${ratio}:1. Text needs at least ${pair.min}:1 to be readable, so this can't be approved.`, target, {
        contrast: contrastInfo,
        options: ck ? [optClosestColor(ck, hex, { ...req, element, property }, t)] : [],
      }));
    }
    const key = paletteKeyFor(hex, t);
    if (key) {
      return withNote(result(t, "allowed", "palette", "soft", `${hex} is the approved "${label(t.color, key)}" color.`, target, {
        contrast: contrastInfo, token: `color.${key}`, apply: applyForColor(key, { ...req, element, property }, t),
      }));
    }
    const ck = closestColor(hex, t, pair, { ...req, element, property });
    const brand = t.name ? ` ${String(t.name).replace(/\s*design system\s*$/i, "")}` : "";
    return withNote(result(t, "needs_decision", "palette", "soft", `${hex} isn't in the${brand} brand palette.`, target, {
      contrast: contrastInfo,
      options: [
        ...(ck ? [optClosestColor(ck, hex, { ...req, element, property }, t)] : []),
        optException(target, property, hex),
        optRuleChangeColor(hex, { ...req, element, property }, t),
      ],
    }));
  }

  // Button padding and text size belong to the button style, so every
  // button of a style matches. Changing one is an exception; changing all
  // of them is a rule change.
  if (element === "button" && BUTTON_STYLE_PROPS.includes(property) && t.buttons && Object.keys(t.buttons).length) {
    const bk = buttonKey(t, req);
    const set = bk ? t.buttons[bk]?.[styleField(property)] : null;
    if (set && value && String(set).trim() === value) {
      return withNote(result(t, "allowed", "buttons", "soft", `${value} is the ${label(t.buttons, bk!)} button's ${propWord(property)}.`, target, { apply: { type: "set_style", property, value } }));
    }
    return withNote(result(t, "needs_decision", "buttons", "soft", buttonStyleMessage(t, bk, property), target, {
      options: [
        { id: "closest", label: "Keep the approved button style", summary: `Keep the standard ${bk ? label(t.buttons, bk) + " " : ""}button ${propWord(property)}.`, value: set || req.context?.current || "", action: { type: "set_style", property, value: set || req.context?.current || "" } },
        optException(target, property, value),
        ...(value && bk ? [{ id: "rule_change", label: "Change the rule", summary: `Change the ${propWord(property)} on every ${label(t.buttons, bk)} button.`, scopes: [{
          id: "replace", label: `Set the ${propWord(property)} of every ${label(t.buttons, bk)} button to ${value}`, impact: `Every ${label(t.buttons, bk)} button on the site changes.`,
          changes: [{ path: `buttons.${bk}.${styleField(property)}`, value }],
        }] }] : []),
      ],
    }));
  }

  // Scales.
  const [group, scale] = scaleFor(property, t, element);
  if (group) {
    const rid = group === "radius" ? "radius" : group === "type" ? "type" : "spacing";
    for (const [k, tok] of Object.entries<any>(scale)) {
      if (String(tok.value).trim() === value) return withNote(result(t, "allowed", rid, "soft", `${value} matches the "${tok.label || k}" step.`, target, { token: `${group}.${k}`, apply: { type: "set_style", property, value } }));
    }
    const ck = closestScale(value, scale);
    return withNote(result(t, "needs_decision", rid, "soft", `${value} isn't on the ${group === "space" ? "spacing" : group} scale.`, target, {
      options: [
        ...(ck ? [{ id: "closest", label: "Use the closest approved style", summary: `Use ${scale[ck].value} (${scale[ck].label || ck}) instead.`, token: `${group}.${ck}`, value: scale[ck].value, action: { type: "set_style", property, value: scale[ck].value } }] : []),
        optException(target, property, value),
        { id: "rule_change", label: "Change the rule", summary: `Add ${value} to the ${group} scale.`, scopes: [{
          id: "add", label: `Add ${value} as a new ${group === "space" ? "spacing" : group} step`, impact: "It becomes available everywhere, but nothing changes until it's used.",
          changes: [{ path: `${group}.custom-${slug(value)}`, value: { value, label: `Custom ${value}`, ...(group === "space" && Object.keys(spacingScale(t)).length ? { scale: true } : {}) } }],
        }] },
      ],
    }));
  }

  return withNote(result(t, "needs_decision", "manual", "soft", "This kind of change isn't covered by an automatic rule. The team will review it.", target, {
    options: [optException(target, property || "other", value)],
  }));
}

// ---------------------------------------------------------------- hint
/** Size of a scale value in px at a screen width: plain px/rem values, or
 *  clamp(min, Nvw, max) resolved at that width (the max when unknown). */
function pxOf(v: any, vw = 0): number {
  const str = String(v ?? "").trim();
  const one = (x: string) => {
    const m = x.trim().match(/^([\d.]+)\s*(px|rem|em|vw)?$/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    return m[2] === "rem" || m[2] === "em" ? n * 16 : m[2] === "vw" ? (vw ? (n * vw) / 100 : NaN) : n;
  };
  const c = str.match(/^clamp\(([^,]+),([^,]+),([^)]+)\)$/i);
  if (c) {
    const lo = one(c[1]), mid = one(c[2]), hi = one(c[3]);
    if (!Number.isNaN(lo) && !Number.isNaN(hi)) return Number.isNaN(mid) ? hi : Math.min(Math.max(lo, mid), hi);
  }
  const n = one(str);
  if (!Number.isNaN(n)) return n;
  const m = str.match(/([\d.]+)\s*px/);
  return m ? parseFloat(m[1]) : 0;
}
/**
 * A quick answer for a request written in words, such as "less padding on
 * this button", where there may be no exact value. With a value it's the
 * same as check(). Without one it says whether the design system allows
 * moving that way, and names the approved step to use if there is one.
 * Returns null when there's nothing to say.
 */
export function hint(t: Tokens, req: Request, direction: "less" | "more" | "" = ""): Result | null {
  if (!t || !t.color) return null;
  if (req.value) return check(t, req);
  const element = String(req.element || "text").toLowerCase();
  const property = String(req.property || "").toLowerCase();
  const target = { ...(req.target || {}) };
  const locked: string[] = Array.isArray(t.locked) ? t.locked : DEFAULT_LOCKED;
  if (locked.includes(element)) return check(t, { ...req, value: "x" });
  if (element === "button" && BUTTON_STYLE_PROPS.includes(property) && t.buttons && Object.keys(t.buttons).length) {
    return check(t, { ...req, value: "" });
  }
  if (COLOR_PROPS.includes(property)) {
    const names = Object.entries<any>(t.color || {}).map(([k, c]) => c?.label || k);
    const brand = t.name ? String(t.name).replace(/\s*design system\s*$/i, "") : "the brand";
    const pick = element === "button" && t.buttons ? ` Buttons come in ${Object.keys(t.buttons).length} approved styles: ${Object.entries<any>(t.buttons).map(([k, b]) => b?.label || k).join(", ")}.` : "";
    return result(t, "needs_decision", "palette", "soft", `Colors come from the ${brand} palette (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}).${pick} Anything else would be an exception.`, target, { options: [] });
  }
  const [group, scale] = scaleFor(property, t, element);
  if (!group || !Object.keys(scale).length) return null;
  // Space between the parts of a section: answer with the section anatomy.
  const parts = anatomyParts(t);
  const vw0 = Number(req.viewport_w) || 0;
  if ((property === "margin" || property === "gap") && parts.length && (!direction || !pxOf(req.context?.current, vw0))) {
    const list = parts.filter((p) => /px|rem|clamp/.test(p.value)).slice(0, 6).map((p) => `${p.label} ${p.value}`).join(", ");
    const lead = direction && !pxOf(req.context?.current, vw0) ? "This element has no space of its own there; it comes from the section around it. " : "";
    return result(t, "needs_decision", "anatomy", "soft", `${lead}Space between the parts of a section follows the section anatomy: ${list}.`, target, { options: [], info: true });
  }
  const rid = group === "radius" ? "radius" : group === "type" ? "type" : (property === "margin" || property === "gap") && parts.length ? "anatomy" : "spacing";
  const word = group === "space" ? "spacing" : group === "type" ? "type" : "corner radius";
  const vw = Number(req.viewport_w) || 0;
  const cur = pxOf(req.context?.current, vw);
  const steps = Object.entries<any>(scale).map(([k, v]) => ({ k, label: v?.label || k, value: String(v?.value ?? v), px: pxOf(v?.value ?? v, vw) })).filter((x) => x.px).sort((a, b) => a.px - b.px);
  // Padding: when the scale names padding steps, only those count (not gaps
  // or content widths).
  if (property === "padding") {
    const pad = steps.filter((x) => /padding/i.test(`${x.k} ${x.label}`));
    if (pad.length) steps.splice(0, steps.length, ...pad);
  }
  // Within a few pixels counts as the step it's already on.
  const tol = Math.max(1, cur * 0.06);
  if (!cur || !direction) {
    return result(t, "needs_decision", rid, "soft", `This has to use a step on the ${word} scale: ${steps.map((x) => `${x.label} ${x.value}`).join(", ")}.`, target, { options: [], info: true });
  }
  const next = direction === "less" ? [...steps].reverse().find((x) => x.px < cur - tol) : steps.find((x) => x.px > cur + tol);
  if (next) {
    return result(t, "allowed", rid, "soft", `The approved ${direction === "less" ? "smaller" : "larger"} step is ${next.label} (${next.value}).`, target, { token: `${group}.${next.k}`, value: next.value, apply: { type: "set_style", property, value: next.value } } as any);
  }
  return result(t, "needs_decision", rid, "soft", `This is already the ${direction === "less" ? "smallest" : "largest"} step on the ${word} scale. Going ${direction === "less" ? "smaller" : "larger"} would be a one-off exception or a rule change.`, target, { options: [] });
}

// ------------------------------------------------------- rule changes
export function cleanChanges(changes: any[]): { path: string; value: any }[] {
  const clean = (v: any): any => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") { const o: any = {}; for (const [k, x] of Object.entries(v)) { const kk = String(k).replace(/[^A-Za-z0-9_-]/g, ""); if (kk) o[kk] = clean(x); } return o; }
    return String(v ?? "").replace(/[{};<>]/g, "").slice(0, 200);
  };
  return (changes || []).filter((c) => c && PATH_RE.test(String(c.path || ""))).map((c) => ({ path: String(c.path), value: clean(c.value) }));
}
export function applyChanges(tokens: Tokens, changes: { path: string; value: any }[]): Tokens {
  const out = JSON.parse(JSON.stringify(tokens || {}));
  for (const c of changes) {
    const parts = c.path.split(".");
    let ref = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!ref[parts[i]] || typeof ref[parts[i]] !== "object") ref[parts[i]] = {};
      ref = ref[parts[i]];
    }
    ref[parts[parts.length - 1]] = c.value;
  }
  return out;
}
/** A rule change still has to pass the hard rules. Returns a reason or null. */
export function hardRuleProblem(tokens: Tokens): string | null {
  for (const [k, b] of Object.entries<any>(tokens.buttons || {})) {
    const r = contrast(colorOf(b.bg, tokens), colorOf(b.text, tokens));
    if (r !== null && r < 4.5) return `Button style "${b.label || k}" would fail contrast (${r}:1).`;
  }
  for (const [k, s] of Object.entries<any>(tokens.surfaces || {})) {
    const r = contrast(colorOf(s.bg, tokens), colorOf(s.text, tokens));
    if (r !== null && r < 4.5) return `Surface "${s.label || k}" would fail contrast (${r}:1).`;
  }
  return null;
}
/** a > b for x.y.z versions (missing parts count as 0). */
export function semverGt(a: string, b: string): boolean {
  const A = String(a || "").split(".").map((n) => parseInt(n, 10) || 0), B = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0);
  return false;
}
export function bumpVersion(v: string): string {
  const p = String(v || "1.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  p[1] += 1; p[2] = 0;
  return p.slice(0, 3).join(".");
}

// --------------------------------------------------------- task wording
/** What a developer (or AI assistant) has to do on a site with no connector. */
export function taskSpec(req: Request, choice: string, opt: Option | null, t: Tokens): string {
  const where = [req.target?.selector ? `\`${req.target.selector}\`` : `the ${req.element || "element"}`, req.target?.page_path ? `on ${req.target.page_path}` : ""].filter(Boolean).join(" ");
  const prop = req.property || "style";
  if (choice === "closest" && opt) {
    if (opt.action?.type === "set_variant") return `Switch ${where} to the "${opt.action.label || opt.action.value}" ${opt.action.kind} style (${opt.value || ""}).`.replace(" ()", "");
    if (opt.action?.type === "set_setting") return `Set ${where} ${opt.action.setting || "variant"} to "${opt.action.value}".`;
    return `Set ${prop} on ${where} to ${opt.value} (${opt.token || "approved"}), not ${req.value}.`;
  }
  if (choice === "apply") return `Set ${prop} on ${where} to ${req.value}. It's already approved by the design system.`;
  if (choice === "exception") return `One-off exception: set ${prop} on ${where} to ${req.value}. Only this element; don't change the design system.`;
  if (choice === "rule_change" && opt) return `Design system updated (${opt.label}). Apply it on the site${opt.then ? `, then switch ${where} to the new "${opt.then.value}" style` : ""}.`;
  return `Review the requested change: ${prop} on ${where} to ${req.value}.`;
}
