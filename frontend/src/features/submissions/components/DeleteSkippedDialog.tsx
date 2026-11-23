import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { UseMutationResult } from '@tanstack/react-query';

import { errorMessage } from '../../../services/api';
import type { SkippedEmail } from '../../../types';

/** One skipped email, the ticked ones, or every one matching the search. */
export type SkippedDeleteTarget = SkippedEmail | 'selected' | 'all';

/** Confirms deleting skipped emails from the Ignored tab. */
export function DeleteSkippedDialog({
  target,
  count,
  searching,
  remove,
  onClose,
}: {
  target: SkippedDeleteTarget | null;
  count: number;
  searching: boolean;
  remove: UseMutationResult<{ deleted: number }, Error, SkippedDeleteTarget>;
  onClose: () => void;
}) {
  const one = target && typeof target === 'object';
  return (
    <Dialog open={!!target} onClose={() => !remove.isPending && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>
        {one
          ? 'Delete this skipped email?'
          : target === 'selected'
            ? 'Delete selected skipped emails?'
            : `Delete ${searching ? 'matching' : 'all'} skipped emails?`}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" gutterBottom>
          {one
            ? `"${target.subject || '(no subject)'}" will be removed from the Ignored tab for everyone.`
            : `${count} skipped email${count === 1 ? '' : 's'}${target === 'all' && searching ? ' matching the search' : ''} will be removed from the Ignored tab for everyone.`}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          They will not be imported from Gmail again or offered for processing, and the deletion stays in the audit
          trail.
        </Typography>
        {remove.isError && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {errorMessage(remove.error)}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={remove.isPending}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={remove.isPending}
          onClick={() => target && remove.mutate(target)}
        >
          {remove.isPending ? 'Deleting…' : one ? 'Delete' : `Delete ${count}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
