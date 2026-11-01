import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_HINT, appendAttachmentHint, bindElicitationsToCards, claudeAnswersFrom, unansweredRequired, buildContent, canSubmit, emptyAnswers, parseAskUserQuestion, parseElicitationRequest, summarizeAnswers, toggleOption, toggleOther, toggleSkip,
} from '../elicitation';

// Verbatim shape observed from `devin acp` 3000.11.228 for a 2-question ask_user_question.
const REQ = {
  jsonrpc: '2.0',
  id: '677a2b14-d69a-4d4e-9776-90782088f9d8',
  method: 'elicitation/create',
  params: {
    mode: 'form',
    sessionId: 'languid-armadillo',
    requestedSchema: {
      type: 'object',
      properties: {
        q0: {
          type: 'string', title: 'Colour', description: 'Which colour?',
          oneOf: [{ const: 'Red', title: 'Red colour' }, { const: 'Green', title: 'Green colour' }],
        },
        q1: {
          type: 'array', title: 'Fruits', description: 'Which fruits?', minItems: 1,
          items: { anyOf: [{ const: 'Apple', title: 'Apple fruit' }, { const: 'Banana', title: 'Banana' }] },
        },
      },
      required: ['q0', 'q1'],
    },
    message: 'Which colour?',
    _meta: { 'cognition.ai/allowOther': true, 'cognition.ai/toolCallId': 'toolu_01' },
  },
};

describe('parseElicitationRequest', () => {
  it('maps schema properties to questions in order', () => {
    const r = parseElicitationRequest(REQ)!;
    expect(r.id).toBe(REQ.id);
    expect(r.toolCallId).toBe('toolu_01');
    expect(r.allowOther).toBe(true);
    expect(r.questions.map((q) => q.key)).toEqual(['q0', 'q1']);
    expect(r.questions[0]).toMatchObject({ header: 'Colour', question: 'Which colour?', multi: false, required: true });
    expect(r.questions[0].options).toEqual([
      { value: 'Red', description: 'Red colour' }, { value: 'Green', description: 'Green colour' },
    ]);
    expect(r.questions[1].multi).toBe(true);
    // title identical to const → no redundant description
    expect(r.questions[1].options[1]).toEqual({ value: 'Banana', description: undefined });
  });
  it('rejects non-form / non-elicitation messages', () => {
    expect(parseElicitationRequest({ method: 'session/request_permission', id: 1 })).toBeNull();
    expect(parseElicitationRequest({ ...REQ, params: { ...REQ.params, mode: 'url' } })).toBeNull();
    expect(parseElicitationRequest({ method: 'elicitation/create' })).toBeNull();
  });
  it('tolerates a bare string property (free text only) and enum arrays', () => {
    const r = parseElicitationRequest({
      id: 1, method: 'elicitation/create',
      params: { requestedSchema: { properties: { name: { type: 'string', title: 'Name' }, pick: { type: 'string', enum: ['a', 'b'] } } } },
    })!;
    expect(r.questions[0].options).toEqual([]);
    expect(r.questions[1].options).toEqual([{ value: 'a' }, { value: 'b' }]);
    expect(r.questions[0].required).toBe(false);
    expect(emptyAnswers(r).name.other).toBe(''); // free-text question opens its box immediately
  });
});

