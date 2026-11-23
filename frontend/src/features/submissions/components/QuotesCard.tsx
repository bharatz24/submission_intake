import EditIcon from '@mui/icons-material/EditOutlined';
import RequestQuoteIcon from '@mui/icons-material/RequestQuoteOutlined';
import StarIcon from '@mui/icons-material/StarOutline';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, ErrorState, Loading, SectionCard } from '../../../components/common';
import { useManualStep } from '../../../lib/automation';
import { formatDateTime } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { Quote } from '../../../types';
import { quoteKeys, submissionKeys } from '../queryKeys';
import { NeedsReviewChip } from './NeedsReviewChip';
import { money, QuoteBreakdown } from './QuoteBreakdown';
import { QuoteDialog } from './QuoteDialog';

/**
 * A quote row's actions stay hidden until the row is hovered or something in it has keyboard focus; on a touch
 * screen (no hover) they always show. Hidden by opacity, so the column keeps its width and the table never shifts.
 */
const rowWithHoverActions = {
  cursor: 'pointer',
  '& .row-actions': { opacity: 0, transition: 'opacity 120ms' },
  '&:hover .row-actions, &:focus-within .row-actions': { opacity: 1 },
  '@media (hover: none)': { '& .row-actions': { opacity: 1 } },
} as const;

/** Quotes priced from the rate tables. Nothing is quoted automatically: an underwriter creates each one. */
export function QuotesCard({ submissionId, held = false }: { submissionId: string; held?: boolean }) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const manual = useManualStep('autoQuote', held);
  const quotes = useQuery({
    queryKey: quoteKeys.list(submissionId),
    queryFn: ({ signal }) => apiWith(signal).quotes(submissionId),
  });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Quote | null>(null);
  const qc = useQueryClient();
  const primary = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (ratingId: string) => api.setPrimaryRating(submissionId, ratingId),
    onSuccess: (quotes) => qc.setQueryData(quoteKeys.list(submissionId), quotes),
  });
  // "Mark reviewed" on a quote generated automatically.
  const review = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (quoteId: string) => api.reviewQuote(submissionId, quoteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: quoteKeys.list(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.detail(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
    },
  });

  const list = quotes.data ?? [];
  const shown = list.find((q) => q.id === selected) ?? list[0];

  return (
    <SectionCard
      title="Quote"
      subtitle="Priced from the DPL rate tables. Quotes are only created when you click Create quote. Edit saves your changes as a new version, or over the quote you are editing."
      actions={
        writable && (
          <Button variant="contained" size="small" startIcon={<RequestQuoteIcon />} onClick={() => setOpen(true)}>
            Create quote
          </Button>
        )
      }
    >
      {quotes.isLoading && <Loading label="Loading quotes…" minHeight={80} shape="list" />}
      {quotes.isError && <ErrorState error={quotes.error} onRetry={() => quotes.refetch()} />}
      {quotes.isSuccess && !shown && (
        <EmptyState
          title="No quote yet"
          description={
            manual
              ? 'Automatic quoting is Manual in Settings → Automation. Create quote prices this submission.'
              : writable
                ? 'Create quote prices the submission from its extracted fields; you can review and adjust every input first.'
                : 'An underwriter has not created a quote yet.'
          }
        />
      )}
      {shown && (
        <Stack spacing={2}>
          {list.length > 0 && (
            <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Version</TableCell>
                    <TableCell>Label</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Premium</TableCell>
                    <TableCell align="right">Total</TableCell>
                    <TableCell>Created</TableCell>
                    {writable && <TableCell align="right" aria-label="Actions" />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {list.map((q) => (
                    <TableRow
                      key={q.id}
                      hover
                      selected={q.id === shown.id}
                      onClick={() => setSelected(q.id)}
                      sx={rowWithHoverActions}
                    >
                      <TableCell>
                        v{q.version}
                        {q.isPrimary && <Chip size="small" color="primary" label="Primary" sx={{ ml: 1 }} />}
                        {q.needsReview && (
                          <Box component="span" sx={{ ml: 1, display: 'inline-flex' }}>
                            <NeedsReviewChip needsReview compact />
                          </Box>
                        )}
                      </TableCell>
                      <TableCell>{q.label ?? ''}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          color={q.status === 'QUOTED' ? 'success' : 'warning'}
                          label={q.status}
                        />
                        {q.factors.specialities?.some((x) => x.manual) && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            label="Manual factor"
                            sx={{ ml: 0.5 }}
                            title="A specialty no rate class matched is rated with an underwriter's factor"
                          />
                        )}
                      </TableCell>
                      <TableCell align="right">{money(q.premium)}</TableCell>
                      <TableCell align="right">{money(q.total)}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {q.createdBy?.name ?? 'System'} · {formatDateTime(q.createdAt)}
                      </TableCell>
                      {writable && (
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap', py: 0 }}>
                          {/* The row itself selects the quote; these buttons only act, so their clicks stop here. */}
                          <Box className="row-actions" onClick={(e) => e.stopPropagation()}>
                            <Tooltip title="Edit" arrow>
                              <IconButton
                                size="small"
                                aria-label={`Edit quote v${q.version}`}
                                onClick={() => setEditing(q)}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            {!q.isPrimary && (
                              <Tooltip title="Make primary" arrow>
                                {/* A disabled button fires no events, so the tooltip needs a wrapper to anchor to. */}
                                <span>
                                  <IconButton
                                    size="small"
                                    aria-label={`Make quote v${q.version} primary`}
                                    disabled={primary.isPending}
                                    onClick={() => {
                                      setSelected(q.id);
                                      primary.mutate(q.id);
                                    }}
                                  >
                                    <StarIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            )}
                          </Box>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" color="text.secondary">
              Quote v{shown.version}
              {shown.label ? ` · ${shown.label}` : ''} · {shown.rateGroup} · {shown.createdBy?.name ?? 'System'} ·{' '}
              {formatDateTime(shown.createdAt)}
            </Typography>
            {shown.isPrimary && <Chip size="small" color="primary" label="Primary" />}
          </Stack>
          <NeedsReviewChip
            needsReview={shown.needsReview}
            reviewedBy={shown.reviewedBy}
            reviewedAt={shown.reviewedAt}
            onReview={writable ? () => review.mutate(shown.id) : undefined}
            pending={review.isPending}
          />
          {primary.isError && <Alert severity="error">{errorMessage(primary.error)}</Alert>}
          {review.isError && <Alert severity="error">{errorMessage(review.error)}</Alert>}
          <QuoteBreakdown
            status={shown.status}
            total={shown.total}
            premium={shown.premium}
            factors={shown.factors}
            pricing={shown.pricing}
            flags={shown.flags}
            missing={shown.missing}
          />
        </Stack>
      )}
      {open && (
        <QuoteDialog
          submissionId={submissionId}
          onClose={() => {
            setOpen(false);
            setSelected(null);
          }}
        />
      )}
      {editing && (
        <QuoteDialog
          key={editing.id}
          submissionId={submissionId}
          from={editing}
          onClose={() => {
            setEditing(null);
            setSelected(null);
          }}
        />
      )}
    </SectionCard>
  );
}
