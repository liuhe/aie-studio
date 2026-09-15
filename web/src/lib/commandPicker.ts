// Pure helpers behind the "/" command picker in ChatInput (model: web.CommandPicker).
// Kept free of React/DOM so the trigger + filter rules are unit-testable.
import type { AieAgent, AieSkill } from '../api';
import {
  BUNDLED_AGENT_DESCRIPTIONS, BUNDLED_SKILL_DESCRIPTIONS, CLAUDE_BUILTIN_COMMANDS, type ClaudeCliCatalog,
} from './claudeCatalog';

export type CommandItem = {
  // Popover section header. Sections keep the order in which they first
  // appear in the item list (see filterCommands).
  group: string;
  name: string;
  // What the row shows: "/name" for slash commands, bare name for agents.
  label: string;
  description: string;
  // Text that replaces the "/query" token when the item is picked.
  insert: string;
};

export const SKILLS_GROUP = 'Skills';
export const AGENTS_GROUP = 'Agents';
export const COMMANDS_GROUP = 'Commands';

// Agents are invoked by natural-language instruction, never "@name": claude
// CLI treats "@path" as a file reference and would try to read a file.
export function agentInsertText(name: string): string {
  return `使用 ${name} subagent：`;
}

function skillItem(name: string, description: string): CommandItem {
  return { group: SKILLS_GROUP, name, label: `/${name}`, description, insert: `/${name} ` };
}
function agentItem(name: string, description: string): CommandItem {
  return { group: AGENTS_GROUP, name, label: name, description, insert: agentInsertText(name) };
}

// Claude sessions. Three groups:
//  - Skills: project skills scanned from .claude/skills (server.ListSkills,
//    with descriptions) ∪ CLI-bundled skills from the init catalog (static
//    descriptions where known). Terminal-only commands are dropped.
//  - Agents: project agents (server.ListAgents) ∪ CLI-bundled agents.
//  - Commands: the verified built-in allowlist. Gated by the live catalog
//    when we have one (a CLI that drops a command drops it here too); shown
//    in full when the catalog is unknown — claude only reports it after the
//    first prompt, and the built-ins are stable enough to list blind.
// Without a catalog, bundled skills/agents can't be known, so only project
// entries plus the Commands group show.
export function toCommandItems(
  skills: AieSkill[],
  agents: AieAgent[],
  catalog?: ClaudeCliCatalog | null,
): CommandItem[] {
  const items: CommandItem[] = [];
  const skillNames = new Set(skills.map((s) => s.name));
  const agentNames = new Set(agents.map((a) => a.name));
  const terminalOnly = new Set(catalog?.terminalSlashCommands ?? []);

  for (const s of skills) items.push(skillItem(s.name, s.description));
  for (const name of catalog?.skills ?? []) {
    if (skillNames.has(name) || terminalOnly.has(name)) continue;
    skillNames.add(name);
    items.push(skillItem(name, BUNDLED_SKILL_DESCRIPTIONS[name] ?? ''));
  }
  for (const a of agents) items.push(agentItem(a.name, a.description));
  for (const name of catalog?.agents ?? []) {
    if (agentNames.has(name)) continue;
    agentNames.add(name);
    items.push(agentItem(name, BUNDLED_AGENT_DESCRIPTIONS[name] ?? ''));
  }
  const live = catalog ? new Set(catalog.slashCommands) : null;
  for (const c of CLAUDE_BUILTIN_COMMANDS) {
    if ((live && !live.has(c.name)) || terminalOnly.has(c.name)) continue;
    items.push({
      group: COMMANDS_GROUP,
      name: c.name,
      label: c.hint ? `/${c.name} ${c.hint}` : `/${c.name}`,
      description: c.description,
      insert: `/${c.name} `,
    });
  }
  return items;
}

// Shape of one entry in ACP's `available_commands_update` notification.
export type AcpAvailableCommand = {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
  _meta?: Record<string, unknown>;
};

// Devin sessions: the agent advertises its slash commands over ACP (built-ins
// plus every skill dir it reads, .claude/skills included). Devin tags each
// with a category; skills go first, the rest keep the agent's order. Devin's
// subagents are profile-based (not .claude/agents), so there is no Agents group.
export function acpCommandsToItems(cmds: AcpAvailableCommand[]): CommandItem[] {
  const items = cmds.map<CommandItem>((c) => {
    const category = c._meta?.['cognition.ai/category'];
    const hint = c.input?.hint;
    return {
      group: typeof category === 'string' && category ? category : SKILLS_GROUP,
      name: c.name,
      label: hint ? `/${c.name} ${hint}` : `/${c.name}`,
      description: c.description ?? '',
      insert: `/${c.name} `,
    };
  });
  const skills = items.filter((i) => i.group === SKILLS_GROUP);
  const rest = items.filter((i) => i.group !== SKILLS_GROUP);
  return [...skills, ...rest];
}

// The picker only triggers when the message *starts* with "/" and the cursor
// is still inside that first token (same rule as Claude Code's CLI). Returns
// the query after "/" or null when the picker should be closed.
export function matchCommandQuery(textBeforeCursor: string): string | null {
  const m = /^\/(\S*)$/.exec(textBeforeCursor);
  return m ? m[1] : null;
}

// Prefix matches first, then substring matches; groups in first-appearance
// order; stable by name inside each bucket. Empty query lists everything.
export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  const q = query.toLowerCase();
  const groupRank = new Map<string, number>();
  for (const it of items) if (!groupRank.has(it.group)) groupRank.set(it.group, groupRank.size);
  const scored: { it: CommandItem; s: number }[] = [];
  for (const it of items) {
    const n = it.name.toLowerCase();
    const s = !q ? 0 : n.startsWith(q) ? 0 : n.includes(q) ? 1 : -1;
    if (s >= 0) scored.push({ it, s });
  }
  scored.sort(
    (a, b) =>
      groupRank.get(a.it.group)! - groupRank.get(b.it.group)! ||
      a.s - b.s ||
      a.it.name.localeCompare(b.it.name),
  );
  return scored.map((x) => x.it);
}
