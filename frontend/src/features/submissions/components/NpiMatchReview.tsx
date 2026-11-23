// NPI result card footer: an underwriter's decision on a partial match. "Change match" records a decision and reason;
// the decision stands through re-verification until the registry differences change.
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { formatDateTime, humanize } from '../../../lib/status';
import { api, errorMessage } from '../../../services/api';
import type { NpiVerification, SubmissionDetail } from '../../../types';
import { auditKeys } from '../../audit';
import { submissionKeys } from '../queryKeys';

type Decision = 'MATCH' | 'MISMATCH';

export function NpiMatchReview({ s, v }: { s: SubmissionDetail; v: NpiVerification }) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState('');

  const toast = useToast();
  const onSuccess = (list: NpiVerification[]) => {
    qc.setQueryData<SubmissionDetail>(submissionKeys.detail(s.id), (old) =>
      old ? { ...old, npiVerifications: list } : old,
    );
    qc.invalidateQueries({ queryKey: submissionKeys.detail(s.id) });
    qc.invalidateQueries({ queryKey: submissionKeys.lists() });
    qc.invalidateQueries({ queryKey: auditKeys.all() });
  };
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.overrideNpi(s.id, v.id, { status: decision!, note: note.trim() }),
    onSuccess: (list) => {
      onSuccess(list);
      setOpen(false);
      toast.success(TOAST_MESSAGES.npiDecisionSaved);
    },
  });
  const undo = useMutation({
    mutationFn: () => api.undoNpiOverride(s.id, v.id),
    onSuccess: (list) => {
      onSuccess(list);
      toast.success(TOAST_MESSAGES.npiDecisionUndone);
    },
    onError: (err) => toast.error(err),
  });

  const reviewable = v.status === 'PARTIAL_MATCH' || v.autoStatus === 'PARTIAL_MATCH';
  if (!reviewable || (!writable && !v.autoStatus)) return null;

  const start = () => {
    setDecision(v.autoStatus ? (v.status as Decision) : null);
    setNote(v.overrideNote ?? '');
    save.reset();
    setOpen(true);
  };
  const canSave = decision !== null && note.trim() !== '' && !save.isPending;

  return (
    <>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        useFlexGap
        sx={{ mt: 1 }}
      >
        {v.autoStatus ? (
          <Typography variant="caption" color="text.secondary">
            {v.status === 'MATCH' ? 'Confirmed as a match' : 'Marked as a mismatch'} by{' '}
            {v.overrideBy?.name ?? 'an underwriter'}
            {v.overrideAt ? ` on ${formatDateTime(v.overrideAt)}` : ''} · registry check: {humanize(v.autoStatus)} ·{' '}
            {v.overrideNote}
          </Typography>
        ) : (
          <Typography variant="caption" color="text.secondary">
            Check the differences above and decide whether this NPI is the applicant’s.
          </Typography>
        )}
        {writable && (
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={start}>
              Change match
            </Button>
            {v.autoStatus && (
              <Button size="small" disabled={undo.isPending} onClick={() => undo.mutate()}>
                {undo.isPending ? 'Undoing…' : 'Undo'}
              </Button>
            )}
          </Stack>
        )}
      </Stack>

      <Dialog open={open} onClose={() => !save.isPending && setOpen(false)} fullWidth maxWidth="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save.mutate();
          }}
          noValidate
        >
          <DialogTitle>Change NPI match</DialogTitle>
          <DialogContent dividers>
            <DialogContentText sx={{ mb: 1.5 }}>
              NPI {v.npi} partly matches the CMS registry. Your decision is used in the inbox and in new reports, and is
              recorded in the audit trail.
            </DialogContentText>
            <RadioGroup value={decision ?? ''} onChange={(e) => setDecision(e.target.value as Decision)} sx={{ mb: 1 }}>
              <FormControlLabel
                value="MATCH"
                control={<Radio size="small" />}
                label="Match: this NPI is the applicant’s"
              />
              <FormControlLabel
                value="MISMATCH"
                control={<Radio size="small" />}
                label="Mismatch: this NPI is not the applicant’s"
              />
            </RadioGroup>
            <TextField
              label="Reason"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              fullWidth
              multiline
              minRows={2}
              inputProps={{ maxLength: 1000 }}
              helperText="Required. For example: state differs because the provider moved; license confirmed with the broker."
            />
            {save.isError && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {errorMessage(save.error)}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={!canSave}>
              {save.isPending ? 'Saving…' : 'Save decision'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}
