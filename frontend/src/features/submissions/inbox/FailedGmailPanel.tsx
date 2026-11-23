import { Alert, Button, List, ListItem, ListItemText, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../../../components/feedback/FeedbackProvider';
import { FAILURE_MESSAGES, POLL_MS, TOAST_MESSAGES } from '../../../constants';
import { friendlyMessage } from '../../../lib/friendlyError';
import { formatRelative } from '../../../lib/status';
import { api } from '../../../services/api';
import type { FailedGmailMessage } from '../../../types';
import { submissionKeys } from '../queryKeys';

/**
 * Gmail messages that could not be imported (classification or storage failed). They retry on their own with back-off;
 * Retry makes one due now. Only the Gmail id and error are known: the email is stored once an attempt succeeds.
 */
export function FailedGmailPanel({ items, writable }: { items: FailedGmailMessage[]; writable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: (id: string) => api.retryGmailMessage(id),
    // The retry runs in the background; refresh shortly after so a message that imported drops off the list.
    onSuccess: () => {
      toast.success(TOAST_MESSAGES.gmailRetryQueued);
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: submissionKeys.failedIngest() });
        qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      }, POLL_MS.failedGmailRetryRefresh);
    },
    onError: (err) => toast.error(err),
  });
  return (
    <Alert severity="warning" sx={{ mx: 1.5, mb: 1.5, '& .MuiAlert-message': { flex: 1, minWidth: 0 } }}>
      <Typography variant="body2" fontWeight={600} gutterBottom>
        {items.length} Gmail {items.length === 1 ? 'message' : 'messages'} failed to import
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Nothing is stored for these yet. They are retried automatically; Retry tries one again now.
      </Typography>
      <List dense disablePadding>
        {items.map((m) => (
          <ListItem
            key={m.gmailMessageId}
            disableGutters
            divider
            secondaryAction={
              writable && (
                <Button
                  size="small"
                  variant="outlined"
                  disabled={retry.isPending && retry.variables === m.gmailMessageId}
                  onClick={() => retry.mutate(m.gmailMessageId)}
                >
                  {retry.isPending && retry.variables === m.gmailMessageId
                    ? 'Retrying…'
                    : retry.isSuccess && retry.variables === m.gmailMessageId
                      ? 'Queued'
                      : 'Retry'}
                </Button>
              )
            }
            sx={{ pr: writable ? 12 : 0 }}
          >
            <ListItemText
              primary={
                <Typography
                  variant="body2"
                  noWrap
                  title={friendlyMessage(m.lastError, { empty: FAILURE_MESSAGES.noReason })}
                >
                  {friendlyMessage(m.lastError, { empty: FAILURE_MESSAGES.noReason })}
                </Typography>
              }
              secondary={`Gmail ${m.gmailMessageId} · ${m.attempts} ${m.attempts === 1 ? 'attempt' : 'attempts'} · first seen ${formatRelative(m.firstSeenAt)} · ${m.parked ? 'stopped retrying: retry it by hand' : `next try ${formatRelative(m.nextAttemptAt)}`}`}
            />
          </ListItem>
        ))}
      </List>
    </Alert>
  );
}
