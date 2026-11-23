// @vitest-environment jsdom
// Help documents (spec §9): a document without scripts is shown with scripts off; one that needs its script keeps it
// in the sandboxed viewer, and "Open in new tab" opens that viewer instead of the raw file (which would run the script
// on the app's origin).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { DOCUMENTS, DocumentsPage } from './DocumentsPage';

const renderDoc = (id: string) =>
  render(
    <MemoryRouter initialEntries={[`/documents?doc=${id}`]}>
      <DocumentsPage />
    </MemoryRouter>,
  );

const docWith = (scripts: boolean) => {
  const doc = DOCUMENTS.find((d) => d.scripts === scripts);
  if (!doc) throw new Error(`no document with scripts=${scripts}`);
  return doc;
};

describe('DocumentsPage', () => {
  it('flags exactly the documents whose HTML contains a script', () => {
    for (const d of DOCUMENTS) {
      const html = readFileSync(path.join(process.cwd(), 'public', d.src), 'utf8');
      expect(/<script\b/i.test(html), d.id).toBe(d.scripts);
    }
  });

  it('shows a document without scripts with scripts disabled, and opens the file itself in a new tab', () => {
    const doc = docWith(false);
    renderDoc(doc.id);
    expect(screen.getByTitle(doc.title)).toHaveAttribute('sandbox', 'allow-popups');
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', doc.src);
  });

  it('keeps scripts for a document that needs them, sandboxed, and opens the viewer in a new tab', () => {
    const doc = docWith(true);
    renderDoc(doc.id);
    const frame = screen.getByTitle(doc.title);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-popups');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', `/documents?doc=${doc.id}`);
  });
});
