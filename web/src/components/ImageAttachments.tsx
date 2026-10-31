import { useCallback, useRef, useState } from 'react';
import {
  newAttachmentId, parseImageDataUrl, type ImageAttachment,
} from '../lib/imageAttachments';

export type { ImageAttachment } from '../lib/imageAttachments';

// Model: web.ImageAttachments. One implementation of "images waiting to be
// sent" shared by ChatInput (Claude + Devin panels) and the ask_user_question
// form: a hook holding the list, a 📎 button, and the thumbnail strip.

export function useImageAttachments() {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const addFiles = useCallback((files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        const parsed = parseImageDataUrl(dataUrl, f.type);
        if (!parsed) return;
        setImages((prev) => [...prev, { id: newAttachmentId(), dataUrl, ...parsed }]);
      };
      reader.readAsDataURL(f);
    }
  }, []);
  const remove = useCallback((id: string) => setImages((prev) => prev.filter((p) => p.id !== id)), []);
  const clear = useCallback(() => setImages([]), []);
  return { images, addFiles, remove, clear };
}

// 📎 + hidden file input (rule-315).
export function AttachImagesButton({ onFiles, disabled, className = 'chat-attach', title = 'Attach image' }: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => inputRef.current?.click()} title={title} disabled={disabled}>📎</button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

// Thumbnails with a × each (rule-316). Renders nothing when empty.
export function ImageAttachmentStrip({ images, onRemove, onOpen, className = 'chat-pending-images' }: {
  images: readonly ImageAttachment[];
  onRemove: (id: string) => void;
  // Host-provided lightbox; omitted = thumbnails aren't clickable.
  onOpen?: (dataUrl: string) => void;
  className?: string;
}) {
  if (images.length === 0) return null;
  return (
    <div className={className}>
      {images.map((img) => (
        <div key={img.id} className="pending-thumb">
          <img src={img.dataUrl} alt="" onClick={onOpen ? () => onOpen(img.dataUrl) : undefined} style={onOpen ? undefined : { cursor: 'default' }} />
          <button type="button" className="pending-thumb-del" onClick={() => onRemove(img.id)} title="Remove">×</button>
        </div>
      ))}
    </div>
  );
}
