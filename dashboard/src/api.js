// All backend access for the dashboard: the anon key + the user's session,
// ordinary RLS, owner-gated RPCs, and the billing edge functions. There is
// NO service key here and the plan is NEVER written from the browser.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, FUNCTIONS_URL } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getSession() {
  return (await supabase.auth.getSession()).data.session;
}

const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

export const listProjects = async () =>
  unwrap(await supabase.from('projects').select('id,name,site_url,token,open_access,owner_id,created_at').order('created_at')) || [];

export const getProject = async (id) =>
  unwrap(await supabase.from('projects').select('id,name,site_url,token,open_access,owner_id,created_at').eq('id', id).maybeSingle());

export const createProject = (row) => supabase.from('projects').insert(row).select('id').single();
export const deleteProject = async (id) => unwrap(await supabase.from('projects').delete().eq('id', id));

export const account = async () => (await supabase.rpc('my_account')).data || { plan: 'free', project_limit: 1, owned_count: 0 };
export const subscription = async () => (await supabase.from('subscriptions').select('*').maybeSingle()).data;

export const updateSettings = async (id, { name, site_url, open_access, auto_screenshot }) =>
  unwrap(await supabase.rpc('update_project_settings', { p_project: id, p_name: name ?? null, p_site_url: site_url ?? null, p_open_access: open_access ?? null, p_auto_screenshot: auto_screenshot ?? null }));

export const listInvites = async (id) => unwrap(await supabase.rpc('list_invites', { p_project: id })) || [];
export const invite = async (id, email, note) => unwrap(await supabase.rpc('invite_email', { p_project: id, p_email: email, p_note: note || null }));
export const revoke = async (id, email) => unwrap(await supabase.rpc('revoke_invite', { p_project: id, p_email: email }));

export const listNotify = async (id) => unwrap(await supabase.rpc('list_notify_recipients', { p_project: id })) || [];
export const setNotifyMode = async (id, mode) => unwrap(await supabase.rpc('update_notify_mode', { p_project: id, p_mode: mode }));
export const setNotify = async (id, emails) => unwrap(await supabase.rpc('set_notify_recipients', { p_project: id, p_emails: emails }));

export const bridgeSecret = async (id) => unwrap(await supabase.rpc('get_bridge_secret', { p_project: id }));
export const rotateSecret = async (id) => unwrap(await supabase.rpc('rotate_bridge_secret', { p_project: id }));
export const agentKey = async (id) => unwrap(await supabase.rpc('get_agent_key', { p_project: id }));
// Open (open + in_progress) root-comment counts per project, one query.
export const openCounts = async () => {
  const rows = unwrap(await supabase.from('comments').select('project_id,status').is('parent_id', null).in('status', ['open', 'in_progress', 'waiting'])) || [];
  const out = {};
  for (const r of rows) out[r.project_id] = (out[r.project_id] || 0) + 1;
  return out;
};
export const projectAccess = async (id) => unwrap(await supabase.rpc('my_project_role', { p_project: id }));

// Feedback inbox (ordinary RLS: owner / collaborator / operator can read).
export const listComments = async (id) =>
  unwrap(await supabase.from('comments').select('id,parent_id,page_path,page_url,element_tag,selector,current_text,comment_text,author_email,author_name,author_role,status,assignee_email,labels,effort,viewport_w,kind,source,created_at,attachments,context,external_ref,design_check,preview_id').eq('project_id', id).order('created_at')) || [];
export const patchComment = async (id, patch) => unwrap(await supabase.from('comments').update(patch).eq('id', id).select('id,status,assignee_email,labels,effort').single());
export const sendDigest = async (id, to) => callFn('digest', { project_id: id, to });
export const setManager = async (id, email, manager) => unwrap(await supabase.rpc('set_member_manager', { p_project: id, p_email: email, p_manager: !!manager }));
export const saveTriage = async (id, t) => unwrap(await supabase.rpc('update_triage_settings', { p_project: id, p_triage: t }));
export const setDigestWeekly = async (id, weekly) => unwrap(await supabase.rpc('update_digest_settings', { p_project: id, p_weekly: !!weekly }));
export const assignees = async (id) => unwrap(await supabase.rpc('list_assignees', { p_project: id })) || [];

