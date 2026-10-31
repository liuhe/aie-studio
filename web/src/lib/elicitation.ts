// ACP form-mode elicitation (model: web.ElicitationForm). Devin's
// ask_user_question arrives as an agent→client `elicitation/create` request
// whose requestedSchema is a flat object with one property per question:
//   single-select: { type: 'string', title, description, oneOf: [{ const, title }] }
//   multi-select:  { type: 'array', title, description, items: { anyOf: [{ const, title }] } }
// `const` is the option label the model chose; `title` is its description.
// Values outside the enum are accepted by Devin when _meta allowOther is set
// (observed default: true), which is how the trailing "Other" free text works.

export type ElicitationOption = { value: string; description?: string };

export type ElicitationQuestion = {
  key: string;
  header: string;
  question: string;
  multi: boolean;
  options: ElicitationOption[];
  required: boolean;
};

export type ElicitationRequest = {
  id: number | string;
  sessionId?: string;
  toolCallId?: string;
  message?: string;
  allowOther: boolean;
  questions: ElicitationQuestion[];
};

// Per-question draft: chosen option values plus the Other free text. `other`
// being non-null means the Other option is selected (text may still be empty).
// `skipped` is the per-question skip. ACP has no skipped flag: a *missing* key
// makes Devin reject the whole call as "user wants to clarify", `null` fails
// to deserialize, and any string is read as Other free text. So a skipped
// question is sent with the key present and SKIPPED_VALUE as its text, which
// completes normally and reads unambiguously in the tool result
// ("Colour: (skipped)") — an empty string would look like blank custom input.
export type ElicitationAnswer = { selected: string[]; other: string | null; skipped: boolean };
export const SKIPPED_VALUE = '(skipped)';

function optionsFrom(list: unknown): ElicitationOption[] {
  if (!Array.isArray(list)) return [];
  const out: ElicitationOption[] = [];
  for (const o of list) {
    if (typeof o === 'string') out.push({ value: o });
    else if (o && typeof o === 'object' && typeof (o as any).const === 'string') {
      const { const: value, title } = o as { const: string; title?: unknown };
      out.push({ value, description: typeof title === 'string' && title !== value ? title : undefined });
    }
  }
  return out;
}

export function parseElicitationRequest(msg: any): ElicitationRequest | null {
  if (!msg || msg.method !== 'elicitation/create' || typeof msg.id === 'undefined') return null;
  const params = msg.params ?? {};
  if (params.mode && params.mode !== 'form') return null;
  const schema = params.requestedSchema ?? {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const meta = params._meta ?? {};
  const questions: ElicitationQuestion[] = Object.entries<any>(props).map(([key, p]) => {
    const multi = p?.type === 'array';
    const options = multi
      ? optionsFrom(p.items?.anyOf ?? p.items?.oneOf ?? p.items?.enum)
      : optionsFrom(p?.oneOf ?? p?.anyOf ?? p?.enum);
    return {
      key,
      header: typeof p?.title === 'string' ? p.title : key,
      question: typeof p?.description === 'string' ? p.description : '',
      multi,
      options,
      required: required.has(key),
    };
  });
  return {
    id: msg.id,
    sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
    toolCallId: typeof meta['cognition.ai/toolCallId'] === 'string' ? meta['cognition.ai/toolCallId'] : undefined,
    message: typeof params.message === 'string' ? params.message : undefined,
    allowOther: meta['cognition.ai/allowOther'] !== false,
    questions,
  };
}

export function emptyAnswers(req: ElicitationRequest): Record<string, ElicitationAnswer> {
  const out: Record<string, ElicitationAnswer> = {};
  for (const q of req.questions) out[q.key] = { selected: [], other: q.options.length === 0 ? '' : null, skipped: false };
  return out;
}

// Toggle an option: single-select replaces, multi-select flips. Picking a
// listed option on a single-select also drops Other.
export function toggleOption(q: ElicitationQuestion, a: ElicitationAnswer, value: string): ElicitationAnswer {
  if (q.multi) {
    const selected = a.selected.includes(value) ? a.selected.filter((v) => v !== value) : [...a.selected, value];
    return { ...a, selected, skipped: false };
  }
  return { selected: a.selected[0] === value ? [] : [value], other: null, skipped: false };
}

export function toggleOther(q: ElicitationQuestion, a: ElicitationAnswer): ElicitationAnswer {
  if (a.other !== null) return { ...a, other: null };
  return { selected: q.multi ? a.selected : [], other: '', skipped: false };
}

// Per-question skip. Skipping clears any draft; un-skipping returns to blank.
export function toggleSkip(q: ElicitationQuestion, a: ElicitationAnswer): ElicitationAnswer {
  if (a.skipped) return { selected: [], other: q.options.length === 0 ? '' : null, skipped: false };
  return { selected: [], other: null, skipped: true };
}

// A question is answered when it has a listed selection or non-blank Other text.
export function isAnswered(a: ElicitationAnswer | undefined): boolean {
  if (!a) return false;
  return a.selected.length > 0 || (a.other !== null && a.other.trim().length > 0);
}

// Required questions neither answered nor skipped — what still blocks Submit.
export function unansweredRequired(req: ElicitationRequest, answers: Record<string, ElicitationAnswer>): number {
  return req.questions.filter((q) => q.required && !isAnswered(answers[q.key]) && !answers[q.key]?.skipped).length;
}

// Submit needs every required question either answered or explicitly skipped.
export function canSubmit(req: ElicitationRequest, answers: Record<string, ElicitationAnswer>): boolean {
  return unansweredRequired(req, answers) === 0;
}

// Build the ElicitResult `content` object. Single-select → string, multi →
// string[]; Other text is sent verbatim as a value. Skipped (or blank
// optional) questions keep their key with SKIPPED_VALUE — see ElicitationAnswer.
export function buildContent(req: ElicitationRequest, answers: Record<string, ElicitationAnswer>): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {};
  for (const q of req.questions) {
    const a = answers[q.key];
    if (!isAnswered(a)) { content[q.key] = q.multi ? [SKIPPED_VALUE] : SKIPPED_VALUE; continue; }
    const values = [...a!.selected];
    if (a!.other !== null && a!.other.trim()) values.push(a!.other.trim());
    content[q.key] = q.multi ? values : values[0];
  }
  return content;
}

