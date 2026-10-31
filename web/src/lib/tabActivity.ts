// Model: web.TabActivityMarkers. Live activity a mounted session panel reports
// for its Tab, and the pure helpers TabBar / GroupList use to turn it into a
// marker. Kept free of React so it can be unit-tested.

export type TabActivity = {
  // The agent is mid-turn (panel status === 'thinking').
  generating: boolean;
  // The agent is blocked on the user: an unanswered ask_user_question form or
  // an open permission prompt (Devin only).
  awaitingInput: boolean;
};

export type ActivityMark = 'awaiting' | 'generating';

// awaitingInput outranks generating: a question is the thing the user has to
// act on, the spinner is just status.
export function activityMark(a: TabActivity | null | undefined): ActivityMark | null {
  if (!a) return null;
  if (a.awaitingInput) return 'awaiting';
  if (a.generating) return 'generating';
  return null;
}

// Roll a Group's tabs up into one marker (rule-313): any awaiting wins,
// else any generating, else none.
export function groupActivityMark(
  tabs: ReadonlyArray<{ id: string; groupId?: string }>,
  activity: Readonly<Record<string, TabActivity>>,
  groupId: string,
  tabGroupId: (tab: { groupId?: string }) => string,
): ActivityMark | null {
  let generating = false;
  for (const t of tabs) {
    if (tabGroupId(t) !== groupId) continue;
    const a = activity[t.id];
    if (!a) continue;
    if (a.awaitingInput) return 'awaiting';
    if (a.generating) generating = true;
  }
  return generating ? 'generating' : null;
}

export function sameActivity(a: TabActivity | undefined, b: TabActivity): boolean {
  return !!a && a.generating === b.generating && a.awaitingInput === b.awaitingInput;
}
