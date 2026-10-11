// Mock of the design-rules edge function for the no-backend harness
// (?mockDesignRules=1). Runs the real check engine against the Acme demo
// design system. No site connector: choices become ready-to-do tasks.
import * as E from '../supabase/functions/_shared/designEngine.ts';
import acme from './fixtures/acme-tokens.json';

export function mockDesign({ store, user, roleOn }) {
  const ds = { tokens: structuredClone(acme), version: acme.version || '1.0.0' };
  const me = (user.email || 'guest').toLowerCase();
  const err = (status, body) => ({ data: null, error: { message: body.error, context: { status, json: async () => body } } });
  const okd = (data) => ({ data, error: null });
  const withLabel = (l) => [...new Set([...(l || []), 'design'])];

  function access(pid) {
    const r = roleOn(pid);
    const manager = r === 'collaborator' && new URLSearchParams(location.search).get('mockManager') === '1';
    const boss = r === 'operator' || r === 'owner';
    return {
      enabled: true, plan_ok: true,
      can_check: ['operator', 'owner', 'collaborator'].includes(r),
      can_approve: boss, can_except: boss || manager, can_revert: boss || manager,
      connected: false, preview_param: 'pp_preview', version: ds.version,
    };
  }
  const patch = (cid, p) => {
    const row = store.comments.find((c) => c.id === cid);
    Object.assign(row, p);
    return okd({ comment: { ...row } });
  };

  const invoke = async function invoke(body) {
    const pid = body.project_id;
    const acc = access(pid);
    const action = body.action;
    if (action === 'rules') return okd({ tokens: ds.tokens, version: ds.version, access: acc, production_version: null });
    if (!acc.can_check) return err(403, { error: 'Only project members can use design rules.' });
    if (action === 'check') return okd({ result: E.check(ds.tokens, body.request) });

    const crow = store.comments.find((c) => c.id === body.comment_id && c.project_id === pid);
    if (!crow) return err(404, { error: "That comment isn't in this project." });
    const now = new Date().toISOString();
    const approver = 'owner@example.com';

    if (action === 'decide') {
      const prev = crow.design_check;
      if (prev && !['rejected', 'exception_rejected', 'reverted'].includes(prev.state)) return err(409, { error: 'A choice is already recorded on this item.' });
      const request = { ...body.request, target: { ...(body.request.target || {}), page_path: crow.page_path } };
      const result = E.check(ds.tokens, request);
      if (body.tokens_version && body.tokens_version !== result.tokens_version) return err(409, { error: 'RULES_CHANGED', result });
      const base = { request, result: { status: result.status, rule: result.rule, message: result.message, contrast: result.contrast || null, device_note: result.device_note || null }, tokens_version: result.tokens_version, choice: body.choice, decided_by: me, decided_at: now };
      const ch = body.choice;
      if (ch === 'apply' || ch === 'closest') {
        let opt;
        if (ch === 'apply') opt = { action: result.apply || {}, value: request.value, token: result.token };
        else {
          opt = (result.options || []).find((o) => o.id === 'closest');
          if (!opt) return err(409, { error: "There's no closest approved style for this." });
          if (opt.choices) opt = { ...opt, value: body.variant, action: { ...opt.action, value: body.variant }, summary: `Use the "${body.variant}" variant.` };
        }
        const dc = { ...base, state: 'task', task: E.taskSpec(request, ch, ch === 'apply' ? null : opt, ds.tokens), option: { summary: opt.summary || null, value: opt.value || null, token: opt.token || null } };
        return patch(crow.id, { design_check: dc, labels: withLabel(crow.labels), status: 'in_progress' });
      }
      if (ch === 'exception') {
        if ((body.reason || '').trim().length < 3) return err(400, { error: 'Add a short reason for the exception.' });
        if (acc.can_except) return patch(crow.id, { design_check: { ...base, state: 'exception_logged', reason: body.reason, task: E.taskSpec(request, 'exception', null, ds.tokens) }, labels: withLabel(crow.labels), status: 'in_progress' });
        return patch(crow.id, { design_check: { ...base, state: 'exception_requested', reason: body.reason }, labels: withLabel(crow.labels), status: 'waiting', assignee_email: approver });
      }
      if (ch === 'rule_change') {
        const rc = (result.options || []).find((o) => o.id === 'rule_change');
        const scope = rc && rc.scopes.find((s) => s.id === body.scope_id);
        if (!scope) return err(400, { error: 'Pick how the rule should change.' });
        const changes = E.cleanChanges(scope.changes);
        const problem = E.hardRuleProblem(E.applyChanges(ds.tokens, changes));
        if (problem) return err(422, { error: problem });
        return patch(crow.id, { design_check: { ...base, state: 'proposal_pending', proposal: { changes, then: scope.then || null, label: scope.label }, scope: { id: scope.id, label: scope.label, impact: scope.impact || null }, affected: [] }, labels: withLabel(crow.labels), status: 'waiting', assignee_email: approver });
      }
      if (ch === 'send') return patch(crow.id, { design_check: { ...base, state: 'sent_to_team' }, labels: withLabel(crow.labels), status: 'open', assignee_email: approver });
      return err(400, { error: 'Unknown choice.' });
    }

    const dc = crow.design_check || {};
    if (action === 'approve' || action === 'reject') {
      if (!acc.can_approve) return err(403, { error: 'Only the approver can decide this.' });
      if (dc.state === 'exception_requested') {
        if (action === 'reject') return patch(crow.id, { design_check: { ...dc, state: 'exception_rejected', decided_by: me, decided_at: now }, status: 'open', assignee_email: dc.decided_by });
        return patch(crow.id, { design_check: { ...dc, state: 'exception_logged', approved_by: me, task: E.taskSpec(dc.request, 'exception', null, ds.tokens) }, status: 'in_progress', assignee_email: null });
      }
      if (dc.state !== 'proposal_pending') return err(409, { error: 'Nothing is waiting on approval here.' });
      if (action === 'reject') return patch(crow.id, { design_check: { ...dc, state: 'rejected', decided_by: me, decided_at: now }, status: 'open', assignee_email: dc.decided_by });
      ds.tokens = E.applyChanges(ds.tokens, dc.proposal.changes);
      ds.version = E.bumpVersion(ds.version);
      ds.tokens.version = ds.version;
      return patch(crow.id, { design_check: { ...dc, state: 'approved_task', approved_by: me, approved_version: ds.version, decided_at: now, task: E.taskSpec(dc.request, 'rule_change', { label: dc.proposal.label, then: dc.proposal.then }, ds.tokens) }, status: 'in_progress', assignee_email: null });
    }
    return err(400, { error: 'Unknown action.' });
  };
  invoke.access = access;
  return invoke;
}
