// All Supabase reads/writes live here.

export async function fetchProject(supabase, token) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, site_url')
    .eq('token', token)
    .maybeSingle();
  if (error) {
    console.warn('[markup] project lookup failed:', error.message);
    return null;
  }
  return data;
}

// Is the signed-in user a member of this project? (Team-domain emails are
// checked separately and don't need a membership row.)
export async function isMember(supabase, projectId) {
  const { data, error } = await supabase.rpc('is_member', { p_project: projectId });
  if (error) {
    console.warn('[markup] membership check failed:', error.message);
    return false;
  }
  return !!data;
}

// Invite management — now per project (team-only; enforced by the
// SECURITY DEFINER functions, so a non-team caller just gets an error).
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
// participated here plus the team's notify list (project-scoped on the
// server so it never leaks other clients' emails). Returns [{email, name}].
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

export async function insertComment(supabase, row) {
  const { data, error } = await supabase
    .from('comments')
    .insert(row)
    .select()
    .single();
  if (error) {
    console.warn('[markup] comment insert failed:', error.message);
    return null;
  }
  return data;
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

// Deleting a top-level comment cascades to its replies (FK on delete cascade).
export async function deleteComment(supabase, id) {
  const { error } = await supabase.from('comments').delete().eq('id', id);
  if (error) {
    console.warn('[markup] comment delete failed:', error.message);
    return false;
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
