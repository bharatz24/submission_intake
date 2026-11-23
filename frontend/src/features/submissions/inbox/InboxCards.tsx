import MarkAsReadIcon from '@mui/icons-material/Drafts';
import MarkAsUnreadIcon from '@mui/icons-material/MarkEmailUnreadOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, Checkbox, Chip, IconButton, Link, Stack, Tooltip, Typography } from '@mui/material';
import type { MouseEvent } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';

import { EnumChip } from '../../../components/common';
import { friendlyProcessingError } from '../../../lib/pipeline';
import {
  classificationColor,
  duplicateBasisLabel,
  formatDateTime,
  formatRelative,
  humanize,
  mainClassificationReason,
  npiStatusColor,
  shortLabel,
  submissionStatusColor,
} from '../../../lib/status';
import { paths } from '../../../paths';
import type { InboxView, SubmissionSummary } from '../../../types';
import { NEEDS_REVIEW_LABEL } from '../components/NeedsReviewChip';
import { awaitingProcess, DeleteButton, isBusy, ReportChip } from './InboxCells';
import type { InboxActions } from './useInboxActions';

const stop = (e: MouseEvent) => e.stopPropagation();

/** Why an Ignored, Duplicates or Errors email was held back, in one or two lines. */
function HeldBackReason({ s, view }: { s: SubmissionSummary; view: Exclude<InboxView, 'submissions'> }) {
  if (view === 'errors')
    return (
      <Typography variant="body2" color="error.main" sx={{ overflowWrap: 'anywhere' }}>
        {friendlyProcessingError(s.processingError).message}
      </Typography>
    );
  const reason =
    view === 'duplicates'
      ? `${duplicateBasisLabel(s.duplicateBasis)}${s.duplicateOf ? ` · of “${s.duplicateOf.subject || '(no subject)'}”` : ''}`
      : (mainClassificationReason(s.classificationReasons) ?? 'Not a submission');
  return (
    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
      {view === 'duplicates' && s.duplicateBasis?.strength === 'POSSIBLE' && (
        <Chip size="small" color="warning" label="Possible" sx={{ mr: 0.75, height: 20 }} />
      )}
      {reason}
    </Typography>
  );
}

