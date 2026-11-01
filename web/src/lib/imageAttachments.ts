// Model: web.ImageAttachments — pure helpers behind the shared image
// attachment component. No DOM/React here so they can be unit-tested.

export type ImageAttachment = { id: string; dataUrl: string; mediaType: string; base64: string };

// What goes over the wire in {type:'user', images} (rule-317). The server maps
// it to a Claude base64 source block or an ACP image block.
export type WireImage = { mediaType: string; data: string };

// Split a data URL into its media type and base64 payload (rule-316). Returns
// null when the URL isn't a base64 data URL we can forward.
export function parseImageDataUrl(dataUrl: string, fallbackType = ''): { mediaType: string; base64: string } | null {
  if (!dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma); // e.g. "image/png;base64"
  const base64 = dataUrl.slice(comma + 1);
  if (!base64) return null;
  const mediaType = meta.split(';')[0] || fallbackType;
  if (!mediaType.startsWith('image/')) return null;
  return { mediaType, base64 };
}

export function toWireImages(images: readonly ImageAttachment[]): WireImage[] {
  return images.map((p) => ({ mediaType: p.mediaType, data: p.base64 }));
}

// Image files among clipboard items (rule-315). Accepts the DataTransferItemList
// shape so it can be fed a plain array in tests.
export function imageFilesFromClipboard(
  items: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }> | null | undefined,
): File[] {
  const out: File[] = [];
  if (!items) return out;
  for (const item of Array.from(items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

export function newAttachmentId(): string {
  return Math.random().toString(36).slice(2, 9);
}
