// An email brought in by Settings → Import older email: classified when it arrived, nothing else run yet. Process
// runs the rest (documents, extraction, NPI, then the reports as set in Settings → Automation).
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Alert, AlertTitle, Button } from '@mui/material';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { useProcessImported } from '../../../lib/automation';

export function ImportHoldBanner({ id }: { id: string }) {
  const { user } = useAuth();
  const process = useProcessImported(id);
  return (
    <Alert
      severity="info"
      sx={{ mb: 1.5 }}
      action={
        hasPermission(user, 'submission:write') && (
          <Button
            color="inherit"
            size="small"
            variant="outlined"
            startIcon={<PlayArrowIcon />}
            disabled={process.isPending}
            onClick={() => process.mutate()}
            sx={{ whiteSpace: 'nowrap' }}
          >
            {process.isPending ? 'Queuing…' : 'Process'}
          </Button>
        )
      }
    >
      <AlertTitle>Imported, not processed yet</AlertTitle>
      This email came in through Import older email, so it has only been classified. Press Process to read its
      documents, extract the fields, check NPIs and run the reports.
    </Alert>
  );
}
