// Normalized message shape that both ChatPanel (Claude) and DevinPanel feed into
// the export pipeline. Keep this independent of either panel's internal Msg type
// so the export layer doesn't need to know about ACP / stream-json semantics.

export type ExportMessage =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'system'; text: string }
  | {
      kind: 'tool';
      name: string;
      title?: string;
      input: unknown;
      output?: string;
    };

export type ExportSource = 'claude' | 'devin';
export type ExportFormat = 'markdown' | 'pdf' | 'png';

export type ExportMeta = {
  source: ExportSource;
  title?: string;
  // ISO timestamp; defaults to now if omitted.
  exportedAt?: string;
};
