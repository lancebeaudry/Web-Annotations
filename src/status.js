// Feedback statuses. "Open" for counting/export purposes means open OR in
// progress; resolved and won't-fix are the closed states.
export const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
};
export const STATUS_ORDER = ['open', 'in_progress', 'resolved', 'wont_fix'];

export const isOpenStatus = (s) => s === 'open' || s === 'in_progress';
export const statusLabel = (s) => STATUS_LABEL[s] || s || 'Open';
