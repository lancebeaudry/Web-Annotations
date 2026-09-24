import { h, fmtDate, toast } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { account, subscription, callFn } from '../api.js';
import { PRICES } from '../config.js';

const PLAN_NAME = { free: 'Free', pro: 'Pro', agency: 'Agency' };

export async function accountScreen({ user, query }) {
  const [acct, sub] = await Promise.all([account(), subscription()]);
  const current = acct.is_operator ? 'agency' : acct.plan || 'free';
  const paid = current !== 'free';

  const status = h(
    'div',
    {},
    h('p', {}, 'Signed in as ', h('b', {}, user.email)),
    h(
      'p',
      {},
      h('span', { class: `badge ${current === 'pro' ? 'badge-pro' : current === 'agency' ? 'badge-agency' : ''}` }, acct.is_operator ? 'Operator' : PLAN_NAME[current]),
      ' ',
      acct.is_operator
        ? 'Unlimited projects, all features.'
        : paid
          ? `${acct.project_limit >= 2147483647 ? 'Unlimited' : acct.project_limit} projects · ${sub?.cancel_at_period_end ? 'ends' : 'renews'} ${fmtDate(sub?.current_period_end)}${sub?.status === 'past_due' ? ' · payment failed — update your card' : ''}`
          : `1 project · ${acct.limits?.comments ?? 50} comments and ${acct.limits?.images ?? 10} images per project.`
    )
  );

  // Plan picker with a monthly / yearly switch.
  let interval = 'year';
  const seg = h('div', { class: 'seg' });
  const plansEl = h('div', { class: 'plans' });
  const renderPlans = () => {
    seg.replaceChildren(
      ...['month', 'year'].map((iv) => {
        const b = h('button', { type: 'button', class: iv === interval ? 'on' : '' }, iv === 'month' ? 'Monthly' : 'Yearly (save ~35%)');
        b.addEventListener('click', () => { interval = iv; renderPlans(); });
        return b;
      })
    );
    const plan = (id, name, price, bullets) => {
      const isCurrent = current === id;
      const btn = h('button', { class: `btn ${isCurrent ? 'btn-ghost' : ''}`, disabled: isCurrent || acct.is_operator }, isCurrent ? 'Current plan' : id === 'free' ? 'Downgrade in billing' : paid ? `Switch to ${name}` : `Choose ${name}`);
      if (!isCurrent && id !== 'free') btn.addEventListener('click', () => choose(id, btn));
      if (!isCurrent && id === 'free') btn.addEventListener('click', () => manage.click());
      return h('div', { class: `plan ${isCurrent ? 'current' : ''}` },
        h('div', { class: 'name' }, name),
        h('div', { class: 'price' }, price),
        h('ul', {}, ...bullets.map((b) => h('li', {}, b))),
        btn);
    };
    plansEl.replaceChildren(
      plan('free', 'Free', h('span', {}, '$0'), ['1 site', '50 comments and 10 images per project', 'Threads, mentions, device previews, export']),
      plan('pro', 'Pro', h('span', {}, `$${PRICES.pro[interval]} `, h('small', {}, interval === 'month' ? '/ month' : '/ year')), [`${PRICES.pro.sites} sites`, 'Unlimited comments and images', 'Feedback inbox with statuses and assignees', 'AI-assistant loop and MCP server']),
      plan('agency', 'Agency', h('span', {}, `$${PRICES.agency[interval]} `, h('small', {}, interval === 'month' ? '/ month' : '/ year')), ['Unlimited sites', 'Everything in Pro', 'Slack and ClickUp integrations', 'Page approvals (sign-off)', 'Priority support'])
    );
  };

  async function choose(plan, btn) {
    btn.disabled = true;
    try {
      const { url, switched } = await callFn('billing-checkout', { plan, interval });
      if (switched) toast('Plan updated — refreshing…');
      location.href = url;
    } catch (err) {
      toast(err.message === 'billing not configured' ? 'Billing isn’t live yet — check back soon.' : err.message);
      btn.disabled = false;
    }
  }

  const manage = h('button', { class: 'btn btn-ghost' }, 'Manage billing');
  manage.addEventListener('click', async () => {
    manage.disabled = true;
    try {
      const { url } = await callFn('billing-portal');
      location.href = url;
    } catch (err) {
      toast(err.message);
      manage.disabled = false;
    }
  });
  renderPlans();

  // Back from Checkout: the webhook may lag a few seconds.
  let activating = null;
  if (query.checkout === 'success') {
    activating = h('p', { class: 'notice' }, 'Activating your plan…');
    const started = Date.now();
    const before = current;
    const poll = setInterval(async () => {
      const a = await account();
      if ((a.plan !== before && a.plan !== 'free') || Date.now() - started > 30000) {
        clearInterval(poll);
        history.replaceState(null, '', location.pathname + '#/account');
        location.reload();
      }
    }, 2000);
  } else if (query.checkout === 'cancel') {
    history.replaceState(null, '', location.pathname + '#/account');
  }

  return h(
    'div',
    {},
    card('Account', status, activating, sub?.stripe_customer_id ? h('div', { class: 'btn-row' }, manage) : null),
    card('Plans', h('div', { class: 'inline' }, seg), plansEl, h('p', { class: 'hint' }, 'Cancel any time from Manage billing; your plan stays active until the end of the period. If a paid plan lapses, your oldest projects stay live up to the free allowance and the rest become read-only. Nothing is deleted.')),
    card('Need help?', h('p', {}, 'Email ', h('a', { href: 'mailto:projects@avalanchegr.com' }, 'projects@avalanchegr.com'), '.'))
  );
}
