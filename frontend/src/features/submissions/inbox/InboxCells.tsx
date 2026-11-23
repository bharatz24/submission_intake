import DeleteIcon from '@mui/icons-material/DeleteOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, Chip, IconButton, Link, Stack, TableCell, Tooltip, Typography } from '@mui/material';
import type { MouseEvent } from 'react';
import { Link as RouterLink } from 'react-router';

import { friendlyProcessingError, pipelineStepLabel } from '../../../lib/pipeline';
import {
  duplicateBasisLabel,
  formatPercent,
  mainClassificationReason,
  submissionChance,
  submissionChanceColor,
} from '../../../lib/status';
import { paths } from '../../../paths';
import type { InboxView, SubmissionSummary } from '../../../types';

/**
 * Ignored and Duplicates rows: why the email was not processed and a one-click release.
 * No match %, applicant, NPI or report columns: none of that exists for an email that was never processed.
 */
export function HeldBackCells({
  s,
  view,
  writable,
  releasing,
  onRelease,
}: {
  s: SubmissionSummary;
  view: Exclude<InboxView, 'submissions'>;
  writable: boolean;
  releasing: boolean;
  onRelease: () => void;
}) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <>
      <TableCell sx={{ verticalAlign: 'top' }}>
        {view === 'duplicates' ? (
          <Stack direction="row" spacing={0.75} alignItems="center">
            {s.duplicateBasis?.strength === 'POSSIBLE' && (
              <Chip
                size="small"
                color="warning"
                label="Possible"
                title="Weak match: please check before leaving it unprocessed"
                sx={{ flexShrink: 0 }}
              />
            )}
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" noWrap title={duplicateBasisLabel(s.duplicateBasis)}>
                {duplicateBasisLabel(s.duplicateBasis)}
              </Typography>
              {s.duplicateBasis?.explanation && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  display="block"
                  noWrap
                  title={s.duplicateBasis.explanation}
                >
                  {s.duplicateBasis.explanation}
                </Typography>
              )}
            </Box>
          </Stack>
        ) : view === 'errors' ? (
          <Box sx={{ minWidth: 0 }}>
            {/* Wrapped, not truncated: reviewers need the whole message to know what to do next. */}
            <Typography variant="body2" color="error.main" sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              {friendlyProcessingError(s.processingError).message}
            </Typography>
            {s.pipeline?.failedStep && (
              <Typography variant="caption" color="text.secondary" display="block" noWrap>
                Failed at {pipelineStepLabel(s.pipeline.failedStep)}
              </Typography>
            )}
          </Box>
        ) : (
          <Typography variant="body2" noWrap title={s.classificationReasons.join('\n')}>
            {mainClassificationReason(s.classificationReasons) ?? '—'}
          </Typography>
        )}
      </TableCell>
      {view === 'duplicates' && (
        <TableCell sx={{ verticalAlign: 'top' }}>
          {s.duplicateOf ? (
            <Link
              component={RouterLink}
              to={paths.submission(s.duplicateOf.id)}
              onClick={stop}
              underline="hover"
              variant="body2"
              noWrap
              display="block"
              title={s.duplicateOf.subject}
            >
              {s.duplicateOf.subject || '(no subject)'}
            </Link>
          ) : (
            '—'
          )}
        </TableCell>
      )}
      {view === 'ignored' && <SubmissionChanceCell s={s} />}
      <TableCell align="center" sx={{ verticalAlign: 'top' }}>
        {s.documentCount}
      </TableCell>
      {writable && (
        <TableCell align="right" sx={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
          <Stack direction="row" alignItems="center" justifyContent="flex-end">
            {/* The errors column is narrow: a short label, with the full meaning in the tooltip and accessible name. */}
            <Button
              size="small"
              variant="outlined"
              disabled={releasing}
              onClick={(e) => {
                stop(e);
                onRelease();
              }}
              startIcon={view === 'errors' ? <RefreshIcon /> : undefined}
              sx={{ flexShrink: 0 }}
              aria-label={view === 'errors' ? 'Retry from failed step' : undefined}
              title={
                view === 'errors'
                  ? 'Retry from failed step'
                  : view === 'duplicates'
                    ? 'Not a duplicate: run the full pipeline'
                    : 'Override the classification and run the full pipeline'
              }
            >
              {releasing
                ? 'Queuing…'
                : view === 'errors'
                  ? 'Retry'
                  : view === 'duplicates'
                    ? 'Process anyway'
                    : 'Process as submission'}
            </Button>
          </Stack>
        </TableCell>
      )}
    </>
  );
}

