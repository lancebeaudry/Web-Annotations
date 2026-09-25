// All overlay styles live inside the shadow root — fully isolated
// from client-site CSS in both directions.
//
// Avalanche palette:
//   Alpine Sky #1B6493 · Midnight Summit #00263D · Permafrost #3A3A3A
//   Glacial Ice #9BE3FF · Arctic Haze #F9F9F9 · Lake Teal #13A89E

export const CSS = `
:host { all: initial; }

* { box-sizing: border-box; margin: 0; padding: 0; }

.layer {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 0;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: #3A3A3A;
}

.layer button { font: inherit; cursor: pointer; }
.layer input, .layer textarea { font: inherit; }

/* ---- docked bottom bar (full width; the page is padded up by its
   height in app.js so it never sits on top of the site) ---- */
.toolbar {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  height: 52px;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0 16px;
  pointer-events: auto;
  z-index: 30;
  background: #fff;
  border-top: 1px solid #dbe3e8;
  box-shadow: 0 -3px 18px rgba(0, 38, 61, 0.12);
  overflow-x: auto;          /* never cut buttons off — scroll if truly tight */
  overflow-y: hidden;
}
/* Keep items from squishing/wrapping; they scroll instead. */
.toolbar > * { flex: none; }
.toolbar-spacer { flex: 1 1 auto; min-width: 0; }
.toolbar-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
  font-size: 13px;
  color: #00263D;
  margin-right: 6px;
  white-space: nowrap;
  text-decoration: none;
  padding: 4px 6px;
  border-radius: 6px;
}
.toolbar-brand img { width: 16px; height: 16px; flex: none; }
.toolbar-brand:hover { background: #eef2f4; color: #1B6493; }
.toolbar-brand:focus-visible { outline: 2px solid #1B6493; outline-offset: 2px; }
.readonly-strip {
  font-size: 12px;
  font-weight: 600;
  color: #8a5a00;
  background: #fff4dc;
  border: 1px solid #f1dfb0;
  border-radius: 6px;
  padding: 4px 8px;
  white-space: nowrap;
}
.toolbar-hint {
  font-size: 12px;
  color: #6b7a85;
  margin-left: 4px;
  white-space: nowrap;
}
.toolbar-hint kbd {
  font-family: inherit;
  font-weight: 700;
  color: #00263D;
  background: #eef2f4;
  border-radius: 4px;
  padding: 1px 5px;
}
.toolbar-who {
  font-size: 12px;
  font-weight: 600;
  color: #6b7a85;
  white-space: nowrap;
  margin-left: 4px;
}
/* Narrow widths (e.g. inside the tablet/mobile preview frame): drop the
   shortcut hint and the brand TEXT so the action buttons all fit — the
   brand mark itself stays visible and clickable. */
@media (max-width: 860px) {
  .toolbar { gap: 6px; padding: 0 10px; }
  .toolbar-hint { display: none; }
  .toolbar-brand .brand-text { display: none; }
  .toolbar-brand { margin-right: 0; padding: 4px; }
}
/* Phones: Comment/Browse become icon-only so the row fits. */
@media (max-width: 560px) {
  .toolbar .fab-label { display: none; }
}

/* ---- device-preview toggle + stage ---- */
.device-toggle {
  display: inline-flex;
  gap: 2px;
  background: #eef2f4;
  border-radius: 8px;
  padding: 3px;
  margin-left: 2px;
}
.device-toggle .dev-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px; height: 28px;
  border: none;
  background: transparent;
  color: #6b7a85;
  border-radius: 6px;
}
.device-toggle .dev-btn svg { width: 16px; height: 16px; }
.device-toggle .dev-btn:hover { color: #1B6493; }
.device-toggle .dev-btn.active {
  background: #fff;
  color: #1B6493;
  box-shadow: 0 1px 3px rgba(0, 38, 61, 0.18);
}
.device-stage {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 48;
  background: #e9edf1;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: auto;
}
.device-bar {
  flex: none;
  margin-top: 12px;
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 3px 14px rgba(0, 38, 61, 0.18);
}
.device-label { font-size: 12px; color: #6b7a85; text-transform: capitalize; }
.device-frame {
  flex: 1 1 auto;
  min-height: 0;
  width: 390px;
  max-width: 100%;
  border: none;
  background: #fff;
  box-shadow: 0 8px 34px rgba(0, 38, 61, 0.28);
  border-radius: 14px 14px 0 0;
}
.fab {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #1B6493;
  color: #fff;
  border: 1.5px solid #1B6493;
  border-radius: 8px;
  padding: 8px 14px;
  font-weight: 600;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.fab:hover { background: #14517a; border-color: #14517a; }
@keyframes markup-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(27, 100, 147, 0.5); }
  50% { box-shadow: 0 0 0 7px rgba(27, 100, 147, 0); }
}
.fab.active {
  background: #9BE3FF;
  color: #00263D;
  border-color: #1B6493;
  animation: markup-pulse 1.6s ease-out infinite;
}
.fab svg { width: 16px; height: 16px; flex: none; }
.fab-secondary {
  background: #fff;
  color: #1B6493;
  border: 1.5px solid #c9d6de;
}
.fab-secondary:hover { background: #F9F9F9; color: #14517a; border-color: #9fb3c0; }

/* ---- element hover highlight (comment mode) ---- */
.highlight {
  position: absolute;
  pointer-events: none;
  border: 2px dashed #1B6493;
  background: rgba(27, 100, 147, 0.08);
  border-radius: 3px;
  z-index: 10;
  display: none;
}

/* ---- pins ---- */
.pin {
  position: absolute;
  width: 26px; height: 26px;
  margin: -13px 0 0 -13px;
  border-radius: 50% 50% 50% 4px;
  background: #1B6493;
  color: #fff;
  border: 2px solid #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 38, 61, 0.4);
  z-index: 20;
  transition: transform 0.1s;
}
.pin:hover { transform: scale(1.15); }
.pin.weak { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #f0a020; opacity: .85; }
.pin.resolved { background: #13A89E; opacity: 0.55; }
.pin.st-in_progress { background: #E8A317; }
.pin.st-wont_fix { background: #7A8A96; opacity: 0.5; }
.pin.st-waiting { background: #7E57C2; }
/* device badge: a small rounded tag at the pin's corner for tablet/mobile pins */
.pin.dev-mobile::after, .pin.dev-tablet::after {
  content: ''; position: absolute; right: -5px; bottom: -5px; width: 12px; height: 12px; border-radius: 3px;
  background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M8 2h8v20H8zM11 18h2' fill='none' stroke='%2300263D' stroke-width='2.4'/%3E%3C/svg%3E") center/9px no-repeat;
  box-shadow: 0 0 0 1.5px #00263D;
}
.pin.dev-tablet::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 3h14v18H5zM11 18h2' fill='none' stroke='%2300263D' stroke-width='2.4'/%3E%3C/svg%3E"); }
.triage { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0 0 10px; }
.triage-lbl { font-size: 11px; color: #6b7a85; margin-left: 4px; }
.status-select, .assignee-select {
  font: inherit; font-size: 11.5px; font-weight: 600; padding: 3px 22px 3px 9px; border: 1px solid #dbe3e8; border-radius: 999px;
  background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7a85' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 8px center;
  color: #00263D; appearance: none; -webkit-appearance: none; max-width: 150px; text-overflow: ellipsis; cursor: pointer;
}
.status-select.st-open { color: #1B6493; border-color: #bcd3e3; background-color: #eef5fa; }
.status-select.st-in_progress { color: #8a5a00; border-color: #efd9a8; background-color: #fff6e3; }
.status-select.st-resolved { color: #0f6b4f; border-color: #bfe7d2; background-color: #e6f6ee; }
.status-select.st-wont_fix { color: #5c6b76; border-color: #d5dde3; background-color: #f1f4f6; }
.status-select.st-waiting { color: #5b3d99; border-color: #d9cdf0; background-color: #f2edfa; }
.effort-select { max-width: 90px; }
.label-row { display: flex; flex-wrap: wrap; gap: 4px; margin: -4px 0 10px; }
.label-chip { font: inherit; font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 999px; border: 1px solid #dbe3e8; background: #fff; color: #6b7a85; cursor: pointer; }
.label-chip:hover { border-color: #1B6493; color: #1B6493; }
.label-chip.on { color: #fff; border-color: transparent; }
.label-chip.on.lb-bug { background: #B3392B; }
.label-chip.on.lb-copy { background: #1B6493; }
.label-chip.on.lb-design { background: #13A89E; }
.label-chip.on.lb-content { background: #E8A317; }
.label-chip.on.lb-photo { background: #E8A317; }
.label-chip.on.lb-decision { background: #7E57C2; }
.reply-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.reply-row .attach { margin: 0; flex: 1; }
.foot-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; padding-top: 10px; border-top: 1px solid #eef2f4; }
.foot-spacer { flex: 1; }
.btn-sm { padding: 5px 10px; font-size: 12px; }
.btn-link { background: transparent; border: none; padding: 5px 2px; font: inherit; font-size: 12px; font-weight: 600; color: #6b7a85; cursor: pointer; }
.btn-link:hover { text-decoration: underline; }
.btn-link.danger { color: #B3392B; }
.status-tag.st-in_progress { color: #B77A00; }
.status-tag.st-wont_fix { color: #7A8A96; }
.status-tag.st-waiting { color: #7E57C2; }
.approved-strip {
  font-size: 12px; font-weight: 600; color: #0f6b4f; background: #e6f6ee; border: 1px solid #bfe7d2; border-radius: 6px; padding: 4px 8px; white-space: nowrap;
}
.cap-strip { font-size: 12px; color: #6b7a85; white-space: nowrap; }
.cap-strip.full { color: #b32d2e; font-weight: 600; }
.context-box { font-size: 11px; color: #6b7a85; margin: 0 0 8px; }
.context-box summary { cursor: pointer; color: #1B6493; }
.context-box ul { margin: 4px 0 0 14px; padding: 0; }
.context-box li { margin: 2px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; word-break: break-all; }
.side-status { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 8px; background: #eef2f4; color: #00263D; margin-left: 6px; }
.side-status.st-in_progress { background: #fff1d6; color: #8a5a00; }
.side-status.st-resolved { background: #dff5f2; color: #0e8a82; }
.side-status.st-wont_fix { background: #e6eaee; color: #5b6b76; }
.side-status.st-waiting { background: #f2edfa; color: #5b3d99; }
.side-status.lb-bug { background: #fbe9e7; color: #B3392B; }
.side-status.lb-copy { background: #eef5fa; color: #1B6493; }
.side-status.lb-design { background: #dff5f2; color: #0e8a82; }
.side-status.lb-content, .side-status.lb-photo { background: #fff1d6; color: #8a5a00; }
.side-status.lb-decision { background: #f2edfa; color: #5b3d99; }
.side-item.closed { opacity: 0.6; }
/* "looks addressed": amber dot badge — the content here changed since
   the comment was written, so it likely got handled. */
.pin.addressed::after {
  content: '';
  position: absolute;
  top: -4px; right: -4px;
  width: 10px; height: 10px;
  border-radius: 50%;
  background: #F5A623;
  border: 1.5px solid #fff;
  box-shadow: 0 1px 3px rgba(0, 38, 61, 0.35);
}

/* ---- cards (auth, comment box, popover, export) ---- */
.card {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 38, 61, 0.3);
  pointer-events: auto;
  overflow: hidden;
}
.card-head {
  background: #00263D;
  color: #fff;
  padding: 10px 14px;
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.card-head .close {
  background: none;
  border: none;
  color: #9BE3FF;
  font-size: 16px;
  line-height: 1;
  padding: 2px 4px;
}
.card-body { padding: 14px; background: #fff; }
.card-body a { color: #1B6493; font-weight: 600; }
.card-head svg { color: #9BE3FF; width: 14px; height: 14px; flex: none; }
/* Credit line on the auth/guest/blocked/unregistered cards. */
.powered-by {
  padding: 8px 14px;
  font-size: 11px;
  color: #6b7a85;
  border-top: 1px solid #eef2f4;
  background: #F9F9F9;
}
.powered-by a { color: #1B6493; font-weight: 600; text-decoration: none; }
.powered-by a:hover { text-decoration: underline; }
/* Site secret in the Invite panel. */
.secret-box { margin-top: 12px; padding-top: 10px; border-top: 1px solid #eef2f4; }
.secret-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.secret-value { font-size: 11px; background: #F9F9F9; padding: 4px 6px; border-radius: 4px; word-break: break-all; flex: 1 1 100%; }
.invite-foot { margin-top: 10px; }

.btn {
  background: #1B6493;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  font-weight: 600;
  font-size: 13px;
}
.btn:hover { background: #14517a; }
.btn-ghost {
  background: transparent;
  color: #1B6493;
  border: 1px solid #c9d6de;
}
.btn-ghost:hover { background: #F9F9F9; }
.btn-teal { background: #13A89E; }
.btn-teal:hover { background: #0e8a82; }
.btn-danger { background: transparent; color: #B3392B; border: 1px solid #d9b6b0; }
.btn-danger:hover { background: #faf0ee; }
.confirm-note { font-size: 12px; color: #B3392B; font-weight: 600; flex: 1 1 100%; }
.btn-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }

.field { margin-bottom: 10px; }
.field label { display: block; font-size: 12px; font-weight: 600; color: #00263D; margin-bottom: 4px; }
.field input, .field textarea {
  width: 100%;
  border: 1px solid #c9d6de;
  border-radius: 6px;
  padding: 8px 10px;
  background: #fff;
  color: #3A3A3A;
}
.field input:focus, .field textarea:focus {
  outline: 2px solid #9BE3FF;
  border-color: #1B6493;
}
.field textarea { resize: vertical; min-height: 70px; }

/* ---- image attach control (comment/reply forms) ---- */
.attach { margin: 0 0 10px; }
.attach-btn {
  font-size: 12px;
  font-weight: 600;
  color: #1B6493;
  background: #F9F9F9;
  border: 1px solid #c9d6de;
  border-radius: 6px;
  padding: 5px 10px;
}
.attach-btn:hover { background: #eef2f4; }
.attach-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.attach-thumb {
  position: relative;
  width: 54px; height: 54px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid #dbe3e8;
  background: #F9F9F9;
  display: flex; align-items: center; justify-content: center;
}
.attach-thumb img { width: 100%; height: 100%; object-fit: cover; }
.attach-thumb.uploading { animation: markup-pulse 1.2s ease-out infinite; }
.attach-spin {
  width: 14px; height: 14px;
  border: 2px solid #c9d6de;
  border-top-color: #1B6493;
  border-radius: 50%;
  animation: attach-spin 0.7s linear infinite;
}
@keyframes attach-spin { to { transform: rotate(360deg); } }
.attach-rm {
  position: absolute;
  top: 2px; right: 2px;
  width: 16px; height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 38, 61, 0.72);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
/* attached images shown inside a comment thread */
.entry-media { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.entry-thumb {
  width: 72px; height: 72px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #dbe3e8;
  cursor: zoom-in;
}

/* ---- auth card ---- */
.auth-card {
  position: fixed;
  right: 20px; bottom: 20px;
  width: 300px;
  z-index: 40;
}
.auth-card .hint { font-size: 12px; color: #6b7a85; margin-bottom: 10px; }

/* ---- comment box + thread popover ---- */
.popover {
  position: absolute;
  width: 320px;
  z-index: 25;
}
.thread { max-height: 280px; overflow-y: auto; }
.entry { padding: 10px 0; border-bottom: 1px solid #eef2f4; }
.entry:first-child { padding-top: 0; }
.entry:last-child { border-bottom: none; }
.entry .meta { font-size: 11px; color: #6b7a85; margin-bottom: 3px; }
.entry .meta b { color: #00263D; }
.entry .text { white-space: pre-wrap; }
.mention-tag {
  margin-top: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #1B6493;
}
/* device badge: which viewport (tablet/mobile) a pin was placed at */
.side-devnote { font-size: 11px; color: #8a5a00; background: #fff6e3; border-radius: 4px; padding: 2px 6px; margin: 4px 0 2px; }
.status-tag.dev-mobile, .status-tag.dev-tablet { color: #C9DCEA; text-transform: none; letter-spacing: 0; font-weight: 500; }
.device-pill.dev-desktop { color: #6b7a85; }
.device-pill.dev-mobile, .device-pill.dev-tablet { color: #00263D; background: #dbe7f0; }
.device-pill {
  display: inline-block;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #1B6493;
  background: #eef2f4;
  border-radius: 4px;
  padding: 1px 6px;
  vertical-align: middle;
}
/* @-mention autocomplete dropdown (mounted in the page-coord layer) */
.mention-menu {
  position: absolute;
  z-index: 40;
  pointer-events: auto;
  max-height: 196px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #cfd8de;
  border-radius: 8px;
  box-shadow: 0 6px 22px rgba(0, 38, 61, 0.18);
}
.mention-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border: none;
  background: none;
  font-size: 13px;
  color: #00263D;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention-item:hover { background: #F9F9F9; }
.context {
  /* Hidden from the front end: the raw element selector is noise for
     reviewers. Kept in the DOM (and these styles preserved) so it can be
     switched back on by removing this one line. */
  display: none;
  font-size: 11px;
  color: #6b7a85;
  background: #F9F9F9;
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 10px;
  word-break: break-all;
}
.status-tag {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #13A89E;
}

/* ---- export menu ---- */
.export-menu {
  position: fixed;
  right: 20px; bottom: 64px;
  width: 260px;
  z-index: 46;
}
/* When the comments sidebar is open, slide the pop-up menus left of it so
   they're not hidden behind the panel. */
.layer.sidebar-open .export-menu,
.layer.sidebar-open .invite-menu,
.layer.sidebar-open .confirm-card { right: 360px; }
.export-menu .opt {
  display: block;
  width: 100%;
  text-align: left;
  background: #fff;
  border: none;
  border-bottom: 1px solid #eef2f4;
  padding: 11px 14px;
  color: #3A3A3A;
  font-size: 13px;
}
.export-menu .opt:hover { background: #F9F9F9; color: #00263D; }
.export-menu .opt small { display: block; color: #6b7a85; font-size: 11px; }

/* ---- invite (client access) menu ---- */
.invite-menu {
  position: fixed;
  right: 20px; bottom: 64px;
  width: 320px;
  z-index: 46;
}
.invite-sub {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6b7a85;
  margin: 4px 0 8px;
}
.invite-list { max-height: 220px; overflow-y: auto; }
.invite-empty { font-size: 12px; color: #6b7a85; padding: 4px 0; }
.invite-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #eef2f4;
}
.invite-row:last-child { border-bottom: none; }
.invite-email { font-weight: 600; color: #00263D; font-size: 13px; word-break: break-all; }
.invite-note { font-size: 11px; color: #6b7a85; }

/* ---- exit-session confirm ---- */
.confirm-card {
  position: fixed;
  right: 20px; bottom: 64px;
  width: 280px;
  z-index: 46;
}

/* ---- all-comments sidebar (sits above the docked bar) ---- */
.sidebar {
  position: fixed;
  top: 0; right: 0;
  height: calc(100vh - 52px);
  width: 340px;
  max-width: 92vw;
  background: #fff;
  box-shadow: -8px 0 30px rgba(0, 38, 61, 0.3);
  z-index: 45;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  transform: translateX(105%);
  transition: transform 0.22s ease;
}
.sidebar.open { transform: none; }
.sidebar .card-head { border-radius: 0; }
.side-controls {
  padding: 10px 12px;
  background: #fff;
  border-bottom: 1px solid #e3eaee;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.side-search {
  width: 100%;
  border: 1px solid #c9d6de;
  border-radius: 6px;
  padding: 7px 10px;
  background: #fff;
  color: #3A3A3A;
}
.side-search:focus { outline: 2px solid #9BE3FF; border-color: #1B6493; }
.side-filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.side-select {
  border: 1px solid #c9d6de;
  border-radius: 6px;
  padding: 5px 8px;
  background: #fff;
  color: #3A3A3A;
  font-size: 12px;
}
.side-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #00263D;
  cursor: pointer;
  white-space: nowrap;
}
.side-check input { margin: 0; cursor: pointer; }
.side-list { flex: 1; overflow-y: auto; background: #F9F9F9; }
.side-group-h {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6b7a85;
  padding: 14px 14px 6px;
}
.side-item {
  background: #fff;
  margin: 0 10px 8px;
  border-radius: 8px;
  border: 1px solid #e3eaee;
  padding: 10px 12px;
  cursor: pointer;
}
.side-item:hover { border-color: #1B6493; }
.side-item.resolved { opacity: 0.6; }
.side-top { display: flex; gap: 8px; align-items: flex-start; }
.side-num {
  flex: none;
  width: 20px; height: 20px;
  border-radius: 50% 50% 50% 3px;
  background: #1B6493;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}
.side-item.resolved .side-num { background: #13A89E; }
.side-item.addressed { border-color: #F5C97A; }
.side-addressed {
  font-size: 11px;
  font-weight: 600;
  color: #B8740F;
  background: #FFF7E6;
  border-radius: 5px;
  padding: 3px 8px;
  margin: 6px 0 0 28px;
  display: inline-block;
}
.side-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.side-meta { font-size: 11px; color: #6b7a85; margin: 5px 0 0 28px; }
.side-actions { display: flex; gap: 6px; margin: 8px 0 0 28px; align-items: center; }
.mini-btn {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid #c9d6de;
  background: #fff;
  color: #1B6493;
}
.mini-btn:hover { background: #F9F9F9; }
.mini-btn.teal { color: #0e8a82; border-color: #b3e2de; }
.mini-btn.danger { color: #B3392B; border-color: #d9b6b0; }
.side-confirm { font-size: 11px; font-weight: 700; color: #B3392B; }
.side-empty { padding: 30px 20px; text-align: center; color: #6b7a85; }

/* ---- toast ---- */
.toast {
  position: fixed;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  background: #00263D;
  color: #fff;
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 38, 61, 0.35);
  z-index: 50;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}
.toast.show { opacity: 1; }
`;
