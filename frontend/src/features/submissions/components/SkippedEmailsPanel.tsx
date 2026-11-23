// Ignored tab, below the stored rows: Gmail emails the intake rules skipped as not a submission. Nothing of them is
// stored but sender, subject and the reasons; "Process as submission" fetches one from Gmail again and processes it.
import AttachFileIcon from '@mui/icons-material/AttachFile';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useToast } from '../../../components/feedback/FeedbackProvider';
import { INBOX_ROWS_PER_PAGE_OPTIONS, PAGE_SIZE, POLL_MS, TOAST_MESSAGES } from '../../../constants';
import { formatDateTime, formatPercent, formatRelative, formatShortDateTime } from '../../../lib/status';
import { paths } from '../../../paths';
import { api, apiWith } from '../../../services/api';
import { submissionKeys } from '../queryKeys';
import { DeleteSkippedDialog, type SkippedDeleteTarget } from './DeleteSkippedDialog';

export function SkippedEmailsPanel({ q, writable, canDelete }: { q: string; writable: boolean; canDelete: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE.skippedEmails);
  const list = useQuery({
    queryKey: submissionKeys.skippedPage(q, page, pageSize),
    queryFn: ({ signal }) => apiWith(signal).skippedEmails({ q: q || undefined, page: page + 1, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS.skippedEmails,
  });
  const toast = useToast();
  const process = useMutation({
    mutationFn: (id: string) => api.processSkippedEmail(id),
    onSuccess: ({ submissionId }) => {
      qc.invalidateQueries({ queryKey: submissionKeys.skipped() });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      toast.success(TOAST_MESSAGES.skippedProcessing);
      navigate(paths.submission(submissionId));
    },
    onError: (err) => toast.error(err),
  });

  // Delete (by permission): one email, the ticked ones on this page, or every one matching the search.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<SkippedDeleteTarget | null>(null);
  const pageIds = list.data?.items.map((m) => m.gmailMessageId) ?? [];
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const remove = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (target: SkippedDeleteTarget) =>
      target === 'all'
        ? api.deleteSkippedEmails({ q: q || undefined })
        : target === 'selected'
          ? api.deleteSkippedEmails({ ids: [...selected] })
          : api.deleteSkippedEmail(target.gmailMessageId),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: submissionKeys.skipped() });
      toast.success(TOAST_MESSAGES.skippedDeleted(r.deleted));
      setDeleteTarget(null);
      setSelected(new Set());
    },
  });
  const deleteCount =
    deleteTarget === 'all' ? (list.data?.total ?? 0) : deleteTarget === 'selected' ? selected.size : 1;
  const changePage = (p: number) => {
    setPage(p);
    setSelected(new Set());
  };

  if (!list.data?.total) return null;
  return (
    <Paper variant="outlined" sx={{ mt: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={{ sm: 'flex-start' }}
        sx={{ px: 2, pt: 1.5, pb: 1 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2">Skipped at intake · {list.data.total}</Typography>
          <Typography variant="caption" color="text.secondary">
            Gmail emails the intake rules judged not to be a submission. Only the sender, subject and reasons are kept;
            “Process as submission” fetches the email from Gmail again and processes it.
          </Typography>
        </Box>
        {/* One button, as in the inbox toolbar: the ticked rows when any are ticked, otherwise everything listed. */}
        {canDelete &&
          (selected.size ? (
            <Button
              size="small"
              color="error"
              variant="contained"
              startIcon={<DeleteIcon />}
              onClick={() => setDeleteTarget('selected')}
              sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              Delete selected ({selected.size})
            </Button>
          ) : (
            <Button
              size="small"
              color="error"
              variant="outlined"
              startIcon={<DeleteIcon />}
              onClick={() => setDeleteTarget('all')}
              sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {q ? `Delete matching (${list.data.total})` : `Delete all (${list.data.total})`}
            </Button>
          ))}
      </Stack>
      <TableContainer>
        <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 760 }}>
          <colgroup>
            {canDelete && <col style={{ width: 48 }} />}
            <col style={{ width: 150 }} />
            <col style={{ width: '24%' }} />
            <col />
            <col style={{ width: 110 }} />
            {writable && <col style={{ width: 190 }} />}
            {canDelete && <col style={{ width: 48 }} />}
          </colgroup>
          <TableHead>
            <TableRow>
              {canDelete && (
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={pageIds.length > 0 && pageSelected === pageIds.length}
                    indeterminate={pageSelected > 0 && pageSelected < pageIds.length}
                    onChange={() => setSelected(new Set(pageSelected === pageIds.length ? [] : pageIds))}
                    inputProps={{ 'aria-label': 'Select all skipped emails on this page' }}
                  />
                </TableCell>
              )}
              <TableCell>Received</TableCell>
              <TableCell>From</TableCell>
              <TableCell>Subject</TableCell>
              <TableCell>Not a submission</TableCell>
              {writable && <TableCell align="right" />}
              {canDelete && <TableCell />}
            </TableRow>
          </TableHead>
          <TableBody>
            {list.data.items.map((m) => {
              const busy = process.isPending && process.variables === m.gmailMessageId;
              return (
                <TableRow key={m.gmailMessageId} hover selected={selected.has(m.gmailMessageId)}>
                  {canDelete && (
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={selected.has(m.gmailMessageId)}
                        onChange={() => toggle(m.gmailMessageId)}
                        inputProps={{ 'aria-label': `Select ${m.subject || 'email'}` }}
                      />
                    </TableCell>
                  )}
                  <TableCell
                    sx={{ whiteSpace: 'nowrap', verticalAlign: 'middle', overflow: 'hidden' }}
                    title={formatDateTime(m.receivedAt)}
                  >
                    <Typography variant="body2" noWrap>
                      {formatRelative(m.receivedAt)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap display="block">
                      {formatShortDateTime(m.receivedAt)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" noWrap title={m.fromAddress}>
                      {m.fromAddress}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" noWrap title={m.subject}>
                      {m.attachmentCount > 0 && (
                        <AttachFileIcon
                          sx={{ fontSize: '0.9rem', verticalAlign: 'text-bottom', mr: 0.5, color: 'text.secondary' }}
                        />
                      )}
                      {m.subject || '(no subject)'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Tooltip
                      title={
                        <Box component="ul" sx={{ m: 0, pl: 2 }}>
                          {m.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </Box>
                      }
                    >
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${formatPercent(m.confidence)} · ${m.method === 'RULES' ? 'rules' : 'AI'}`}
                      />
                    </Tooltip>
                  </TableCell>
                  {writable && (
                    <TableCell align="right">
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={process.isPending}
                        onClick={() => process.mutate(m.gmailMessageId)}
                      >
                        {busy ? 'Importing…' : 'Process as submission'}
                      </Button>
                    </TableCell>
                  )}
                  {canDelete && (
                    <TableCell align="right" sx={{ px: 0.5 }}>
                      <Tooltip title="Delete">
                        <IconButton
                          size="small"
                          color="error"
                          aria-label={`Delete ${m.subject || 'email'}`}
                          onClick={() => setDeleteTarget(m)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div"
        count={list.data.total}
        page={page}
        rowsPerPage={pageSize}
        rowsPerPageOptions={INBOX_ROWS_PER_PAGE_OPTIONS}
        onPageChange={(_, p) => changePage(p)}
        onRowsPerPageChange={(e) => {
          setPageSize(Number(e.target.value));
          changePage(0);
        }}
      />
      <DeleteSkippedDialog
        target={deleteTarget}
        count={deleteCount}
        searching={!!q}
        remove={remove}
        onClose={() => {
          setDeleteTarget(null);
          remove.reset();
        }}
      />
    </Paper>
  );
}
