import { useEffect, useState } from 'react';

// Same breakpoint as the CSS mobile rules (@media (max-width: 768px)). Used
// by desktop-only features (model: web.RichCopyEditor) so they are not just
// hidden on phones but never rendered at all.
const DESKTOP_QUERY = '(min-width: 769px)';

export function isDesktopViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia(DESKTOP_QUERY).matches;
}

export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState<boolean>(() => isDesktopViewport());
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => setDesktop(e.matches);
    setDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}
