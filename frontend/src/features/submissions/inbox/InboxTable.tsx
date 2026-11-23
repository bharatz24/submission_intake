import MarkAsReadIcon from '@mui/icons-material/Drafts';
import MarkAsUnreadIcon from '@mui/icons-material/MarkEmailUnreadOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Box,
  Checkbox,
  Chip,
  IconButton,
  Link,
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
import type { MouseEvent } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';

import { EnumChip } from '../../../components/common';
import {
  classificationColor,
  formatDateTime,
  formatPercent,
  formatRelative,
  formatShortDateTime,
  humanize,
  nameTypeLabel,
  npiStatusColor,
  shortLabel,
  submissionStatusColor,
} from '../../../lib/status';
import { paths } from '../../../paths';
import type { InboxView, SubmissionSummary } from '../../../types';
import { NEEDS_REVIEW_LABEL } from '../components/NeedsReviewChip';
import { awaitingProcess, DeleteButton, HeldBackCells, isBusy, ReportChip, revealOnHover } from './InboxCells';
import type { InboxActions } from './useInboxActions';

/** Column widths: a fixed layout, so long subjects and names ellipsize instead of widening the table into a scroll. */
function InboxColumns({
  view,
  selectable,
  writable,
  actionsWidth,
}: {
  view: InboxView;
  selectable: boolean;
  writable: boolean;
  actionsWidth: number;
}) {
  if (view === 'submissions') {
    return (
      <colgroup>
        {selectable && <col style={{ width: 48 }} />}
        <col style={{ width: 118 }} />
        <col />
        <col style={{ width: '15%' }} />
        <col style={{ width: 148 }} />
        <col style={{ width: 96 }} />
        <col style={{ width: 84 }} />
        <col style={{ width: 60 }} />
        <col style={{ width: 80 }} />
        <col style={{ width: '10%' }} />
        <col style={{ width: actionsWidth }} />
      </colgroup>
    );
  }
  return (
    <colgroup>
      {selectable && <col style={{ width: 48 }} />}
      <col style={{ width: 150 }} />
      <col style={{ width: view === 'duplicates' ? '28%' : '34%' }} />
      <col />
      {view === 'duplicates' && <col style={{ width: '22%' }} />}
      {view === 'ignored' && <col style={{ width: 84 }} />}
      <col style={{ width: 64 }} />
      {writable && <col style={{ width: view === 'duplicates' ? 150 : view === 'errors' ? 110 : 180 }} />}
      <col style={{ width: actionsWidth }} />
    </colgroup>
  );
}

function InboxHead({
  view,
  selectable,
  writable,
  actions,
}: {
  view: InboxView;
  selectable: boolean;
  writable: boolean;
  actions: InboxActions;
}) {
  const { pageIds, pageSelected, togglePage } = actions.selection;
  return (
    <TableHead>
      <TableRow>
        {selectable && (
          <TableCell padding="checkbox">
            <Checkbox
              size="small"
              checked={pageIds.length > 0 && pageSelected === pageIds.length}
              indeterminate={pageSelected > 0 && pageSelected < pageIds.length}
              onChange={togglePage}
              inputProps={{ 'aria-label': 'Select all on this page' }}
            />
          </TableCell>
        )}
        <TableCell>Received</TableCell>
        <TableCell>Subject / From</TableCell>
        {view === 'submissions' ? (
          <>
            <TableCell>Applicant</TableCell>
            <TableCell>Classification</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>NPI</TableCell>
            <TableCell align="center" sx={{ px: 1 }}>
              Docs
            </TableCell>
            <TableCell sx={{ px: 1 }}>Reports</TableCell>
            <TableCell>Assigned</TableCell>
          </>
        ) : (
          <>
            <TableCell>{view === 'errors' ? 'Error' : 'Reason'}</TableCell>
            {view === 'duplicates' && <TableCell>Duplicate of</TableCell>}
            {view === 'ignored' && (
              <TableCell>
                <Tooltip title="How likely this email was a submission after all: 100% minus the classifier's confidence that it was not. Above 15% is highlighted.">
                  <span>Chance</span>
                </Tooltip>
              </TableCell>
            )}
            <TableCell align="center" sx={{ px: 0.5 }}>
              Docs
            </TableCell>
            {writable && (
              <TableCell align="right">
                <Box component="span" sx={visuallyHidden}>
                  Actions
                </Box>
              </TableCell>
            )}
          </>
        )}
        <TableCell padding="none">
          <Box component="span" sx={visuallyHidden}>
            Row actions
          </Box>
        </TableCell>
      </TableRow>
    </TableHead>
  );
}