function InboxCard({
  s,
  view,
  writable,
  canDelete,
  actions,
}: {
  s: SubmissionSummary;
  view: InboxView;
  writable: boolean;
  canDelete: boolean;
  actions: InboxActions;
}) {
  const navigate = useNavigate();
  const { selected, toggle } = actions.selection;
  const { release, toggleRead, processImported } = actions;
  const open = () => void navigate(paths.submission(s.id));
  const name = s.subject || 'email';
  const isSelected = selected.has(s.id);
  const releasing = release.isPending && release.variables?.id === s.id;
  return (
    // The subject is the card's link (keyboard, middle-click, screen readers); a tap anywhere else on the card opens it
    // too. The card itself is not a link: it holds a checkbox and buttons, which may not nest inside one (FE-01).
    <Box
      component="li"
      onClick={open}
      sx={{
        position: 'relative',
        listStyle: 'none',
        display: 'flex',
        gap: 1,
        px: 1.5,
        py: 1.25,
        borderRadius: 1.5,
        border: 1,
        borderColor: isSelected ? 'primary.main' : 'divider',
        bgcolor: isSelected ? 'action.selected' : 'background.paper',
        cursor: 'pointer',
        transition: 'background-color 120ms, border-color 120ms',
        // Unread mail carries an accent stripe, the way the table carries a dot and bold subject.
        ...(!s.isRead && {
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 0,
            top: 8,
            bottom: 8,
            width: 3,
            borderRadius: 2,
            bgcolor: 'primary.main',
          },
        }),
        '&:active': { bgcolor: 'action.hover' },
        '&:focus-within': { borderColor: 'primary.main' },
      }}
    >
      {canDelete && (
        <Box onClick={stop} sx={{ ml: -1, mt: -0.5 }}>
          <Checkbox
            size="small"
            checked={isSelected}
            onChange={() => toggle(s.id)}
            disabled={isBusy(s)}
            inputProps={{ 'aria-label': `Select ${name}` }}
          />
        </Box>
      )}
      <Stack spacing={0.75} sx={{ minWidth: 0, flex: 1 }}>
        {/* Subject and when, then who it is from (or the applicant, once known). */}
        <Stack direction="row" spacing={1} alignItems="baseline">
          <Link
            component={RouterLink}
            to={paths.submission(s.id)}
            onClick={stop}
            variant="body2"
            color="inherit"
            underline="hover"
            sx={{
              flex: 1,
              minWidth: 0,
              fontWeight: s.isRead ? 500 : 700,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
            }}
          >
            {!s.isRead && (
              <Box component="span" sx={visuallyHiddenInline}>
                Unread:{' '}
              </Box>
            )}
            {s.subject || '(no subject)'}
          </Link>
          <Typography
            variant="caption"
            color={s.isRead ? 'text.secondary' : 'primary.main'}
            fontWeight={s.isRead ? 400 : 600}
            sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            title={formatDateTime(s.receivedAt)}
          >
            {formatRelative(s.receivedAt)}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap title={s.fromAddress}>
          {view === 'submissions' && s.applicantName ? (
            <>
              <Box component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>
                {s.applicantName}
              </Box>
              {' · '}
              {s.fromAddress}
            </>
          ) : (
            s.fromAddress
          )}
        </Typography>

        {view === 'submissions' ? (
          <Stack direction="row" alignItems="center" useFlexGap flexWrap="wrap" gap={0.75}>
            <EnumChip
              value={s.status}
              color={submissionStatusColor(s.status)}
              label={shortLabel(s.status)}
              title={humanize(s.status)}
            />
            <EnumChip
              value={s.classification}
              color={classificationColor(s.classification)}
              label={shortLabel(s.classification)}
              title={humanize(s.classification)}
            />
            {s.npiStatus && (
              <EnumChip
                value={s.npiStatus}
                color={npiStatusColor(s.npiStatus)}
                variant="outlined"
                label={`NPI ${shortLabel(s.npiStatus)}`}
                title={`NPI: ${humanize(s.npiStatus)}`}
              />
            )}
            {s.heldForClassification && <Chip size="small" color="warning" label="Held" />}
            {s.heldForImport && !s.heldForClassification && <Chip size="small" color="info" label="Not processed" />}
            {s.needsReview && <Chip size="small" color="warning" variant="outlined" label={NEEDS_REVIEW_LABEL} />}
          </Stack>
        ) : (
          <HeldBackReason s={s} view={view} />
        )}

        {/* Footer: what is attached and who has it on the left, actions on the right. */}
        <Stack direction="row" alignItems="center" spacing={1} sx={{ pt: 0.25 }}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.75}
            sx={{ flex: 1, minWidth: 0, '& .MuiChip-label': { px: 0.75 } }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
              {s.documentCount} {s.documentCount === 1 ? 'doc' : 'docs'}
            </Typography>
            {view === 'submissions' && (
              <>
                <ReportChip s={s} tab="synthesis" version={s.latestSynthesisVersion} />
                <ReportChip s={s} tab="analysis" version={s.latestAnalysisVersion} />
                <Typography variant="caption" color={s.assignedTo ? 'text.secondary' : 'text.disabled'} noWrap>
                  {s.assignedTo?.name ?? 'Unassigned'}
                </Typography>
              </>
            )}
          </Stack>
          <Stack direction="row" alignItems="center" onClick={stop} sx={{ flexShrink: 0, mr: -0.75 }}>
            {view !== 'submissions' && writable && (
              <Button
                size="small"
                variant="outlined"
                disabled={releasing}
                onClick={() => release.mutate(s)}
                startIcon={view === 'errors' ? <RefreshIcon /> : undefined}
                sx={{ mr: 0.5 }}
              >
                {releasing
                  ? 'Queuing…'
                  : view === 'errors'
                    ? 'Retry'
                    : view === 'duplicates'
                      ? 'Process anyway'
                      : 'Process'}
              </Button>
            )}
            {view === 'submissions' && writable && awaitingProcess(s) && (
              <Button
                size="small"
                variant="outlined"
                disabled={processImported.isPending && processImported.variables?.id === s.id}
                onClick={() => processImported.mutate(s)}
                startIcon={<PlayArrowIcon />}
                aria-label={`Process ${name}`}
                sx={{ mr: 0.5 }}
              >
                {processImported.isPending && processImported.variables?.id === s.id ? 'Queuing…' : 'Process'}
              </Button>
            )}
            <Tooltip title={s.isRead ? 'Mark as unread' : 'Mark as read'}>
              <span>
                <IconButton
                  size="small"
                  disabled={toggleRead.isPending && toggleRead.variables?.id === s.id}
                  aria-label={s.isRead ? `Mark ${name} as unread` : `Mark ${name} as read`}
                  onClick={() => toggleRead.mutate(s)}
                >
                  {s.isRead ? <MarkAsUnreadIcon fontSize="small" /> : <MarkAsReadIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
            {canDelete && <DeleteButton s={s} onDelete={() => actions.deletion.setTarget(s)} compact />}
          </Stack>
        </Stack>
      </Stack>
    </Box>
  );
}

const visuallyHiddenInline = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

/**
 * One page of the inbox on a phone (QA-004): a list of cards instead of the wide table, so the subject, sender and
 * status read first without scrolling sideways. Same data, same actions; a tap opens the submission.
 */
export function InboxCards({
  items,
  view,
  writable,
  canDelete,
  actions,
}: {
  items: SubmissionSummary[];
  view: InboxView;
  writable: boolean;
  canDelete: boolean;
  actions: InboxActions;
}) {
  const { pageIds, pageSelected, togglePage } = actions.selection;
  return (
    <Box>
      {canDelete && pageIds.length > 0 && (
        <Stack direction="row" alignItems="center" sx={{ px: 0.5 }}>
          <Checkbox
            size="small"
            checked={pageSelected === pageIds.length}
            indeterminate={pageSelected > 0 && pageSelected < pageIds.length}
            onChange={togglePage}
            inputProps={{ 'aria-label': 'Select all on this page' }}
          />
          <Typography variant="caption" color="text.secondary">
            {pageSelected ? `${pageSelected} selected` : 'Select all'}
          </Typography>
        </Stack>
      )}
      <Stack component="ul" spacing={1} sx={{ p: 0, m: 0, pt: 0.5 }} aria-label="Emails">
        {items.map((s) => (
          <InboxCard key={s.id} s={s} view={view} writable={writable} canDelete={canDelete} actions={actions} />
        ))}
      </Stack>
    </Box>
  );
}