function SubmissionChanceCell({ s }: { s: SubmissionSummary }) {
  const chance = submissionChance(s.classification, s.classificationConfidence);
  if (chance === null) return <TableCell sx={{ verticalAlign: 'top' }}>—</TableCell>;
  const color = submissionChanceColor(chance);
  return (
    <TableCell sx={{ verticalAlign: 'top' }}>
      <Tooltip title={`Classified as not a submission with ${formatPercent(s.classificationConfidence)} confidence`}>
        <Typography
          variant="body2"
          fontWeight={color === 'warning' ? 700 : 400}
          color={color === 'warning' ? 'warning.main' : 'text.secondary'}
          sx={{ width: 'fit-content' }}
        >
          {formatPercent(chance)}
        </Typography>
      </Tooltip>
    </TableCell>
  );
}

// Row actions marked .reveal appear on row hover or keyboard focus; touch screens, which cannot hover, always show them.
export const revealOnHover = {
  cursor: 'pointer',
  '& .reveal': { opacity: 0, transition: 'opacity 120ms' },
  '&:hover .reveal, & .reveal:focus-within': { opacity: 1 },
  '@media (hover: none)': { '& .reveal': { opacity: 1 } },
};

export const isBusy = (s: SubmissionSummary) => s.status === 'NEW' || s.status === 'PROCESSING';

/** An imported email that was only classified and is waiting for Process (the "Not processed" badge). */
export const awaitingProcess = (s: SubmissionSummary) => s.heldForImport && !s.heldForClassification;

const REPORT_CHIP = {
  synthesis: { letter: 'S', name: 'Synthesis' },
  analysis: { letter: 'A', name: 'Analysis' },
} as const;

/**
 * The latest version of a report, linking to its tab (a real link, so it also opens in a new tab). Ignored and
 * duplicate emails have no report tabs, so theirs is not a link. The click stays off the row, which opens Overview.
 */
export function ReportChip({
  s,
  tab,
  version,
}: {
  s: SubmissionSummary;
  tab: keyof typeof REPORT_CHIP;
  version: number | null;
}) {
  const { letter, name } = REPORT_CHIP[tab];
  const label = version ? `${letter} v${version}` : `${letter} —`;
  if (s.status === 'DUPLICATE' || s.status === 'NOT_SUBMISSION') {
    return <Chip size="small" variant="outlined" label={label} title={`Latest ${name.toLowerCase()} version`} />;
  }
  return (
    <Chip
      size="small"
      variant="outlined"
      clickable
      component={RouterLink}
      to={paths.submission(s.id, tab)}
      label={label}
      title={version ? `Open ${name} v${version}` : `No ${name} yet. Open the ${name} tab`}
      aria-label={version ? `Open ${name} version ${version}` : `Open the ${name} tab`}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    />
  );
}

export function DeleteButton({
  s,
  onDelete,
  compact,
}: {
  s: SubmissionSummary;
  onDelete: () => void;
  compact?: boolean;
}) {
  return (
    <Tooltip title={isBusy(s) ? 'Still being processed' : 'Delete'}>
      <span>
        <IconButton
          size="small"
          color="error"
          disabled={isBusy(s)}
          aria-label={`Delete ${s.subject || 'email'}`}
          sx={compact ? { p: 0.5 } : { ml: 0.5 }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );
}