describe('answer editing + submit', () => {
  const r = parseElicitationRequest(REQ)!;
  const [single, multi] = r.questions;

  it('single-select replaces and clears Other; multi toggles', () => {
    let a = emptyAnswers(r).q0;
    a = toggleOther(single, a); a = { ...a, other: 'custom' };
    a = toggleOption(single, a, 'Red');
    expect(a).toEqual({ selected: ['Red'], other: null, skipped: false });
    a = toggleOption(single, a, 'Red');
    expect(a.selected).toEqual([]);

    let b = emptyAnswers(r).q1;
    b = toggleOption(multi, b, 'Apple'); b = toggleOption(multi, b, 'Banana'); b = toggleOption(multi, b, 'Apple');
    expect(b.selected).toEqual(['Banana']);
    b = toggleOther(multi, b);
    expect(b).toEqual({ selected: ['Banana'], other: '', skipped: false });
  });

  it('per-question skip satisfies required and sends the (skipped) marker, never a missing key or null', () => {
    const answers = emptyAnswers(r);
    answers.q0 = toggleSkip(single, answers.q0);
    expect(answers.q0.skipped).toBe(true);
    expect(canSubmit(r, answers)).toBe(false); // q1 still open
    answers.q1 = toggleOption(multi, answers.q1, 'Apple');
    expect(canSubmit(r, answers)).toBe(true);
    const content = buildContent(r, answers);
    expect(Object.keys(content)).toEqual(['q0', 'q1']);
    expect(content).toEqual({ q0: '(skipped)', q1: ['Apple'] });
    expect(summarizeAnswers(r, content)).toBe('Colour: (skipped)\nFruits: Apple');
    // picking an option un-skips; skipping a multi yields []
    expect(toggleOption(single, answers.q0, 'Red').skipped).toBe(false);
    expect(buildContent(r, { ...answers, q1: toggleSkip(multi, answers.q1) }).q1).toEqual(['(skipped)']);
  });

  it('requires every required question before submit; Other needs non-blank text', () => {
    const answers = emptyAnswers(r);
    expect(canSubmit(r, answers)).toBe(false);
    answers.q0 = toggleOption(single, answers.q0, 'Green');
    answers.q1 = { selected: [], other: '   ', skipped: false };
    expect(canSubmit(r, answers)).toBe(false);
    answers.q1 = { selected: [], other: ' mango ', skipped: false };
    expect(canSubmit(r, answers)).toBe(true);
    expect(buildContent(r, answers)).toEqual({ q0: 'Green', q1: ['mango'] });
  });

  it('multi-select appends Other text after listed picks; summary is one line per question', () => {
    const answers = emptyAnswers(r);
    answers.q0 = { selected: [], other: 'Teal', skipped: false };
    answers.q1 = { selected: ['Apple'], other: 'Cherry', skipped: false };
    const content = buildContent(r, answers);
    expect(content).toEqual({ q0: 'Teal', q1: ['Apple', 'Cherry'] });
    expect(summarizeAnswers(r, content)).toBe('Colour: Teal\nFruits: Apple, Cherry');
  });
});

describe('bindElicitationsToCards', () => {
  const cards = [
    { toolCallId: 'read1', rawInput: { path: 'x' } },
    { toolCallId: 'ask1', rawInput: { questions: [{}] } },
    { toolCallId: 'ask2', rawInput: { questions: [{}] } },
    { toolCallId: 'ask3', rawInput: { questions: [{}] } },
  ];
  it('uses explicit toolCallId when present', () => {
    const m = bindElicitationsToCards([{ id: 'e1', toolCallId: 'ask3' }], cards);
    expect(m.get('e1')).toBe('ask3');
  });
  it('pairs unbound requests with trailing ask cards in order (3000.6.x has no _meta toolCallId)', () => {
    const m = bindElicitationsToCards([{ id: 'e1' }, { id: 'e2' }], cards);
    expect(m.get('e1')).toBe('ask2');
    expect(m.get('e2')).toBe('ask3');
  });
  it('skips cards already claimed explicitly and leaves surplus requests unbound', () => {
    const m = bindElicitationsToCards([{ id: 'e0', toolCallId: 'ask3' }, { id: 'e1' }], cards);
    expect(m.get('e1')).toBe('ask2');
    const m2 = bindElicitationsToCards([{ id: 'a' }, { id: 'b' }], [cards[3]]);
    expect(m2.has('a')).toBe(false);
    expect(m2.get('b')).toBe('ask3');
  });
});

describe('appendAttachmentHint (rule-318)', () => {
  const req = parseElicitationRequest({
    jsonrpc: '2.0', id: 'x', method: 'elicitation/create',
    params: { sessionId: 's', mode: 'form', message: 'm', requestedSchema: { type: 'object', required: ['q0', 'q1'], properties: {
      q0: { type: 'string', title: 'Color', oneOf: [{ const: 'red', title: 'red' }, { const: 'blue', title: 'blue' }] },
      q1: { type: 'string', title: 'Size', oneOf: [{ const: 's', title: 's' }, { const: 'l', title: 'l' }] },
    } }, _meta: { 'cognition.ai/allowOther': true } },
  })!;
  it('appends to the first question with Other text and leaves the rest alone', () => {
    const answers = { q0: { selected: ['red'], other: null, skipped: false }, q1: { selected: [], other: 'medium ', skipped: false } };
    const out = appendAttachmentHint(req, answers);
    expect(out.q0).toBe(answers.q0);
    expect(out.q1.other).toBe('medium' + ATTACHMENT_HINT);
  });
  it('does not touch content when no question has Other text', () => {
    const answers = { q0: { selected: ['red'], other: null, skipped: false }, q1: { selected: ['s'], other: null, skipped: false } };
    expect(appendAttachmentHint(req, answers)).toBe(answers);
  });
  it('is idempotent', () => {
    const answers = { q0: { selected: [], other: 'x' + ATTACHMENT_HINT, skipped: false }, q1: { selected: ['s'], other: null, skipped: false } };
    expect(appendAttachmentHint(req, answers)).toBe(answers);
  });
});

