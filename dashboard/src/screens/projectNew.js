import { h, field, toast, slugify } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { createProject } from '../api.js';
import { go } from '../router.js';

// Prefilled from the overlay's "Create a free account and register it"
// link (#/projects/new?site=…&token=…).
export function projectNewScreen({ query }) {
  const name = h('input', { type: 'text', placeholder: 'Acme Landscaping', required: true });
  const site = h('input', { type: 'url', placeholder: 'https://staging.acme.com', required: true, value: query.site || '' });
  const token = h('input', { type: 'text', class: 'code', placeholder: 'acme', required: true, value: (query.token || '').toLowerCase() });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Create project');
  let touched = !!query.token;
  name.addEventListener('input', () => {
    if (!touched) token.value = slugify(name.value);
  });
  token.addEventListener('input', () => {
    touched = true;
    token.value = token.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
  });

  const limitCard = h(
    'div',
    { class: 'notice' },
    h('b', {}, 'Free plan includes 1 project.'),
    ' Upgrade to add more sites. ',
    h('a', { class: 'btn btn-sm', href: '#/account' }, 'Upgrade')
  );
  limitCard.hidden = true;

  const form = h(
    'form',
    {},
    field('Project name', name, 'Shown in exports and notification emails.'),
    field('Site URL', site, 'The site you\'ll be reviewing. Just the origin, e.g. https://staging.acme.com'),
    field('Token', token, 'Short, lowercase, unique. Your share link becomes  site/?markup=TOKEN'),
    limitCard,
    h('div', { class: 'btn-row' }, h('a', { class: 'btn btn-ghost', href: '#/projects' }, 'Cancel'), submit)
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = token.value.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(t)) return toast('Token: lowercase letters, numbers and dashes, 2–60 characters.');
    let origin;
    try {
      origin = new URL(site.value.trim()).origin;
    } catch {
      return toast('Enter a full site URL, e.g. https://staging.acme.com');
    }
    submit.disabled = true;
    const { data, error } = await createProject({ name: name.value.trim(), site_url: origin, token: t, open_access: false });
    submit.disabled = false;
    if (error) {
      if (/PROJECT_LIMIT/.test(error.message)) {
        limitCard.hidden = false;
        return;
      }
      if (error.code === '23505' || /duplicate|unique/i.test(error.message)) return toast('That token is already in use — pick another.');
      return toast(error.message);
    }
    toast('Project created');
    go(`#/projects/${data.id}`);
  });

  return card('New project', form);
}
