import { init } from './app.js';
import { MARKUP_VERSION } from './config.js';

// Exposed for support ("which build is this site on?") and used by the
// release script as proof that the built bundle is the one being shipped.
window.__avalancheMarkupVersion = MARKUP_VERSION;

// Activation gate: real visitors short-circuit here. The script runs
// when the URL carries ?pinpoint=TOKEN, or the older ?markup=TOKEN (data-project on the script tag
// is the fallback token when ?markup is present but empty). Once
// activated, the token is kept in sessionStorage so feedback mode
// survives navigating between pages — it ends when the tab closes or
// via the Exit button.
const script = document.currentScript;
const params = new URLSearchParams(location.search);

// data-open="1" means the plugin's "open feedback" toggle is on: visitors
// who aren't signed in can comment after entering just a display name.
// Captured here because document.currentScript is only valid during this
// synchronous pass.
const openAccess = !!(script && script.dataset.open);

// ?pinpoint=TOKEN is the share link; ?markup=TOKEN still works for links
// sent out before the rename.
let token = null;
if (params.has('pinpoint') || params.has('markup')) {
  token = params.get('pinpoint') || params.get('markup') || (script && script.dataset.project) || '';
  try {
    if (token) sessionStorage.setItem('markup_token', token);
  } catch {
    /* storage blocked — single-page activation still works */
  }
} else {
  try {
    token = sessionStorage.getItem('markup_token');
  } catch {
    token = null;
  }
}

// Never inside a page builder's editor or the WordPress Customizer: the
// token is remembered for the tab, so without this PinPoint would start on
// top of the editor. URL flags cover the editors' own loads; body classes
// cover editors that switch modes without reloading.
const EDITOR_PARAMS = ['fl_builder', 'fl_builder_load_settings_config', 'elementor-preview', 'et_fb', 'ct_builder', 'bricks', 'vc_editable', 'vcv-editable', 'brizy-edit-iframe', 'customize_changeset_uuid', 'customize_messenger_channel'];
const EDITOR_CLASSES = ['fl-builder-edit', 'fl-builder--editing', 'elementor-editor-active', 'et-fb', 'oxygen-builder-body', 'brz-ed', 'wp-customizer'];
function inPageEditor() {
  if (EDITOR_PARAMS.some((p) => params.has(p))) return true;
  const cls = (document.body && document.body.classList) || { contains: () => false };
  return EDITOR_CLASSES.some((c) => cls.contains(c));
}

// Double-include guard: if the embed ends up in both a theme and the
// plugin, only the first copy mounts.
if (token && !window.__avalancheMarkup) {
  window.__avalancheMarkup = true;
  const start = () => { if (!inPageEditor()) init(token, { openAccess }); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