// Screen-reader-only text. Sizes are strings on purpose: in sx a bare `1` means 100%, which made this span overflow the page.
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

/** The columns only the Submissions tab shows. */
function SubmissionCells({ s }: { s: SubmissionSummary }) {
  return (
    <>
      <TableCell>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap title={s.applicantName ?? undefined}>
            {s.applicantName ?? '—'}
          </Typography>
          {s.applicantType && (
            <Typography variant="caption" color="text.secondary" noWrap display="block">
              {nameTypeLabel(s.applicantType)}
            </Typography>
          )}
        </Box>
      </TableCell>
      <TableCell sx={{ pr: 1 }}>
        {/* Wraps so the held / not-processed flag drops to its own line instead of being clipped by the fixed column. */}
        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <EnumChip
            value={s.classification}
            color={classificationColor(s.classification)}
            label={shortLabel(s.classification)}
            title={humanize(s.classification)}
          />
          {s.heldForClassification && (
            <Tooltip title="Waiting for an underwriter to confirm the classification">
              <Chip size="small" color="warning" label="Held" />
            </Tooltip>
          )}
          {s.heldForImport && !s.heldForClassification && (
            <Tooltip title="Imported email: classified only. Open it and press Process to run extraction, NPI and reports">
              <Chip size="small" color="info" label="Not processed" />
            </Tooltip>
          )}
          {s.classificationConfidence !== null && (
            <Typography variant="caption" color="text.secondary">
              {formatPercent(s.classificationConfidence)}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell>
        <EnumChip
          value={s.status}
          color={submissionStatusColor(s.status)}
          label={shortLabel(s.status)}
          title={humanize(s.status)}
        />
      </TableCell>
      <TableCell>
        {/* npiStatus is the best check: one matching NPI verifies the submission, the others are only noted. */}
        <EnumChip
          value={s.npiStatus}
          color={npiStatusColor(s.npiStatus)}
          variant="outlined"
          label={shortLabel(s.npiStatus)}
          title={
            s.npiVerifiedCount > 0 && s.npiFailedCount > 0
              ? `NPI: ${humanize(s.npiStatus)} · matched on ${s.npiVerifiedCount} of ${s.npiVerifiedCount + s.npiFailedCount} NPIs`
              : `NPI: ${humanize(s.npiStatus)}`
          }
        />
      </TableCell>
      <TableCell align="center" sx={{ px: 1 }}>
        {s.documentCount}
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap', px: 1 }}>
        <Stack spacing={0.5} alignItems="flex-start" sx={{ '& .MuiChip-label': { px: 0.75 } }}>
          <ReportChip s={s} tab="synthesis" version={s.latestSynthesisVersion} />
          <ReportChip s={s} tab="analysis" version={s.latestAnalysisVersion} />
        </Stack>
      </TableCell>
      <TableCell>
        <Typography variant="body2" noWrap>
          {s.assignedTo?.name ?? (
            <Box component="span" color="text.disabled">
              Unassigned
            </Box>
          )}
        </Typography>
      </TableCell>
    </>
  );
}

function InboxRow({
  s,
  view,
  selectable,
  writable,
  canDelete,
  actions,
}: {
  s: SubmissionSummary;
  view: InboxView;
  selectable: boolean;
  writable: boolean;
  canDelete: boolean;
  actions: InboxActions;
}) {
  const navigate = useNavigate();
  const { selected, toggle } = actions.selection;
  const { release, toggleRead, processImported } = actions;
  return (
    <TableRow hover selected={selected.has(s.id)} sx={revealOnHover} onClick={() => navigate(paths.submission(s.id))}>
      {selectable && (
        <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            size="small"
            checked={selected.has(s.id)}
            onChange={() => toggle(s.id)}
            disabled={isBusy(s)}
            title={isBusy(s) ? 'Still being processed' : undefined}
            inputProps={{ 'aria-label': `Select ${s.subject || 'email'}` }}
          />
        </TableCell>
      )}
      <TableCell
        sx={{ whiteSpace: 'nowrap', verticalAlign: 'middle', overflow: 'hidden' }}
        title={formatDateTime(s.receivedAt)}
      >
        <Typography variant="body2" noWrap>
          {formatRelative(s.receivedAt)}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap display="block">
          {formatShortDateTime(s.receivedAt)}
        </Typography>
      </TableCell>
      <TableCell>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            {!s.isRead && (
              <Box
                component="span"
                aria-label="Unread"
                sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0 }}
              />
            )}
            {/* The row's real link (FE-01): reachable with Tab, opens with Enter, and middle-click / Ctrl+click open a
                new tab. A click anywhere else on the row still opens the submission, as a mouse convenience. */}
            <Link
              component={RouterLink}
              to={paths.submission(s.id)}
              onClick={(e: MouseEvent) => e.stopPropagation()}
              variant="body2"
              color="inherit"
              underline="hover"
              noWrap
              title={s.subject}
              sx={{ fontWeight: s.isRead ? 500 : 700, display: 'block', minWidth: 0 }}
            >
              {s.subject || '(no subject)'}
            </Link>
          </Stack>
          <Typography variant="caption" color="text.secondary" noWrap display="block" title={s.fromAddress}>
            {s.fromAddress}
          </Typography>
        </Box>
      </TableCell>
      {view !== 'submissions' ? (
        <HeldBackCells
          s={s}
          view={view}
          writable={writable}
          releasing={release.isPending && release.variables?.id === s.id}
          onRelease={() => release.mutate(s)}
        />
      ) : (
        <SubmissionCells s={s} />
      )}
      <TableCell
        padding="none"
        sx={{ verticalAlign: 'middle', whiteSpace: 'nowrap', pr: 1 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Every icon gets the same padding, so they sit evenly spaced. */}
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="flex-end"
          sx={{ '& .MuiIconButton-root': { p: 0.5 } }}
        >
          {/* An imported email waiting for Process: stays visible (not on hover) because it is the row's next step. */}
          {view === 'submissions' && writable && awaitingProcess(s) && (
            <Tooltip title="Process: read documents, extract fields, check NPIs and run the reports">
              <span>
                <IconButton
                  size="small"
                  color="primary"
                  disabled={processImported.isPending && processImported.variables?.id === s.id}
                  aria-label={`Process ${s.subject || 'email'}`}
                  onClick={() => processImported.mutate(s)}
                >
                  <PlayArrowIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {/* An automatic report or quote nobody has acknowledged yet: opens the submission to review it. */}
          {view === 'submissions' && s.needsReview && (
            <Tooltip title={`${NEEDS_REVIEW_LABEL}. Open to review`}>
              <span className="reveal">
                <IconButton
                  size="small"
                  color="warning"
                  aria-label={`Review ${s.subject || 'email'}: ${NEEDS_REVIEW_LABEL}`}
                  onClick={() => navigate(paths.submission(s.id))}
                >
                  <VisibilityIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          {/* Unread rows keep their "mark as read" icon visible; everything else shows on hover or keyboard focus. */}
          <Tooltip title={s.isRead ? 'Mark as unread' : 'Mark as read'}>
            <span className={s.isRead ? 'reveal' : undefined}>
              <IconButton
                size="small"
                disabled={toggleRead.isPending && toggleRead.variables?.id === s.id}
                aria-label={
                  s.isRead ? `Mark ${s.subject || 'email'} as unread` : `Mark ${s.subject || 'email'} as read`
                }
                onClick={() => toggleRead.mutate(s)}
              >
                {s.isRead ? (
                  <MarkAsUnreadIcon fontSize="small" />
                ) : (
                  <MarkAsReadIcon fontSize="small" sx={{ color: 'text.primary' }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
          {canDelete && (
            <span className="reveal">
              <DeleteButton s={s} onDelete={() => actions.deletion.setTarget(s)} compact />
            </span>
          )}
        </Stack>
      </TableCell>
    </TableRow>
  );
}

/** One page of the inbox: a fixed-layout table whose columns depend on the tab. */
export function InboxTable({
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
  const selectable = canDelete;
  // The last column: process + needs-review (Submissions tab), read toggle, plus delete when allowed; 28px per icon.
  const actionsWidth = (view === 'submissions' ? (writable ? 56 : 28) : 0) + (canDelete ? 76 : 40);
  return (
    <TableContainer>
      <Table
        size="small"
        sx={{
          tableLayout: 'fixed',
          minWidth: view === 'submissions' ? 880 : 720,
          '& .MuiTableCell-root': { overflow: 'hidden' },
        }}
      >
        <InboxColumns view={view} selectable={selectable} writable={writable} actionsWidth={actionsWidth} />
        <InboxHead view={view} selectable={selectable} writable={writable} actions={actions} />
        <TableBody>
          {items.map((s) => (
            <InboxRow
              key={s.id}
              s={s}
              view={view}
              selectable={selectable}
              writable={writable}
              canDelete={canDelete}
              actions={actions}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
