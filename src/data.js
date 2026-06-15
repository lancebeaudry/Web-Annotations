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

// Is this signed-in email on the invite list? (Team-domain emails are
// checked separately and don't need a row.)
export async function isInvited(supabase, email) {
  const { data, error } = await supabase
    .from('allowed_emails')
    .select('email')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error) {
    console.warn('[markup] invite check failed:', error.message);
    return false;
  }
  return !!data;
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
