// Role labels. Roles are stamped on each comment by the database at insert
// (comments.author_role) so labels are historically accurate and need no
// joins. The viewer's own role comes from the my_project_role() RPC.
//
//   operator      Avalanche staff
//   owner         the customer who owns the project
//   collaborator  invited by the owner (a "client" reviewer)
//   guest         name-only visitor on an open-feedback site
//   agent         an AI coding assistant replying through the agent endpoint

export const ROLE_LABEL = {
  operator: 'Avalanche',
  owner: 'owner',
  collaborator: 'client',
  guest: 'guest',
  agent: 'AI assistant',
};

// Label for a stored comment. Older rows (pre-2.0) have no author_role;
// infer the only thing we can from the email shape.
export function roleLabel(comment) {
  const role = comment.author_role;
  if (role && ROLE_LABEL[role]) return ROLE_LABEL[role];
  const email = comment.author_email || '';
  return email.startsWith('guest:') ? ROLE_LABEL.guest : ROLE_LABEL.collaborator;
}

// Display name for a stored comment.
export function authorName(comment) {
  const email = comment.author_email || '';
  if (email.startsWith('agent:')) return comment.author_name || 'AI assistant';
  const isGuest = email.startsWith('guest:');
  return comment.author_name || (isGuest ? 'Guest' : email);
}
