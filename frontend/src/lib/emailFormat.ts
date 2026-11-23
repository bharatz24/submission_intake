// Rich-text support for draft emails. The body stays plain text in the database (Markdown), so nothing about storage
// changes: the editor toolbar inserts Markdown, the preview renders it, and Copy puts HTML and plain text on the clipboard.

export type FormatKind = 'bold' | 'highlight' | 'heading' | 'bullet' | 'number' | 'table';

export interface Edit {
  value: string;
  start: number;
  end: number;
}

const TABLE_TEMPLATE = '| Item | Details |\n| --- | --- |\n| First item | Details |\n| Second item | Details |';

const LINE_PREFIX: Record<'heading' | 'bullet' | 'number', (i: number) => string> = {
  heading: () => '## ',
  bullet: () => '- ',
  number: (i) => `${i + 1}. `,
};
const ANY_PREFIX = /^(#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+)/;

/** Applies a toolbar action to the text between `start` and `end`; returns the new text and selection. */
export function applyFormat(value: string, start: number, end: number, kind: FormatKind): Edit {
  if (kind === 'bold' || kind === 'highlight') {
    const mark = kind === 'bold' ? '**' : '==';
    const sel = value.slice(start, end);
    // Selecting already-marked text and clicking again removes the marks.
    if (sel.length > 2 * mark.length && sel.startsWith(mark) && sel.endsWith(mark)) {
      const inner = sel.slice(mark.length, -mark.length);
      return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
    }
    const text = sel || 'text';
    return {
      value: `${value.slice(0, start)}${mark}${text}${mark}${value.slice(end)}`,
      start: start + mark.length,
      end: start + mark.length + text.length,
    };
  }

  if (kind === 'table') {
    const before = value.slice(0, start);
    const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const after = value.slice(end);
    const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const at = start + lead.length;
    return { value: `${before}${lead}${TABLE_TEMPLATE}${trail}${after}`, start: at + 2, end: at + 6 };
  }

  // Line formats act on every line touched by the selection; applying the same format again removes it.
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const nl = value.indexOf('\n', end);
  const to = nl === -1 ? value.length : nl;
  const lines = value.slice(from, to).split('\n');
  const prefixOf = LINE_PREFIX[kind];
  const target = lines.filter((l) => l.trim());
  const has = kind === 'heading' ? /^#{1,6}\s/ : kind === 'bullet' ? /^[-*+•]\s/ : /^\d+[.)]\s/;
  const already = target.length > 0 && target.every((l) => has.test(l));
  let n = 0;
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    const bare = l.replace(ANY_PREFIX, '');
    return already ? bare : prefixOf(n++) + bare;
  });
  const text = out.join('\n');
  return { value: value.slice(0, from) + text + value.slice(to), start: from, end: from + text.length };
}

/**
 * Draft text → Markdown that renders as written. Drafts saved before this change use "•" bullets, and Markdown folds
 * single newlines into one line, so list markers are normalised and line breaks inside a paragraph are kept.
 */
export function toMarkdown(body: string): string {
  const lines = body
    .replace(/\r\n?/g, '\n')
    .replace(/^(\s*)•\s+/gm, '$1- ')
    .split('\n');
  const block = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/;
  return lines
    .map((l, i) => {
      const next = lines[i + 1];
      if (!l.trim() || next === undefined || !next.trim() || block.test(next) || block.test(l)) return l;
      return `${l}  `;
    })
    .join('\n');
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string };
}
const HIGHLIGHT = /==([^=\n](?:[^=\n]*[^=\n])?)==/g;

/** remark plugin: ==text== becomes a highlighted <mark>. Code and links are left alone. */
export function remarkHighlight() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text' || !child.value) {
        walk(child);
        return [child];
      }
      const out: MdNode[] = [];
      let last = 0;
      for (const m of child.value.matchAll(HIGHLIGHT)) {
        if (m.index > last) out.push({ type: 'text', value: child.value.slice(last, m.index) });
        out.push({ type: 'emphasis', data: { hName: 'mark' }, children: [{ type: 'text', value: m[1] }] });
        last = m.index + m[0].length;
      }
      if (!out.length) return [child];
      if (last < child.value.length) out.push({ type: 'text', value: child.value.slice(last) });
      return out;
    });
  };
  return (tree: MdNode) => walk(tree);
}

/** Inline styles for the rendered preview so tables, highlights and spacing survive pasting into Gmail or Outlook. */
export function emailHtml(rendered: HTMLElement, subject: string): string {
  const root = rendered.cloneNode(true) as HTMLElement;
  const style = (sel: string, css: string) =>
    root.querySelectorAll<HTMLElement>(sel).forEach((el) => el.setAttribute('style', css));
  style('table', 'border-collapse:collapse;margin:8px 0');
  style('th', 'border:1px solid #c8ced6;padding:4px 8px;text-align:left;background:#f1f3f7');
  style('td', 'border:1px solid #c8ced6;padding:4px 8px;text-align:left');
  style('mark', 'background:#fff3a3');
  style('p', 'margin:0 0 10px');
  style('ul,ol', 'margin:0 0 10px;padding-left:24px');
  style('h1,h2,h3', 'margin:14px 0 6px;font-size:15px');
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;line-height:1.5"><p><b>Subject:</b> ${esc(subject)}</p>${root.innerHTML}</div>`;
}
