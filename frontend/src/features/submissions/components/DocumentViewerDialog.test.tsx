// @vitest-environment jsdom
// SVG can carry script: the viewer must never render it inline from a same-origin blob URL.
import { render, screen } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockApi } from '../../../test/msw/api';
import type { DocumentInfo } from '../../../types';

/** GET /documents/:id/view answers with these bytes, typed by the Content-Type header like the real server. */
// The bytes go in as they are: a jsdom Blob would reach the fetch implementation as the text "[object Blob]".
const serveFile = (bytes: string | Uint8Array<ArrayBuffer>, contentType: string) =>
  mockApi({ 'GET /documents/:id/view': () => new HttpResponse(bytes, { headers: { 'Content-Type': contentType } }) });

const { DocumentViewerDialog, previewKind } = await import('./DocumentViewerDialog');

const doc = (mimeType: string, filename: string) =>
  ({ id: 'd1', filename, mimeType, sizeBytes: 100, pageCount: null }) as unknown as DocumentInfo;

describe('DocumentViewerDialog', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:http://app.test/1');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.clearAllMocks());

  it('treats SVG as download-only and never creates a blob URL for it', async () => {
    serveFile('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml');
    const { baseElement } = render(<DocumentViewerDialog doc={doc('image/svg+xml', 'logo.svg')} onClose={() => {}} />);
    expect(await screen.findByText('Preview not supported')).toBeInTheDocument();
    expect(baseElement.querySelector('img, iframe, object, embed')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('previews raster images inline', async () => {
    serveFile(new Uint8Array([137, 80, 78, 71]), 'image/png');
    render(<DocumentViewerDialog doc={doc('image/png', 'scan.png')} onClose={() => {}} />);
    expect(await screen.findByRole('img', { name: 'scan.png' })).toHaveAttribute('src', 'blob:http://app.test/1');
  });

  it('previews a real PDF in a frame, from a blob re-typed application/pdf', async () => {
    serveFile('%PDF-1.7 1 0 obj', 'application/pdf; name=x.pdf');
    const { baseElement } = render(<DocumentViewerDialog doc={doc('application/pdf', 'app.pdf')} onClose={() => {}} />);
    await vi.waitFor(() =>
      expect(baseElement.querySelector('iframe')).toHaveAttribute('src', 'blob:http://app.test/1'),
    );
    const [[framed]] = vi.mocked(URL.createObjectURL).mock.calls as unknown as [[Blob]];
    expect(framed.type).toBe('application/pdf');
  });

  it('refuses to frame a file labelled PDF that is not one', async () => {
    serveFile('<html><script>alert(1)</script></html>', 'application/pdf');
    const { baseElement } = render(
      <DocumentViewerDialog doc={doc('application/pdf', 'fake.pdf')} onClose={() => {}} />,
    );
    expect(await screen.findByText('Preview not supported')).toBeInTheDocument();
    expect(baseElement.querySelector('iframe')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('only previews PDF and raster image types', () => {
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('image/jpeg')).toBe('image');
    expect(previewKind('IMAGE/PNG; charset=binary')).toBe('image');
    expect(previewKind('image/svg+xml')).toBeNull();
    expect(previewKind('image/svg+xml; charset=utf-8')).toBeNull();
    expect(previewKind('text/html')).toBeNull();
    expect(previewKind('application/octet-stream')).toBeNull();
  });
});
