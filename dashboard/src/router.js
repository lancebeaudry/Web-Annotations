// Hash router. Storage serves exact object keys, so paths like
// /app/projects/123 would 404 — everything lives after '#'.
//   #/signin  #/projects  #/projects/new?site=…&token=…  #/projects/:id  #/account

export function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/projects';
  const [path, qs] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'projects' && parts[1] === 'new') return { name: 'projectNew', query };
  if (parts[0] === 'projects' && parts[1] && parts[2] === 'feedback') return { name: 'feedback', id: parts[1], query };
  if (parts[0] === 'projects' && parts[1]) return { name: 'projectDetail', id: parts[1], query };
  if (parts[0] === 'projects') return { name: 'projects', query };
  if (parts[0] === 'account') return { name: 'account', query };
  if (parts[0] === 'signin') return { name: 'signin', query };
  if (parts[0] === 'signout') return { name: 'signout', query };
  return { name: 'projects', query };
}

export function go(hash) {
  location.hash = hash;
}

export function onRoute(fn) {
  window.addEventListener('hashchange', fn);
}
