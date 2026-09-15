import { useEffect, useState } from 'react';

// Chrome / Edge fire `beforeinstallprompt` exactly once when their installability
// heuristics first trigger. If no component is mounted yet to listen, the event
// is lost — so we bind a module-level listener at import time and cache the
// event for whichever component asks later.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

let cached: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();

function notify() {
  for (const s of subscribers) s();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    cached = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    cached = null;
    notify();
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if ((navigator as any).standalone === true) return true; // iOS Safari
  return false;
}

export function usePwaInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    subscribers.add(l);
    return () => { subscribers.delete(l); };
  }, []);
  return {
    canInstall: cached !== null,
    isInstalled: isStandalone(),
    async install(): Promise<'accepted' | 'dismissed' | null> {
      if (!cached) return null;
      const e = cached;
      cached = null; // prompt is single-use per Chrome contract
      notify();
      await e.prompt();
      const choice = await e.userChoice;
      return choice.outcome;
    },
  };
}
