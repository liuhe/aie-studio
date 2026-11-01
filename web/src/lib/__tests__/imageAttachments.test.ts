import { describe, expect, it } from 'vitest';
import { imageFilesFromClipboard, parseImageDataUrl, toWireImages } from '../imageAttachments';

describe('parseImageDataUrl', () => {
  it('splits media type and payload', () => {
    expect(parseImageDataUrl('data:image/png;base64,AAAA')).toEqual({ mediaType: 'image/png', base64: 'AAAA' });
  });
  it('falls back to the file type when the URL has none', () => {
    expect(parseImageDataUrl('data:;base64,AAAA', 'image/jpeg')).toEqual({ mediaType: 'image/jpeg', base64: 'AAAA' });
  });
  it('rejects non-image or malformed URLs', () => {
    expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseImageDataUrl('https://x/y.png')).toBeNull();
    expect(parseImageDataUrl('data:image/png')).toBeNull();
  });
});

describe('toWireImages', () => {
  it('keeps only mediaType + data', () => {
    expect(toWireImages([{ id: '1', dataUrl: 'data:image/png;base64,QQ', mediaType: 'image/png', base64: 'QQ' }]))
      .toEqual([{ mediaType: 'image/png', data: 'QQ' }]);
  });
});

describe('imageFilesFromClipboard', () => {
  const file = (type: string) => ({ type } as unknown as File);
  it('returns image files only, in order', () => {
    const png = file('image/png'); const jpg = file('image/jpeg');
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => png },
      { kind: 'file', type: 'application/pdf', getAsFile: () => file('application/pdf') },
      { kind: 'file', type: 'image/jpeg', getAsFile: () => jpg },
    ];
    expect(imageFilesFromClipboard(items)).toEqual([png, jpg]);
  });
  it('tolerates a missing list', () => {
    expect(imageFilesFromClipboard(null)).toEqual([]);
  });
});
