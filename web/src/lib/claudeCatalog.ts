// Static knowledge about what the Claude CLI ships with, used by the "/"
// picker (model: web.CommandPicker). Names are always taken from the live
// `system.init` catalog (server → started.cliCatalog); these tables only add
// descriptions and gate which built-in commands we dare to list.

// Shape of the init-derived catalog the server caches per session.
export type ClaudeCliCatalog = {
  slashCommands: string[];
  skills: string[];
  agents: string[];
  terminalSlashCommands: string[];
};

// Built-in commands verified (2026-09-13, claude 2.1.269) to execute over
// `-p --input-format stream-json`, which is how remote-ide drives the CLI.
// Not listed on purpose: /help and /status ("isn't available in this
// environment"), /fast (Agent SDK unsupported), /exit (kills the session).
// Only entries also present in the live catalog are shown.
export const CLAUDE_BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string; hint?: string }> = [
  { name: 'context', description: 'Show context window usage' },
  { name: 'cost', description: 'Show usage for the current session' },
  { name: 'usage', description: 'Show subscription usage limits' },
  { name: 'model', description: 'Show or switch the model', hint: '[name]' },
  { name: 'effort', description: 'Set reasoning effort', hint: '<low|medium|high|xhigh|max|auto>' },
  { name: 'compact', description: 'Compact the conversation to free context', hint: '[instructions]' },
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'recap', description: 'Summarize the session so far' },
  { name: 'rename', description: 'Rename this session', hint: '<title>' },
  { name: 'mcp', description: 'List or manage MCP servers' },
];

// Descriptions for skills bundled with the CLI. The binary embeds them but not
// in a form worth parsing at runtime; unknown names still get listed, just
// without a description.
export const BUNDLED_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'deep-research': 'Deep research harness — fan-out web searches, fetch sources, verify claims, synthesize a cited report',
  design: 'Design a feature or change before implementing it',
  'design-sync': 'Sync a design document with the current code',
  dataviz: 'Guidance for charts, graphs, dashboards and data visualizations',
  'update-config': 'Configure Claude Code settings, permissions, env vars and hooks',
  verify: 'Verify that a change works as intended',
  debug: 'Systematically debug a problem',
  'code-review': 'Review a diff, PR or branch for bugs and cleanups',
  simplify: 'Review changed code for reuse, simplification and efficiency, then apply fixes',
  batch: 'Run a repetitive change across many files or targets',
  'fewer-permission-prompts': 'Add an allowlist of common read-only commands to reduce permission prompts',
  loop: 'Run a prompt or slash command on a recurring interval',
  schedule: 'Create, update or run scheduled cloud agents (routines)',
  'claude-api': 'Reference for the Claude API / Anthropic SDK',
  'workflow-authoring': 'Reference for writing Workflow tool scripts',
  run: "Launch and drive this project's app to see a change working",
  'run-skill-generator': 'Generate a project-specific run skill',
  'keybindings-help': 'Customize keyboard shortcuts',
  init: 'Initialize a CLAUDE.md file with codebase documentation',
  'security-review': 'Security review of the pending changes on the current branch',
};

// Descriptions for agents bundled with the CLI (project agents come with
// their own description from .claude/agents/*.md).
export const BUNDLED_AGENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  claude: 'Default catch-all agent',
  Explore: 'Read-only search agent for broad codebase exploration',
  'general-purpose': 'General-purpose agent for research and multi-step tasks',
  Plan: 'Software architect agent that designs implementation plans',
  'statusline-setup': 'Configure the status line',
};