// Page approvals (Agency).
export const approvals = async (id) => unwrap(await supabase.from('page_approvals').select('id,page_path,approved_by_email,approved_by_name,approved_role,note,created_at').eq('project_id', id).is('revoked_at', null).order('created_at')) || [];
export const reopenPage = async (id, page) => unwrap(await supabase.rpc('revoke_approval', { p_project: id, p_page: page }));

// Integrations (Agency). Secrets go in through the RPC and never come back out.
export const integrations = async (id) => unwrap(await supabase.rpc('get_integrations', { p_project: id })) || [];
export const saveIntegration = async (id, kind, config) => unwrap(await supabase.rpc('set_integration', { p_project: id, p_kind: kind, p_config: config }));
export const removeIntegration = async (id, kind) => unwrap(await supabase.rpc('remove_integration', { p_project: id, p_kind: kind }));
export const rotateAgentKey = async (id) => unwrap(await supabase.rpc('rotate_agent_key', { p_project: id }));
export const agentPersona = async (id) => unwrap(await supabase.rpc('agent_persona', { p_project: id }));
export const saveAgentPersona = async (id, { email, name, label }) => unwrap(await supabase.rpc('update_agent_settings', { p_project: id, p_email: email ?? null, p_name: name ?? null, p_label: !!label }));

// Billing edge functions (user JWT; verified in-function).
export async function callFn(name, body) {
  const s = await getSession();
  if (!s) throw new Error('sign in required');
  const r = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.access_token}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${name} failed (${r.status})`);
  return d;
}

// Design rules (Agency, optional per project). Owner RPCs write; members
// read the design system tables through RLS. Decisions go through the
// design-rules edge function.
export const designSettings = async (id) => (unwrap(await supabase.from('projects').select('design_rules').eq('id', id).maybeSingle()) || {}).design_rules || {};
export const setDesignRules = async (id, settings) => unwrap(await supabase.rpc('set_design_rules', { p_project: id, p_settings: settings }));
export const setDesignKey = async (id, key, prod = false) => unwrap(await supabase.rpc('set_design_connector_key', { p_project: id, p_key: key, p_prod: !!prod }));
export const designKeyStatus = async (id) => unwrap(await supabase.rpc('design_connector_status', { p_project: id })) || {};
export const saveDesignTokens = async (id, tokens, summary) => unwrap(await supabase.rpc('save_design_tokens', { p_project: id, p_tokens: tokens, p_summary: summary || null }));
export const setDesignShare = async (id, on) => unwrap(await supabase.rpc('set_design_share', { p_project: id, p_on: !!on }));
export const sharedDesign = async (token) => unwrap(await supabase.rpc('get_shared_design_system', { p_token: token }));
export const designSystem = async (id) => unwrap(await supabase.from('design_systems').select('tokens,version,updated_at,updated_by,source,source_url,share_token').eq('project_id', id).maybeSingle());
export const designExceptions = async (id) => unwrap(await supabase.from('design_exceptions').select('id,comment_id,page_path,selector,property,value,reason,created_by,active,created_at').eq('project_id', id).eq('active', true).order('created_at', { ascending: false }).limit(100)) || [];
export const designProposals = async (id) => unwrap(await supabase.from('design_proposals').select('id,comment_id,summary,status,requested_by,decided_by,decided_at,version_from,version_to,affected,created_at').eq('project_id', id).order('created_at', { ascending: false }).limit(50)) || [];
export const designChangelog = async (id) => unwrap(await supabase.from('design_changelog').select('id,version,kind,summary,by,at').eq('project_id', id).order('at', { ascending: false }).limit(50)) || [];
export const designFn = (body) => callFn('design-rules', body);
