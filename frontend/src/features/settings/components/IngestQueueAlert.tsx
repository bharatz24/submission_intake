import SyncIcon from '@mui/icons-material/Sync';
import { Alert, Button } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { formatRelative } from '../../../lib/status';
import { api } from '../../../services/api';
import type { MonitoringStats } from '../../../types';
import { monitoringKeys } from '../queryKeys';

/** Gmail messages not stored yet (e.g. Google Drive down). They are retried automatically; admins can retry now. */
export function IngestQueueAlert({ queue }: { queue: MonitoringStats['ingestQueue'] }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: api.retryIngestQueue,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: monitoringKeys.all() });
      toast.success(TOAST_MESSAGES.ingestRetryQueued(r.queued));
    },
    onError: (err) => toast.error(err),
  });
  const delayed = queue.alerted > 0;
  return (
    <Alert
      severity={delayed ? 'warning' : 'info'}
      action={
        delayed && hasPermission(user, 'gmail:manage') ? (
          <Button
            color="inherit"
            size="small"
            startIcon={<SyncIcon />}
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Retry now
          </Button>
        ) : undefined
      }
    >
      {queue.waiting} Gmail message{queue.waiting === 1 ? '' : 's'} waiting to be stored
      {delayed ? ` · ${queue.alerted} delayed after repeated failures (see Errors)` : ' · retried automatically'}
      {queue.oldest ? ` · oldest ${formatRelative(queue.oldest)}` : ''}
    </Alert>
  );
}
