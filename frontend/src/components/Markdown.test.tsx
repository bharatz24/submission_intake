// @vitest-environment jsdom
// Markdown renders model output built from untrusted email text: only https:/mailto: links survive, links reveal
// their real destination, and images are never loaded.
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const { Markdown, safeMarkdownUrl } = await import('./common');
// The markdown renderer is lazy (FE-05): load it once up front so no test waits on its first import.
await (await import('./common')).preloadMarkdown();

/** The renderer is lazy (FE-05): wait until it has replaced the loading placeholder. */
const rendered = (container: HTMLElement) =>
  waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());

describe('Markdown', () => {
  it('never renders images as <img>', async () => {
    const { container } = render(<Markdown>{'Before ![tracking pixel](https://evil.test/p.gif?u=1) after'}</Markdown>);
    await rendered(container);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('tracking pixel');
  });

  it('drops raw HTML, including <img> tags', async () => {
    const { container } = render(<Markdown>{'x <img src="https://evil.test/a.png" onerror="alert(1)"> y'}</Markdown>);
    await rendered(container);
    expect(container).toHaveTextContent('x y');
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps https links, opens them in a new tab and shows a disguised destination', async () => {
    render(<Markdown>{'[your bank](https://evil.test/login)'}</Markdown>);
    const link = await screen.findByRole('link', { name: 'your bank' });
    expect(link).toHaveAttribute('href', 'https://evil.test/login');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(/\(https:\/\/evil\.test\/login\)/)).toBeInTheDocument();
  });

  it('neutralises javascript:, data: and http: links', async () => {
    const { container } = render(
      <Markdown>{'[a](javascript:alert(1)) [b](data:text/html,x) [c](http://plain.test)'}</Markdown>,
    );
    await rendered(container);
    expect(container).toHaveTextContent('a b c');
    for (const a of container.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^(javascript|data|http):/i);
    }
    expect(safeMarkdownUrl('javascript:alert(1)')).toBe('');
    expect(safeMarkdownUrl(' https://ok.test ')).toBe('https://ok.test');
    expect(safeMarkdownUrl('mailto:pat@brokerage.test')).toBe('mailto:pat@brokerage.test');
  });
});

describe('Markdown loading (FE-05)', () => {
  it('keeps react-markdown out of the shared module every screen imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'src/components/common.tsx'), 'utf8');
    expect(source).not.toMatch(/from 'react-markdown'|from 'remark-gfm'/);
    expect(source).toContain("import('./MarkdownContent')");
  });

  it('renders the text once the renderer has loaded', async () => {
    render(<Markdown>{'**Ready**'}</Markdown>);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });
});
