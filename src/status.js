// Feedback statuses. "Open" for counting/export purposes means open, in
// progress, or waiting on the client; resolved and won't-fix are the closed
// states.
export const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In progress',
  waiting: 'Waiting on client',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
};
export const STATUS_ORDER = ['open', 'in_progress', 'waiting', 'resolved', 'wont_fix'];

export const isOpenStatus = (s) => s === 'open' || s === 'in_progress' || s === 'waiting';
export const statusLabel = (s) => STATUS_LABEL[s] || s || 'Open';

// Triage labels: what kind of item it is. Any combination.
export const LABEL_TEXT = {
  bug: 'Bug',
  copy: 'Copy',
  design: 'Design',
  content: 'Content needed',
  photo: 'Photo needed',
  decision: 'Decision',
};
export const LABEL_ORDER = ['bug', 'copy', 'design', 'content', 'photo', 'decision'];
export const labelText = (l) => LABEL_TEXT[l] || l;

// Effort: how big the change is.
export const EFFORT_TEXT = { quick: 'Quick', medium: 'Medium', large: 'Large' };
export const EFFORT_ORDER = ['quick', 'medium', 'large'];
export const effortText = (e) => EFFORT_TEXT[e] || '';
