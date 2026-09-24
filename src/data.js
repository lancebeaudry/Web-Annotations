// All Supabase reads/writes live here.

// Resolve a token -> project. This goes through get_project_by_token()
// rather than reading `projects` directly: the table is not listable (that
// would let anyone enumerate every customer's token), and the function is
// also what records the "unlock" proving this visitor knew the token, which
// is what grants read access to an open project's comments.
export async function fetchProject(supabase, token) {
  const { data, error } = await supabase
    .rpc('get_project_by_token', { p_token: token })
    .maybeSingle();
  if (error) {
    console.warn('[markup] project lookup failed:', error.message);
    return null;
  }
  return data;
}

// Register a site the first time a signed-in account opens it. The DB
// forces owner_id = the caller and enforces their plan's project limit
// (raises PROJECT_LIMIT_REACHED). The unique token index makes concurrent
// first-visits safe (the loser gets an error and re-reads). Returns
// { data, error } so the caller can tell "limit reached" from "race".
export async function createProject(supabase, { token, name, site_url, open_access }) {
  const { data, error } = await supabase
    .from('projects')
    .insert({ token, name, site_url, open_access: !!open_access })
    .select('id, name, site_url, open_access')
    .maybeSingle();
  if (error) console.warn('[markup] project create failed:', error.message);
  return { data, error };
}

// The viewer's role on this project and whether it accepts writes, resolved
// server-side in one call: operator | owner | collaborator | guest | none.
export async function fetchAccess(supabase, projectId) {
  const { data, error } = await supabase.rpc('my_project_role', { p_project: projectId });
  if (error || !data) {
    if (error) console.warn('[markup] access check failed:', error.message);
    return { role: 'none', writable: false };
  }
  return { ...data, role: data.role || 'none', writable: !!data.writable, features: data.features || [], approved_pages: data.approved_pages || [] };
}

// Page approvals (Agency): approve locks new pins on that page until reopened.
export async function approvePage(supabase, projectId, pagePath, note) {
  const { data, error } = await supabase.rpc('approve_page', { p_project: projectId, p_page: pagePath, p_note: note || null });
  return error ? { error: error.message } : { data };
}
export async function revokeApproval(supabase, projectId, pagePath) {
  const { error } = await supabase.rpc('revoke_approval', { p_project: projectId, p_page: pagePath });
  return error ? error.message : null;
}
export async function listAssignees(supabase, projectId) {
  const { data, error } = await supabase.rpc('list_assignees', { p_project: projectId });
  return error ? [] : data || [];
}

// The viewer's account: plan, limits, operator flag.
export async function fetchAccount(supabase) {
  const { data, error } = await supabase.rpc('my_account');
  if (error) {
    console.warn('[markup] account lookup failed:', error.message);
    return null;
  }
  return data;
}

// Per-project bridge secret (owner/operator only).
export async function getBridgeSecret(supabase, projectId) {
  const { data, error } = await supabase.rpc('get_bridge_secret', { p_project: projectId });
  return error ? { error: error.message } : { secret: data };
}
export async function getAgentKey(supabase, projectId) {
  const { data, error } = await supabase.rpc('get_agent_key', { p_project: projectId });
  return error ? { error: error.message } : { key: data };
}
export async function rotateBridgeSecret(supabase, projectId) {
  const { data, error } = await supabase.rpc('rotate_bridge_secret', { p_project: projectId });
  return error ? { error: error.message } : { secret: data };
}

// Invite management — owner/operator only (enforced by the SECURITY
// DEFINER functions, so a non-owner caller just gets an error).
export async function inviteEmail(supabase, projectId, email, note) {
  const { error } = await supabase.rpc('invite_email', { p_project: projectId, p_email: email, p_note: note || null });
  return error ? error.message : null;
}

export async function listInvites(supabase, projectId) {
  const { data, error } = await supabase.rpc('list_invites', { p_project: projectId });
  if (error) {
    console.warn('[markup] list invites failed:', error.message);
    return [];
  }
  return data || [];
}

export async function revokeInvite(supabase, projectId, email) {
  const { error } = await supabase.rpc('revoke_invite', { p_project: projectId, p_email: email });
  return error ? error.message : null;
}

// People who can be @mentioned on this project: everyone who has
// participated here plus the notify list and the owner (project-scoped on
// the server so it never leaks other customers' emails). [{email, name}]
export async function listMentionable(supabase, projectId) {
  const { data, error } = await supabase.rpc('list_mentionable', { p_project: projectId });
  if (error) {
    console.warn('[markup] mentionable lookup failed:', error.message);
    return [];
  }
  return data || [];
}

export async function fetchComments(supabase, projectId) {
  const { data, error } = await supabase
    .from('comments')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[markup] comments fetch failed:', error.message);
    return [];
  }
  return data || [];
}

// Upload one image to the comment-media bucket, namespaced by project. The
// storage policy requires that prefix and checks the project's quota.
// Returns { url, name, type } to store on the comment, or null on failure.
export async function uploadAttachment(supabase, projectId, file) {
  const ext = ((file.name || '').split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const path = `${projectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from('comment-media')
    .upload(path, file, { contentType: file.type || 'image/png', upsert: false });
  if (error) {
    console.warn('[markup] attachment upload failed:', error.message);
    return null;
  }
  const { data } = supabase.storage.from('comment-media').getPublicUrl(path);
  return { url: data.publicUrl, name: file.name || 'image', type: file.type || 'image/png' };
}

export async function insertCommentResult(supabase, row) {
  const { data, error } = await supabase
    .from('comments')
    .insert(row)
    .select()
    .single();
  if (error) console.warn('[markup] comment insert failed:', error.message);
  return { data: error ? null : data, error };
}
export async function insertComment(supabase, row) {
  return (await insertCommentResult(supabase, row)).data;
}

export async function updateComment(supabase, id, patch) {
  const { data, error } = await supabase
    .from('comments')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    console.warn('[markup] comment update failed:', error.message);
    return null;
  }
  return data;
}

// Deleting a top-level comment cascades to its replies (FK on delete
// cascade). Its own image attachments are removed best-effort here; the DB
// also tombstones them so the hourly sweeper catches anything missed.
export async function deleteComment(supabase, id, attachments = []) {
  const { error } = await supabase.from('comments').delete().eq('id', id);
  if (error) {
    console.warn('[markup] comment delete failed:', error.message);
    return false;
  }
  const paths = (attachments || [])
    .map((a) => ((a && a.url) || '').split('/comment-media/')[1])
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  if (paths.length) {
    supabase.storage.from('comment-media').remove(paths).catch(() => {});
  }
  return true;
}

// Live sync: pins and status changes appear without a refresh.
export function subscribeRealtime(supabase, projectId, onChange) {
  return supabase
    .channel(`markup-comments-${projectId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'comments',
        filter: `project_id=eq.${projectId}`,
      },
      (payload) => onChange(payload.eventType, payload.new || payload.old)
    )
    .subscribe();
}
