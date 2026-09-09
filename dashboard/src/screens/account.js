import { h, fmtDate, toast } from '../ui/dom.js';
import { card } from '../ui/shell.js';
import { account, subscription, callFn } from '../api.js';
import { PRO_PRICE_LABEL } from '../config.js';

export async function accountScreen({ user, query }) {
  const [acct, sub] = await Promise.all([account(), subscription()]);
  const pro = acct.plan === 'pro';

  const status = h(
    'div',
    {},
    h('p', {}, 'Signed in as ', h('b', {}, user.email)),
    h(
      'p',
      {},
      h('span', { class: `badge ${pro ? 'badge-pro' : ''}` }, acct.is_operator ? 'Operator' : pro ? 'Pro' : 'Free'),
      ' ',
      acct.is_operator
        ? 'Unlimited projects.'
        : pro
          ? `${acct.project_limit} projects · ${sub?.cancel_at_period_end ? 'ends' : 'renews'} ${fmtDate(sub?.current_period_end)}${sub?.status === 'past_due' ? ' · payment failed — update your card' : ''}`
          : `1 project · Pro is ${PRO_PRICE_LABEL} for ${acct.project_limit >= 10 ? acct.project_limit : 10} projects.`
    )
  );

  const upgrade = h('button', { class: 'btn' }, `Upgrade to Pro — ${PRO_PRICE_LABEL}`);
  const manage = h('button', { class: 'btn btn-ghost' }, 'Manage billing');
  upgrade.addEventListener('click', async () => {
    upgrade.disabled = true;
    try {
      const { url } = await callFn('billing-checkout');
      location.href = url;
    } catch (err) {
      toast(err.message === 'billing not configured' ? 'Billing isn’t live yet — check back soon.' : err.message);
      upgrade.disabled = false;
    }
  });
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

  const actions = h('div', { class: 'btn-row' }, pro || acct.is_operator ? null : upgrade, sub?.stripe_customer_id ? manage : null);

  // Back from Checkout: the webhook may lag a few seconds.
  let activating = null;
  if (query.checkout === 'success' && !pro) {
    activating = h('p', { class: 'notice' }, 'Activating your plan…');
    const started = Date.now();
    const poll = setInterval(async () => {
      const a = await account();
      if (a.plan === 'pro' || Date.now() - started > 30000) {
        clearInterval(poll);
        history.replaceState(null, '', location.pathname + '#/account');
        location.reload();
      }
    }, 2000);
  } else if (query.checkout === 'cancel') {
    history.replaceState(null, '', location.pathname + '#/account');
  }

  return h('div', {}, card('Account', status, activating, actions), card('Need help?', h('p', {}, 'Email ', h('a', { href: 'mailto:projects@avalanchegr.com' }, 'projects@avalanchegr.com'), '.')));
}
