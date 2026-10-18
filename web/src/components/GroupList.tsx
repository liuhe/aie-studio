import { useEffect, useRef, useState } from 'react';
import type { Group, Tab } from '../types';
import { DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, tabGroupId } from '../types';

// Sidebar "Groups" view: a vertical list of the project's tab Groups only —
// tabs are not expanded here (the TabBar shows the active Group's tabs).
// Layout, top to bottom: "+ New group", then groups[] in array order (user
// Groups, drag-to-reorder), then the implicit default Group pinned last and
// shown only while it has tabs.
//
// A user Group row exposes Rename / Delete via its ⋯ menu; the default Group
// has no menu and is neither draggable nor a drop target.

type DropPos = 'before' | 'after';

export function GroupList({
  groups,
  tabs,
  activeGroupId,
  onSelectGroup,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onReorderGroups,
}: {
  groups: Group[];
  tabs: Tab[];
  activeGroupId: string;
  onSelectGroup: (groupId: string) => void;
  onCreateGroup: () => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onReorderGroups: (next: Group[]) => void;
}) {
  const [menu, setMenu] = useState<{ id: string; top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [menu]);

  const counts = new Map<string, number>();
  for (const t of tabs) {
    const gid = tabGroupId(t);
    counts.set(gid, (counts.get(gid) ?? 0) + 1);
  }
  const defaultCount = counts.get(DEFAULT_GROUP_ID) ?? 0;

  function openMenu(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ id, top: r.bottom + 2, left: Math.max(4, Math.min(r.left, window.innerWidth - 244)) });
  }

  function commitRename() {
    if (!renaming) return;
    onRenameGroup(renaming.id, renaming.value);
    setRenaming(null);
  }

  // --- drag-to-reorder (HTML5 DnD; user Groups only) ---
  function onDragOverRow(e: React.DragEvent, id: string) {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos: DropPos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (drop?.id !== id || drop.pos !== pos) setDrop({ id, pos });
  }

  function onDropRow(e: React.DragEvent, id: string) {
    e.preventDefault();
    const from = dragId;
    const target = drop?.id === id ? drop : null;
    setDragId(null);
    setDrop(null);
    if (!from || !target || from === id) return;
    const without = groups.filter((g) => g.id !== from);
    const moved = groups.find((g) => g.id === from);
    if (!moved) return;
    let idx = without.findIndex((g) => g.id === id);
    if (idx < 0) return;
    if (target.pos === 'after') idx += 1;
    const next = [...without.slice(0, idx), moved, ...without.slice(idx)];
    if (next.every((g, i) => g.id === groups[i]?.id)) return;
    onReorderGroups(next);
  }

  function endDrag() {
    setDragId(null);
    setDrop(null);
  }

  const menuGroup = menu ? groups.find((g) => g.id === menu.id) : undefined;

  function renderRow(group: Group, count: number, isDefault: boolean) {
    const isActive = group.id === activeGroupId;
    const isRenaming = renaming?.id === group.id;
    const dropCls = !isDefault && drop?.id === group.id ? `drop-${drop.pos}` : '';
    const dragCls = dragId === group.id ? 'dragging' : '';
    return (
      <div
        key={group.id}
        className={`group ${isActive ? 'active' : ''} ${dragCls} ${dropCls}`}
        draggable={!isDefault && !isRenaming}
        onDragStart={(e) => {
          if (isDefault) { e.preventDefault(); return; }
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', group.id);
          setDragId(group.id);
        }}
        onDragOver={(e) => { if (!isDefault) onDragOverRow(e, group.id); }}
        onDragLeave={() => { if (drop?.id === group.id) setDrop(null); }}
        onDrop={(e) => { if (!isDefault) onDropRow(e, group.id); }}
        onDragEnd={endDrag}
      >
        <div
          className="group-row"
          onClick={() => { if (!isRenaming) onSelectGroup(group.id); }}
          onDoubleClick={() => { if (!isDefault) setRenaming({ id: group.id, value: group.name }); }}
          title={isDefault ? 'Default group (cannot be deleted)' : group.name}
        >
          <span className="group-icon">{isDefault ? '▣' : '▢'}</span>
          {isRenaming ? (
            <input
              autoFocus
              className="group-rename"
              value={renaming!.value}
              onChange={(e) => setRenaming({ id: group.id, value: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="group-name">{group.name}</span>
          )}
          <span className="group-count">{count}</span>
          {!isDefault && !isRenaming && (
            <button
              className="group-menu-btn"
              onClick={(e) => openMenu(e, group.id)}
              title="Group menu"
              aria-label="Group menu"
            >⋯</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group-list">
      <div className="group-add" onClick={onCreateGroup}>+ New group</div>
      {groups.map((g) => renderRow(g, counts.get(g.id) ?? 0, false))}
      {defaultCount > 0 && renderRow({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME }, defaultCount, true)}
      {groups.length === 0 && defaultCount === 0 && (
        <div className="empty">No groups yet — new tabs go to "{DEFAULT_GROUP_NAME}"</div>
      )}

      {menu && menuGroup && (
        <div
          ref={menuRef}
          className="tab-overflow-menu"
          style={{ top: menu.top, left: menu.left }}
        >
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); setRenaming({ id: menuGroup.id, value: menuGroup.name }); }}
          >✎ Rename group</button>
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); onDeleteGroup(menuGroup.id); }}
          >🗑 Delete group…</button>
        </div>
      )}
    </div>
  );
}
