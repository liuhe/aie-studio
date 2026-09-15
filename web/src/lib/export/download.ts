export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before we release the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadText(text: string, filename: string, mime = 'text/markdown'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

// Build a filesystem-safe filename: ascii letters/digits/dash/underscore/dot.
// Other chars (including CJK) get replaced with '_'. Truncates to 80 chars.
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'session').slice(0, 80);
}
