// Review status of a report or quote generated automatically (Settings → Automation = Auto). It needs review until a
// person acknowledges it ("Mark reviewed") or records an assessment; afterwards the reviewer is shown.
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import { Button, Chip, Stack, Typography } from '@mui/material';

import { formatDateTime } from '../../../lib/status';

export const NEEDS_REVIEW_LABEL = 'Needs review — generated automatically';

interface Props {
  needsReview: boolean | undefined;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  /** Shows the "Mark reviewed" button (writers only); omit for a read-only or compact chip. */
  onReview?: () => void;
  pending?: boolean;
  /** List rows: a small chip only. */
  compact?: boolean;
}

export function NeedsReviewChip({ needsReview, reviewedBy, reviewedAt, onReview, pending = false, compact }: Props) {
  if (!needsReview) {
    if (compact || !reviewedBy) return null;
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
      >
        <TaskAltIcon fontSize="inherit" aria-hidden />
        Reviewed by {reviewedBy}
        {reviewedAt ? ` · ${formatDateTime(reviewedAt)}` : ''}
      </Typography>
    );
  }
  const chip = (
    <Chip
      size="small"
      color="warning"
      variant={compact ? 'outlined' : 'filled'}
      icon={<VisibilityIcon aria-hidden />}
      label={compact ? 'Needs review' : NEEDS_REVIEW_LABEL}
      title={compact ? NEEDS_REVIEW_LABEL : undefined}
    />
  );
  if (compact || !onReview) return chip;
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      {chip}
      <Button size="small" variant="outlined" startIcon={<TaskAltIcon />} onClick={onReview} disabled={pending}>
        {pending ? 'Marking…' : 'Mark reviewed'}
      </Button>
    </Stack>
  );
}
