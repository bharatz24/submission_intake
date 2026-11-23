// @vitest-environment jsdom
// Grounding results: the report summary, the inline "Not found in source" marker and the chat footnote.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../../../test/axe';
import type { Grounding } from '../../../types';
import { describeMissing, GroundingFootnote, GroundingSummary, NotFoundMarker } from './GroundingSummary';

const item = {
  path: 'extractedFacts[0]',
  text: 'Paid $999,999 (loss_runs.pdf)',
  verdict: 'unverified' as const,
  missing: ['source: loss_runs.pdf', '999999'],
};
const grounding = (over: Partial<Grounding> = {}): Grounding => ({
  checked: 41,
  verified: 38,
  unverified: 3,
  items: [item],
  ...over,
});

describe('GroundingSummary', () => {
  it('says how many evidence items were not found', async () => {
    const { container } = render(<GroundingSummary grounding={grounding()} />);
    expect(screen.getByRole('status')).toHaveTextContent('3 of 41 evidence items not found in the submission');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('renders nothing when everything checked was found, or nothing was checked', () => {
    const { container, rerender } = render(
      <GroundingSummary grounding={grounding({ verified: 41, unverified: 0, items: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<GroundingSummary grounding={{ checked: 0, verified: 0, unverified: 0, items: [] }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<GroundingSummary grounding={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('NotFoundMarker', () => {
  it('has the accessible text "Not found in source" and names what is missing', async () => {
    const { container } = render(<NotFoundMarker item={item} />);
    const marker = screen.getByText('Not found in source', { exact: false });
    expect(marker.closest('.MuiChip-root')).toHaveTextContent(
      'Not found in source: loss_runs.pdf (file not in the submission), 999,999',
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it('renders nothing for a verified item', () => {
    const { container } = render(<NotFoundMarker item={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('GroundingFootnote', () => {
  it('lists the values of a chat answer that were not found', async () => {
    const { container } = render(
      <GroundingFootnote
        grounding={{
          checked: 2,
          verified: 1,
          unverified: 1,
          items: [{ ...item, path: 'answer[0]', missing: ['888777'] }],
        }}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent('Not found in source — not in the submission: 888,777');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('renders nothing for an answer with no concrete values', () => {
    const { container } = render(
      <GroundingFootnote grounding={{ checked: 0, verified: 0, unverified: 0, items: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('describeMissing', () => {
  it('reads tokens the way an underwriter would', () => {
    expect(describeMissing('source: a.pdf')).toBe('a.pdf (file not in the submission)');
    expect(describeMissing('175000')).toBe('175,000');
    expect(describeMissing('2021-01-05')).toBe('2021-01-05');
    expect(describeMissing('12.5%')).toBe('12.5%');
  });
});
