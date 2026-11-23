import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Box,
  Button,
  IconButton,
  LinearProgress,
  Paper,
  TablePagination,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, ErrorState, PageHeader } from '../../../components/common';
import { INBOX_ROWS_PER_PAGE_OPTIONS, POLL_MS } from '../../../constants';
import { paths } from '../../../paths';
import { apiWith } from '../../../services/api';
import { gmailKeys } from '../../settings';
import { SkippedEmailsPanel } from '../components/SkippedEmailsPanel';
import { DeleteInboxDialog } from '../inbox/DeleteInboxDialog';
import { FailedGmailPanel } from '../inbox/FailedGmailPanel';
import { InboxCards } from '../inbox/InboxCards';
import { EMPTY } from '../inbox/inboxOptions';
import { InboxSkeleton } from '../inbox/InboxSkeleton';
import { InboxTable } from '../inbox/InboxTable';
import { InboxToolbar } from '../inbox/InboxToolbar';
import { NewSubmissionDialog } from '../inbox/NewSubmissionDialog';
import { useInboxActions } from '../inbox/useInboxActions';
import { useInboxParams } from '../inbox/useInboxParams';
import { submissionKeys } from '../queryKeys';

/** The inbox: one tab of emails (submissions, ignored, duplicates, errors), filtered, paged and polled. */
export function SubmissionInbox() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const canDelete = hasPermission(user, 'submission:delete');
  const p = useInboxParams();
  const { view, status, classification, strength, q, page, pageSize } = p;
  // Phones get cards instead of the wide table (QA-004).
  const phone = useMediaQuery(useTheme().breakpoints.down('sm'));
  const [newOpen, setNewOpen] = useState(false);

  const list = useQuery({
    queryKey: submissionKeys.list({ view, status, classification, strength, q, page, pageSize }),
    queryFn: ({ signal }) =>
      apiWith(signal).listSubmissions({ view, status, classification, strength, q, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.classifying ? POLL_MS.inboxClassifying : POLL_MS.inbox),
  });
  // Refresh is only offered while a mailbox is connected; the list still polls on its own either way.
  const gmail = useQuery({
    queryKey: gmailKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).gmailStatus(),
    refetchInterval: POLL_MS.gmailStatusInbox,
  });
  // Gmail messages that failed to import are not submissions yet; the Errors tab lists them above the failed submissions.
  const failed = useQuery({
    queryKey: submissionKeys.failedIngest(),
    queryFn: ({ signal }) => apiWith(signal).failedGmailMessages(),
    refetchInterval: POLL_MS.failedGmail,
  });
  const failedItems = failed.data?.items ?? [];
  // Emails skipped at intake are not stored as rows, but they are ignored emails too: counted on the Ignored tab and listed under it.
  const skipped = useQuery({
    queryKey: submissionKeys.skippedCount(q),
    queryFn: ({ signal }) => apiWith(signal).skippedEmails({ q: q || undefined, pageSize: 1 }),
    refetchInterval: POLL_MS.skippedEmails,
  });
  const skippedCount = skipped.data?.total ?? 0;

  const actions = useInboxActions(p, list.data, { writable, canDelete });

  return (
    <Box>
      <PageHeader
        title="Submission Inbox"
        subtitle="Emails detected from the monitored mailbox and manual intakes, newest first."
        actions={
          <>
            {gmail.data?.connected && (
              <Tooltip title="Refresh">
                <span>
                  <IconButton aria-label="Refresh" onClick={() => list.refetch()} disabled={list.isFetching}>
                    <RefreshIcon />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {writable && (
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
                New manual submission
              </Button>
            )}
          </>
        }
      />

      <Paper variant="outlined" sx={{ p: 1.5, overflow: 'hidden', minWidth: 0 }}>
        <InboxToolbar
          p={p}
          list={list.data}
          actions={actions}
          writable={writable}
          canDelete={canDelete}
          extraCounts={{ errors: failedItems.length, ignored: skippedCount }}
        />
        {view === 'errors' && failedItems.length > 0 && <FailedGmailPanel items={failedItems} writable={writable} />}
        {list.isFetching && !list.isLoading && <LinearProgress sx={{ height: 2 }} />}
        {list.isError ? (
          <Box sx={{ p: 2 }}>
            <ErrorState error={list.error} onRetry={() => list.refetch()} title="Could not load submissions" />
          </Box>
        ) : list.isLoading ? (
          <InboxSkeleton columns={view === 'submissions' ? 9 : 5} cards={phone} />
        ) : list.data && list.data.items.length === 0 ? (
          view === 'ignored' && skippedCount > 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2 }}>
              {p.hasFilters ? 'No stored ignored emails match these filters.' : 'No stored ignored emails.'} Emails
              skipped at intake are listed below.
            </Typography>
          ) : (
            <EmptyState
              title={p.hasFilters ? 'No emails match these filters' : EMPTY[view].title}
              description={
                p.hasFilters ? 'Try clearing the filters or broadening your search.' : EMPTY[view].description
              }
            />
          )
        ) : phone ? (
          <InboxCards
            items={list.data?.items ?? []}
            view={view}
            writable={writable}
            canDelete={canDelete}
            actions={actions}
          />
        ) : (
          <InboxTable
            items={list.data?.items ?? []}
            view={view}
            writable={writable}
            canDelete={canDelete}
            actions={actions}
          />
        )}
        {list.data && list.data.total > 0 && (
          <TablePagination
            component="div"
            count={list.data.total}
            page={page - 1}
            rowsPerPage={pageSize}
            rowsPerPageOptions={INBOX_ROWS_PER_PAGE_OPTIONS}
            onPageChange={(_, n) => p.update({ page: n + 1 })}
            onRowsPerPageChange={(e) => p.update({ pageSize: e.target.value, page: null })}
            // Phones have room for the arrows and the range, not the rows-per-page picker.
            labelRowsPerPage={phone ? '' : undefined}
            sx={
              phone
                ? {
                    '& .MuiTablePagination-toolbar': { px: 0.5 },
                    '& .MuiTablePagination-selectLabel, & .MuiTablePagination-input': { display: 'none' },
                  }
                : undefined
            }
          />
        )}
      </Paper>
      {view === 'ignored' && <SkippedEmailsPanel key={q} q={q} writable={writable} canDelete={canDelete} />}
      <DeleteInboxDialog view={view} hasFilters={p.hasFilters} deletion={actions.deletion} />
      <NewSubmissionDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => navigate(paths.submission(id))}
      />
    </Box>
  );
}
