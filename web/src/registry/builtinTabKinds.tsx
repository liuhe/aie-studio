import { Viewer } from '../components/Viewer';
import { ChatPanel } from '../components/ChatPanel';
import { DevinPanel } from '../components/DevinPanel';
import type { Tab, DevinTab, SessionTab, FileTab } from '../types';
import { registerTabKind } from './tabRegistry';

function shortId() { return Math.random().toString(36).slice(2, 10); }

// Type-narrow helpers so each render body can trust the tab shape without
// re-checking the discriminator. Registry dispatch keys on tab.type, so if a
// mismatch ever happens it's a registration bug — assert to fail loud.
function asFile(tab: Tab): FileTab {
  if (tab.type !== 'file') throw new Error(`tabRegistry: expected file tab, got ${tab.type}`);
  return tab;
}
function asSession(tab: Tab): SessionTab {
  if (tab.type !== 'session') throw new Error(`tabRegistry: expected session tab, got ${tab.type}`);
  return tab;
}
function asDevin(tab: Tab): DevinTab {
  if (tab.type !== 'devin') throw new Error(`tabRegistry: expected devin tab, got ${tab.type}`);
  return tab;
}

registerTabKind({
  id: 'file',
  label: 'File',
  render: ({ tab, project, settings }) => {
    const t = asFile(tab);
    return <Viewer projectId={project.id} file={{ path: t.path }} theme={settings.theme} />;
  },
});

registerTabKind({
  id: 'session',
  label: 'Claude',
  render: ({ tab, project, settings, updateTabs, registerExportApi, openTab, toggleBookmark, bookmarkedAnchors, registerLocator }) => {
    const t = asSession(tab);
    return (
      <ChatPanel
        projectId={project.id}
        projectPath={project.path}
        resumeId={t.resumeId}
        initialPrompt={t.initialPrompt}
        onBookmark={settings.pinboard ? toggleBookmark : undefined}
        bookmarked={bookmarkedAnchors}
        onLocator={registerLocator}
        sendKey={settings.sendKey}
        theme={settings.theme}
        showStderr={settings.showStderr}
        richCopy={settings.richCopy}
        onTitle={(title) => updateTabs((tabs) => tabs.map((x) => (x.id === t.id ? { ...x, title } : x)))}
        onSessionId={(uuid) => {
          updateTabs((tabs) => {
            const cur = tabs.find((x) => x.id === t.id);
            if (cur?.type === 'session' && cur.resumeId === uuid) return tabs;
            return tabs.map((x) => (x.id === t.id && x.type === 'session' ? { ...x, resumeId: uuid } : x));
          });
        }}
        onInitialPromptConsumed={() => {
          updateTabs((tabs) =>
            tabs.map((x) => {
              if (x.id !== t.id || x.type !== 'session' || x.initialPrompt == null) return x;
              const { initialPrompt: _consumed, ...rest } = x;
              return rest;
            }),
          );
        }}
        onExportApi={registerExportApi}
        onOpenFile={(relPath) => openTab({ id: shortId(), type: 'file', path: relPath })}
      />
    );
  },
});

registerTabKind({
  id: 'devin',
  label: 'Devin',
  render: ({ tab, project, settings, updateTabs, updateSettings, registerExportApi, openTab, toggleBookmark, bookmarkedAnchors, registerLocator }) => {
    const t = asDevin(tab);
    return (
      <DevinPanel
        projectId={project.id}
        projectPath={project.path}
        resumeId={t.resumeId}
        onBookmark={settings.pinboard ? toggleBookmark : undefined}
        bookmarked={bookmarkedAnchors}
        onLocator={registerLocator}
        sendKey={settings.sendKey}
        theme={settings.theme}
        defaultModel={settings.devinModel ?? ''}
        defaultMode={settings.devinMode ?? ''}
        showStderr={settings.showStderr}
        richCopy={settings.richCopy}
        onSetDefaultModel={(modelId) => updateSettings({ ...settings, devinModel: modelId })}
        onTitle={(title) => updateTabs((tabs) => tabs.map((x) => (x.id === t.id ? { ...x, title } : x)))}
        onSessionId={(sid) => {
          const next = sid || undefined;
          updateTabs((tabs) => {
            const cur = tabs.find((x) => x.id === t.id);
            if (cur?.type === 'devin' && cur.resumeId === next) return tabs;
            return tabs.map((x) => (x.id === t.id && x.type === 'devin' ? { ...x, resumeId: next } : x));
          });
        }}
        onExportApi={registerExportApi}
        onOpenFile={(relPath) => openTab({ id: shortId(), type: 'file', path: relPath })}
      />
    );
  },
});
