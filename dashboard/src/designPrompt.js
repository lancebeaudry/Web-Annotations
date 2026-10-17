// The Claude Code prompt that builds a PinPoint design system from a site's
// own source. One source of truth: the dashboard's "Create with Claude Code"
// box renders it with the project filled in, and the README points here.
// Keep the schema in step with supabase/functions/_shared/designEngine.ts.

export function designPrompt({ name = 'this site', site = '', agentUrl = '', mcpUrl = '', agentKey = '' } = {}) {
  const key = agentKey || '<this project’s AI assistant key from PinPoint>';
  const endpoint = agentUrl || '<PinPoint agent endpoint>';
  return `You are building a design system for ${name}${site ? ` (${site})` : ''} for PinPoint, the feedback tool that checks style requests against it. Work from this site's own source in the current folder. Do not change any existing CSS, templates or content; you are only writing one new file and a report.

## Output

Write \`design-system/tokens.json\` inside the active theme (for WordPress, the child theme folder; otherwise the project root). It must be valid JSON in exactly this shape. Keys are lowercase-kebab. Every color reference (bg, text, heading, accent) must be a key that exists in "color". The example below is shortened to show the shape; a real file lists every color it references.

{
  "$schema": "pinpoint-design-tokens/1",
  "name": "${name} Design System",
  "version": "1.0.0",
  "updated": "YYYY-MM-DD",
  "color":    { "primary": { "value": "#109cf1", "label": "Primary blue", "usage": "Buttons, links" } },
  "font":     { "family": { "value": "\\"Figtree\\", Arial, sans-serif", "label": "Figtree" }, "css": "https://fonts.googleapis.com/… (only if the site loads Google Fonts or Adobe Fonts; otherwise omit)" },
  "type":     { "display": { "value": "56px", "label": "Hero headline" } },
  "radius":   { "button": { "value": "8px", "label": "Buttons and fields" } },
  "space": {
    "container": { "value": "1200px", "label": "Content width" },
    "section":   { "value": "clamp(56px, 7vw, 96px)", "label": "Section padding" },
    "md":        { "value": "16px", "label": "MD", "scale": true, "use": "Heading to intro text" }
  },
  "shadow":   { "card": { "value": "0 24px 50px rgba(0,0,0,.12)", "label": "Card" } },
  "surfaces": { "white": { "label": "White", "bg": "white", "text": "body", "heading": "ink", "accent": "primary", "match": ".section--white" } },
  "buttons":  { "primary": { "label": "Primary (blue)", "bg": "primary", "text": "white", "padding": "14px 28px", "font_size": "17px", "font_weight": "700", "match": ".btn--primary" } },
  "variants": { "module-slug": { "setting": ["allowed", "values"] } },
  "anatomy": [
    { "id": "padding", "label": "Section padding, top and bottom", "value": "space.section", "alt": "space.section-compact", "note": "Compact for short sections" },
    { "id": "eyebrow-heading", "label": "Eyebrow to heading", "value": "space.2xs" },
    { "id": "heading-text", "label": "Heading to intro text", "value": "space.md" },
    { "id": "text-text", "label": "Paragraph to paragraph", "value": "space.sm" },
    { "id": "heading-content", "label": "Heading block to cards, lists or columns", "value": "space.2xl" },
    { "id": "items", "label": "Between cards or items", "value": "space.lg" },
    { "id": "card-padding", "label": "Inside a card", "value": "space.xl" },
    { "id": "content-actions", "label": "Content to buttons", "value": "space.xl" },
    { "id": "text-width", "label": "Longest line of text", "value": "720px" }
  ],
  "rules": {
    "hard": [
      { "id": "contrast", "label": "Text contrast", "check": "Text and buttons must meet WCAG AA (4.5:1 body, 3:1 large text).", "applies_to": ["color", "background-color"] },
      { "id": "tracking", "label": "Forms and tracking", "check": "Form fields and tracking can't be changed from the page.", "applies_to": ["form", "tracking"] },
      { "id": "logo", "label": "Logo", "check": "The logo artwork, colors and clear space are fixed.", "applies_to": ["logo"] }
    ],
    "soft": [
      { "id": "palette", "label": "Brand colors", "check": "Colors come from the brand palette.", "applies_to": ["color", "background-color", "border-color"] },
      { "id": "radius", "label": "Corner radius", "check": "Corners use the radius scale.", "applies_to": ["border-radius"] },
      { "id": "spacing", "label": "Spacing", "check": "Spacing inside sections comes from the spacing scale; section padding uses the section sizes.", "applies_to": ["padding", "margin", "gap"] },
      { "id": "anatomy", "label": "Section anatomy", "check": "Space between a section's parts follows the section anatomy.", "applies_to": ["margin", "gap"] },
      { "id": "type", "label": "Type scale", "check": "Text sizes come from the type scale.", "applies_to": ["font-size"] },
      { "id": "variants", "label": "Variants", "check": "Sections use their approved variants.", "applies_to": ["variant"] }
    ]
  }
}

## How to build it

1. Read the sources: CSS custom properties (:root blocks), theme.json, style.css and every stylesheet the theme loads, page-builder module CSS and settings (for Beaver Builder, the custom modules' settings files), and the main page templates. Skip vendor and plugin CSS you did not write.
2. Take stock of what is actually used: count each color, font size, radius, padding, margin and gap value, and where it appears.
3. Colors: start from the defined variables and keep their names as keys (e.g. --ts-blue becomes "blue"). Add a hard-coded color only if it is used often and is clearly part of the brand. Give every color a label and a one-line usage. Leave gradients out of "color"; mention them in the report.
4. Type: one entry per text role (hero headline, section heading, card title, lead, body, small, eyebrow), with the size the CSS really uses, including clamp() values. Fonts: the family stack from the CSS.
5. Buttons: one entry per distinct button style (fill and text color pair), with its padding, font_size and font_weight, and a "match" selector that picks out that style on the page.
6. Surfaces: one entry per section background, with its body text, heading and accent colors and a "match" selector for the section class.
7. Spacing: put layout values in "space" without "scale" (content width, side gutter, section padding, compact section padding). Then pick 6 to 8 scale steps (keys 2xs, xs, sm, md, lg, xl, 2xl, 3xl) from the values the CSS uses most, rounding near-duplicates (for example 11, 12 and 13px become one 12px step), each with "scale": true and a "use". Fill "anatomy" from how the section templates actually space their parts, using "space.<key>" references.
8. Variants: if the site's page-builder modules offer style settings (background, button style, layout), list each module's allowed values.
9. Check every surface and button pair for contrast. If one fails AA, keep it but say so in the report.

## Validate before you finish

- The file parses as JSON.
- Every bg, text, heading and accent reference exists in "color", and every "space.<key>" in anatomy exists in "space".
- Every "match" selector exists in the site's CSS.

## Send it to PinPoint

When the file passes the checks above, send it to PinPoint as a draft. Nothing on the site or in PinPoint changes until the project owner approves it.

- If a \`pinpoint\` MCP server is connected in this Claude Code session, call its \`design_submit_draft\` tool with \`tokens\` set to the whole JSON object and a two or three sentence \`summary\` of what the owner should check.
- Otherwise, send it with this command from the theme folder (the key is a secret: don't write it into any file):

\`\`\`bash
python3 -c "import json,sys; print(json.dumps({'design_draft': json.load(open('design-system/tokens.json')), 'summary': sys.argv[1]}))" "WRITE A SHORT SUMMARY HERE" | curl -s -X POST '${endpoint}' -H 'x-pinpoint-agent-key: ${key}' -H 'Content-Type: application/json' --data-binary @-
\`\`\`

A reply with "ok": true means it's saved as a draft. If the reply lists problems, fix them in the file and send it again.${mcpUrl ? `

(To connect the MCP server instead: \`claude mcp add --transport http pinpoint "${mcpUrl}" --header "x-pinpoint-agent-key: ${key}"\`.)` : ''}

## Report back

In your reply, not in the file:
- A short summary: how many colors, type sizes, button styles, surfaces and spacing steps.
- Drift: colors used in the CSS that aren't in the palette (value, how many times, closest palette color), and spacing or font sizes that aren't on the scales. Show the top 15 of each.
- Decisions a person should make: anything you merged, guessed or left out.
- Whether the draft reached PinPoint, and that the owner can now review it under Design rules in the PinPoint project settings (Preview, then "Use this design system").`;
}
