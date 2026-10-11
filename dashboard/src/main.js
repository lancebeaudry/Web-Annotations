// PinPoint — customer dashboard entry point.
import { h } from './ui/dom.js';
import { shell } from './ui/shell.js';
import { supabase, getSession, account } from './api.js';
import { parseRoute, onRoute, go } from './router.js';
import { signinScreen } from './screens/signin.js';
import { projectsScreen } from './screens/projects.js';
import { projectNewScreen } from './screens/projectNew.js';
import { projectDetailScreen } from './screens/projectDetail.js';
import { accountScreen } from './screens/account.js';
import { feedbackScreen } from './screens/feedback.js';
import { designScreen, sharedDesignScreen } from './screens/designSystem.js';

const root = document.getElementById('app');
let rendering = 0;

async function render() {
  const seq = ++rendering;
  const route = parseRoute();
  // Top-level query (?checkout=success) sits BEFORE the hash.
  const top = Object.fromEntries(new URLSearchParams(location.search));
  const query = { ...top, ...route.query };

  if (route.name === 'signout') {
    await supabase.auth.signOut();
    go('#/signin');
    return;
  }

  // A shared design system link is public: no sign-in needed.
  if (route.name === 'sharedDesign') {
    root.replaceChildren(shell(h('p', { class: 'hint' }, 'Loading…'), {}));
    const content = await sharedDesignScreen(route.token);
    if (seq === rendering) root.replaceChildren(shell(content, { wide: true }));
    return;
  }

  const session = await getSession();
  const user = session?.user;
  if (!user || user.is_anonymous) {
    root.replaceChildren(shell(signinScreen(), {}));
    return;
  }
  if (route.name === 'signin') {
    go('#/projects');
    return;
  }

  root.replaceChildren(shell(h('p', { class: 'hint' }, 'Loading…'), { user, active: route.name }));
  try {
    const acct = await account();
    let content;
    switch (route.name) {
      case 'projectNew': content = projectNewScreen({ query, user, acct }); break;
      case 'projectDetail': content = await projectDetailScreen({ id: route.id, user, acct, query }); break;
      case 'feedback': content = await feedbackScreen({ id: route.id, user, acct, query }); break;
      case 'design': content = await designScreen({ id: route.id, user, acct, query }); break;
      case 'account': content = await accountScreen({ user, acct, query }); break;
      default: content = await projectsScreen({ user, acct, query });
    }
    if (seq !== rendering) return; // a newer render superseded this one
    root.replaceChildren(shell(content, { user, active: ['projectNew', 'projectDetail', 'feedback', 'design'].includes(route.name) ? 'projects' : route.name, wide: ['projectDetail', 'feedback', 'projects', 'design'].includes(route.name) }));
  } catch (err) {
    root.replaceChildren(shell(h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', {}, 'Something went wrong: ', err.message), h('a', { class: 'btn', href: '#/projects' }, 'Back'))), { user }));
  }
}

onRoute(render);
supabase.auth.onAuthStateChange((_e, session) => {
  if (session && parseRoute().name === 'signin') go('#/projects');
  else render();
});
render();