describe('unansweredRequired', () => {
  const req = parseElicitationRequest(REQ)!;
  it('counts required questions that are neither answered nor skipped', () => {
    const a = emptyAnswers(req);
    expect(unansweredRequired(req, a)).toBe(req.questions.length);
    const first = req.questions[0];
    const second = req.questions[1];
    const partly = { ...a, [first.key]: { selected: [first.options[0].value], other: null, skipped: false } };
    expect(unansweredRequired(req, partly)).toBe(req.questions.length - 1);
    const done = { ...partly, [second.key]: { selected: [], other: null, skipped: true } };
    expect(unansweredRequired(req, done)).toBe(0);
  });
});

// Verbatim shape from claude CLI 2.1.312 (-p --permission-prompt-tool stdio).
const CLAUDE_REQ = {
  type: 'control_request',
  request_id: '59b3c8e0-008f-4f90-964b-a03563824b74',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    display_name: 'AskUserQuestion',
    input: {
      questions: [
        { question: 'Do you prefer option A or option B?', header: 'A or B', options: [{ label: 'Option A', description: 'Choose option A' }, { label: 'Option B', description: 'Option B' }], multiSelect: false },
        { question: 'Which fruits do you like?', header: 'Fruits', options: [{ label: 'Apple', description: 'Apple' }, { label: 'Banana', description: 'Banana' }], multiSelect: true },
      ],
    },
    tool_use_id: 'toolu_01RygUBnZQrx8Yx7CJvCRabZ',
    requires_user_interaction: true,
  },
};

describe('parseAskUserQuestion', () => {
  it('maps the control_request to the shared request shape', () => {
    const r = parseAskUserQuestion(CLAUDE_REQ)!;
    expect(r.id).toBe(CLAUDE_REQ.request_id);
    expect(r.toolCallId).toBe('toolu_01RygUBnZQrx8Yx7CJvCRabZ');
    expect(r.allowOther).toBe(true);
    expect(r.questions.map((q) => q.key)).toEqual(['q0', 'q1']);
    expect(r.questions[0]).toMatchObject({ header: 'A or B', question: 'Do you prefer option A or option B?', multi: false, required: true });
    expect(r.questions[0].options).toEqual([{ value: 'Option A', description: 'Choose option A' }, { value: 'Option B', description: undefined }]);
    expect(r.questions[1].multi).toBe(true);
  });
  it('ignores other control requests and tools', () => {
    expect(parseAskUserQuestion({ type: 'control_response', request_id: 'x' })).toBeNull();
    expect(parseAskUserQuestion({ ...CLAUDE_REQ, request: { ...CLAUDE_REQ.request, tool_name: 'Bash' } })).toBeNull();
    expect(parseAskUserQuestion({ ...CLAUDE_REQ, request: { ...CLAUDE_REQ.request, subtype: 'hook_callback' } })).toBeNull();
    expect(parseAskUserQuestion({ ...CLAUDE_REQ, request: { ...CLAUDE_REQ.request, input: { questions: [] } } })).toBeNull();
  });
  it('binds to its tool card by tool_use_id without the positional fallback', () => {
    const r = parseAskUserQuestion(CLAUDE_REQ)!;
    const map = bindElicitationsToCards([{ id: r.id, toolCallId: r.toolCallId }], [{ toolCallId: 'other' }, { toolCallId: r.toolCallId! }]);
    expect(map.get(r.id)).toBe(r.toolCallId);
  });
});

describe('claudeAnswersFrom', () => {
  it('keys by question text, joins multi-select with ", ", keeps (skipped)', () => {
    const r = parseAskUserQuestion(CLAUDE_REQ)!;
    let a = emptyAnswers(r);
    a = { ...a, q0: toggleOption(r.questions[0], a.q0, 'Option B') };
    a = { ...a, q1: toggleOption(r.questions[1], a.q1, 'Apple') };
    a = { ...a, q1: toggleOther(r.questions[1], a.q1) };
    a = { ...a, q1: { ...a.q1, other: 'Mango' } };
    expect(claudeAnswersFrom(r, buildContent(r, a))).toEqual({
      'Do you prefer option A or option B?': 'Option B',
      'Which fruits do you like?': 'Apple, Mango',
    });
    const skipped = { ...emptyAnswers(r), q0: toggleSkip(r.questions[0], emptyAnswers(r).q0) };
    expect(claudeAnswersFrom(r, buildContent(r, skipped))['Do you prefer option A or option B?']).toBe('(skipped)');
  });
});
