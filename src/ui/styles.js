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
}
.toolbar-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
  font-size: 13px;
  color: #00263D;
  margin-right: 6px;
  white-space: nowrap;
}
.toolbar-brand .dot {
  width: 13px; height: 13px;
  border-radius: 50% 50% 50% 3px;
  background: #1B6493;
  flex: none;
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
.toolbar .spacer { margin-left: auto; }
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
.pin.resolved { background: #13A89E; opacity: 0.55; }

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
.confirm-note { font-size: 12px; color: #B3392B; font-weight: 600; align-self: center; margin-right: auto; }
.btn-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }

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
.context {
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
  z-index: 40;
}
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
