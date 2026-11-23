// @vitest-environment jsdom
// Review status of automatically generated reports and quotes.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../test/axe';
import { NeedsReviewChip } from './NeedsReviewChip';

describe('NeedsReviewChip', () => {
  it('labels automatic output and marks it reviewed on click', async () => {
    const onReview = vi.fn();
    const { container } = render(<NeedsReviewChip needsReview onReview={onReview} />);
    expect(screen.getByText('Needs review — generated automatically')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('disables the button while the review is being saved', () => {
    render(<NeedsReviewChip needsReview onReview={() => {}} pending />);
    expect(screen.getByRole('button', { name: 'Marking…' })).toBeDisabled();
  });

  it('shows the chip without a button for readers and in compact rows', () => {
    const { rerender } = render(<NeedsReviewChip needsReview />);
    expect(screen.getByText('Needs review — generated automatically')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<NeedsReviewChip needsReview compact onReview={() => {}} />);
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the reviewer once reviewed, and shows nothing for manual output', () => {
    const { container, rerender } = render(
      <NeedsReviewChip needsReview={false} reviewedBy="Ada Admin" reviewedAt="2026-11-17T10:00:00Z" />,
    );
    expect(screen.getByText(/Reviewed by Ada Admin/)).toBeInTheDocument();
    rerender(<NeedsReviewChip needsReview={false} reviewedBy={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
