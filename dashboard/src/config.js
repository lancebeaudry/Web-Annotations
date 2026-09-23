// Injected at build time by build-app.mjs from .env
export const SUPABASE_URL = __SUPABASE_URL__;
export const SUPABASE_ANON_KEY = __SUPABASE_ANON_KEY__;
export const FUNCTIONS_URL = __FUNCTIONS_URL__;
export const BUNDLE_URL = __BUNDLE_URL__;
export const DASHBOARD_URL = __DASHBOARD_URL__;
export const PRO_PRICE_LABEL = __PRO_PRICE_LABEL__;
export const APP_VERSION = __APP_VERSION__;
export const BRAND_URL = 'https://avalanchegr.com/?utm_source=pinpoint&utm_medium=dashboard&utm_campaign=app';
export const PLUGIN_ZIP_URL = BUNDLE_URL.replace(/markup\.js$/, 'plugin/avalanche-markup.zip');
