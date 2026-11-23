import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

import { errorMessage } from '../../../services/api';
import type { InboxView } from '../../../types';
import { NOUN } from './inboxOptions';
import type { InboxActions } from './useInboxActions';

/** Confirms deleting one row, the selected rows, or every row of the tab matching its search and filters. */
export function DeleteInboxDialog({
  view,
  hasFilters,
  deletion,
}: {
  view: InboxView;
  hasFilters: boolean;
  deletion: InboxActions['deletion'];
}) {
  const { target, setTarget, count, remove } = deletion;
  const noun = NOUN[view];
  return (
    <Dialog open={!!target} onClose={() => !remove.isPending && setTarget(null)} maxWidth="xs" fullWidth>
      <DialogTitle>
        {target === 'all'
          ? `Delete ${hasFilters ? 'matching' : 'all'} ${noun}s?`
          : target === 'selected'
            ? `Delete selected ${noun}s?`
            : `Delete this ${noun}?`}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" gutterBottom>
          {target && typeof target === 'object'
            ? `"${target.subject || '(no subject)'}" will be removed from the inbox for everyone.`
            : `${count} ${noun}${count === 1 ? '' : 's'}${target === 'all' && hasFilters ? ' matching the search and filters' : ''} will be removed from the inbox for everyone.`}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {view !== 'duplicates' && 'Copies held as duplicates of them are deleted too. '}
          {target === 'all' && view === 'submissions' && 'Emails still being processed are skipped. '}
          They will not be imported from Gmail again, and their history stays in the audit trail.
        </Typography>
        {remove.isError && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {errorMessage(remove.error)}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setTarget(null)} disabled={remove.isPending}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          disabled={remove.isPending}
          onClick={() => target && remove.mutate(target)}
        >
          {remove.isPending ? 'Deleting…' : target && typeof target === 'object' ? 'Delete' : `Delete ${count}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
