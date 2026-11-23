import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { SortCell } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { friendlyError } from '../../../lib/friendlyError';
import { sortRows, type SortState } from '../../../lib/sort';
import { formatDateTime, formatRelative } from '../../../lib/status';
import { api, errorMessage } from '../../../services/api';
import type { MonitoringStats } from '../../../types';
import { monitoringKeys } from '../queryKeys';

type ErrorSortKey = 'at' | 'scope' | 'message';

export function ErrorsTab({ errors, period }: { errors: MonitoringStats['recentErrors']; period: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [sort, setSort] = useState<SortState<ErrorSortKey>>({ key: 'at', order: 'desc' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();
  const clear = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.clearMonitoringErrors,
    onSuccess: (r) => {
      toast.success(TOAST_MESSAGES.errorsCleared(r.cleared));
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: monitoringKeys.all() });
    },
  });
  if (!errors.length) {
    return (
      <Typography variant="body2" color="success.main">
        No errors {period === 'today' ? 'today' : period === 'all time' ? 'on record' : `in the ${period}`}.
      </Typography>
    );
  }
  return (
    <Stack spacing={1.5}>
      {hasPermission(user, 'monitoring:manage') && (
        <Stack direction="row" justifyContent="flex-end">
          <Button
            size="small"
            color="error"
            variant="outlined"
            onClick={() => {
              clear.reset();
              setConfirmOpen(true);
            }}
          >
            Clear errors
          </Button>
        </Stack>
      )}
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortCell k="at" sort={sort} onSort={setSort} first="desc">
                Time
              </SortCell>
              <SortCell k="scope" sort={sort} onSort={setSort}>
                Scope
              </SortCell>
              <SortCell k="message" sort={sort} onSort={setSort}>
                Message
              </SortCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sortRows(errors, (e) => e[sort.key], sort.order).map((e, i) => {
              // Plain words first; the raw text stays underneath, since this is where admins come for it.
              const { message, technical } = friendlyError(e.message);
              return (
                <TableRow key={`${e.at}-${i}`} hover>
                  <TableCell sx={{ width: 180, whiteSpace: 'nowrap', color: 'text.secondary' }}>
                    <Tooltip title={formatRelative(e.at)}>
                      <span>{formatDateTime(e.at)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ width: 160 }}>
                    <Chip size="small" variant="outlined" label={e.scope} />
                  </TableCell>
                  <TableCell sx={{ wordBreak: 'break-word' }}>
                    <Typography variant="body2" color="error.main">
                      {message}
                    </Typography>
                    {technical && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        display="block"
                        sx={{
                          mt: 0.25,
                          fontFamily: 'ui-monospace, Consolas, monospace',
                          whiteSpace: 'pre-wrap',
                          maxHeight: 96,
                          overflow: 'auto',
                        }}
                      >
                        {technical}
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <Dialog open={confirmOpen} onClose={() => !clear.isPending && setConfirmOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Clear errors?</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {clear.isError && <Alert severity="error">{errorMessage(clear.error)}</Alert>}
            <DialogContentText>
              Every error not yet cleared will be removed from Monitoring, including any outside the period shown. New
              errors will still appear as they happen.
            </DialogContentText>
            <DialogContentText>
              Clearing is recorded in the audit log, and the errors stay in the database.
            </DialogContentText>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={clear.isPending}>
            Cancel
          </Button>
          <Button color="error" variant="contained" disabled={clear.isPending} onClick={() => clear.mutate()}>
            {clear.isPending ? 'Clearing…' : 'Clear errors'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