// Model: web.ElicitationForm rule-318 — images ride on a follow-up prompt, so
// tell the model to expect it. Appended to the first question that has Other
// text; with no Other text anywhere the content is left untouched so a clean
// enum choice doesn't turn into custom text.
export const ATTACHMENT_HINT = ' (details attached in the next message)';
export function appendAttachmentHint(req: ElicitationRequest, answers: Record<string, ElicitationAnswer>): Record<string, ElicitationAnswer> {
  for (const q of req.questions) {
    const a = answers[q.key];
    if (!a || a.skipped || a.other === null || !a.other.trim()) continue;
    if (a.other.trimEnd().endsWith(ATTACHMENT_HINT.trim())) return answers;
    return { ...answers, [q.key]: { ...a, other: a.other.trimEnd() + ATTACHMENT_HINT } };
  }
  return answers;
}

// Human-readable recap shown in place of the form once answered.
export function summarizeAnswers(req: ElicitationRequest, content: Record<string, string | string[]>): string {
  return req.questions
    .map((q) => {
      const v = content[q.key];
      const text = Array.isArray(v) ? v.join(', ') : v;
      return `${q.header}: ${text || SKIPPED_VALUE}`;
    })
    .join('\n');
}

// Bind each elicitation to the tool_call card it belongs to. Newer CLIs name
// the card via _meta toolCallId; older ones (3000.6.x) don't, so unbound
// requests are paired positionally with ask_user_question cards (rawInput has
// `questions`) that no explicit binding already claimed, aligned from the end —
// elicitation state is per page-load while cards may come from the DB history.
export function bindElicitationsToCards(
  elicitations: ReadonlyArray<{ id: number | string; toolCallId?: string }>,
  cards: ReadonlyArray<{ toolCallId: string; rawInput?: any }>,
): Map<number | string, string> {
  const out = new Map<number | string, string>();
  const claimed = new Set<string>();
  const unbound: Array<number | string> = [];
  for (const e of elicitations) {
    if (e.toolCallId) { out.set(e.id, e.toolCallId); claimed.add(e.toolCallId); }
    else unbound.push(e.id);
  }
  if (unbound.length === 0) return out;
  const candidates = cards
    .filter((c) => Array.isArray(c.rawInput?.questions) && !claimed.has(c.toolCallId))
    .map((c) => c.toolCallId);
  const tail = candidates.slice(Math.max(0, candidates.length - unbound.length));
  const offset = unbound.length - tail.length;
  tail.forEach((toolCallId, i) => out.set(unbound[offset + i], toolCallId));
  return out;
}

// Claude's AskUserQuestion (model: web.ElicitationForm rule-303b). The bare
// CLI, launched with --permission-prompt-tool stdio, surfaces the tool as a
// `control_request` on stdout and blocks until we answer:
//   { type:'control_request', request_id, request:{ subtype:'can_use_tool',
//     tool_name:'AskUserQuestion', input:{ questions:[{ question, header,
//     options:[{ label, description }], multiSelect }] }, tool_use_id } }
// Same ElicitationRequest shape as Devin's form so the rest of the pipeline
// (form, lock, recap, binding) is shared. toolCallId is always present, so
// bindElicitationsToCards never needs the positional fallback here.
export function parseAskUserQuestion(ev: any): ElicitationRequest | null {
  if (ev?.type !== 'control_request' || typeof ev.request_id !== 'string') return null;
  const r = ev.request;
  if (r?.subtype !== 'can_use_tool' || r.tool_name !== 'AskUserQuestion') return null;
  const list: unknown[] = Array.isArray(r.input?.questions) ? r.input.questions : [];
  const questions: ElicitationQuestion[] = list.map((raw, i) => {
    const q = (raw ?? {}) as any;
    const options: ElicitationOption[] = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (typeof o?.label !== 'string') continue;
      options.push({ value: o.label, description: typeof o.description === 'string' && o.description !== o.label ? o.description : undefined });
    }
    return {
      key: `q${i}`,
      header: typeof q.header === 'string' && q.header ? q.header : `Question ${i + 1}`,
      question: typeof q.question === 'string' ? q.question : '',
      multi: q.multiSelect === true,
      options,
      required: true,
    };
  });
  if (questions.length === 0) return null;
  return {
    id: ev.request_id,
    toolCallId: typeof r.tool_use_id === 'string' ? r.tool_use_id : undefined,
    allowOther: true,
    questions,
  };
}

// Turn the form's content into the `answers` map claude expects back in
// updatedInput (rule-305b): keyed by the question text, one string per
// question, multi-select labels joined with ", " — the CLI writes it into
// the tool_result verbatim ("<q>"="<a>").
export function claudeAnswersFrom(req: ElicitationRequest, content: Record<string, string | string[]>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of req.questions) {
    const v = content[q.key];
    answers[q.question] = Array.isArray(v) ? v.join(', ') : (v ?? SKIPPED_VALUE);
  }
  return answers;
}
