// NPI tab header: explains why no NPI is verified (assessNpiNeed) and lets an underwriter enter one. The CMS registry
// record appears as soon as 10 digits are typed; Enter adds and verifies it as a manual NPI.
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { STALE_MS, TOAST_MESSAGES } from '../../../constants';
import { isValidNpi } from '../../../lib/links';
import { assessNpiNeed, npiNeedMessage, registryPreview } from '../../../lib/npi';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { SubmissionDetail } from '../../../types';
import { auditKeys } from '../../audit';
import { npiKeys, submissionKeys } from '../queryKeys';

export function NpiEntryBar({
  s,
  onReverify,
  reverifying,
}: {
  s: SubmissionDetail;
  onReverify: () => void;
  reverifying: boolean;
}) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const qc = useQueryClient();
  const need = assessNpiNeed(s.npiVerifications);
  const msg = npiNeedMessage(need);
  const [open, setOpen] = useState(need.kind !== 'VERIFIED' && need.kind !== 'REGISTRY_ERROR');

  // Claimed name and state start blank; left blank, the server compares against the submission's values.
  const [npi, setNpi] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState('');
  const [note, setNote] = useState('');

  const complete = /^\d{10}$/.test(npi);
  const checkDigitOk = complete && isValidNpi(npi);
  const lookup = useQuery({
    queryKey: npiKeys.lookup(npi),
    queryFn: ({ signal }) => apiWith(signal).npiLookup(npi),
    enabled: checkDigitOk,
    staleTime: STALE_MS.npiLookup,
    retry: false,
  });
  const preview = lookup.data?.found ? registryPreview(lookup.data.result) : null;
  const already = s.npiVerifications.some((v) => v.npi === npi);

  const toast = useToast();
  const add = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () =>
      api.addManualNpi(s.id, {
        npi,
        claimedName: name.trim() || undefined,
        claimedState: state.trim() || undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: (list) => {
      qc.setQueryData<SubmissionDetail>(submissionKeys.detail(s.id), (old) =>
        old ? { ...old, npiVerifications: list } : old,
      );
      qc.invalidateQueries({ queryKey: submissionKeys.detail(s.id) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
      toast.success(TOAST_MESSAGES.npiAdded(npi));
      setNpi('');
      setName('');
      setState('');
      setNote('');
    },
  });
  const canAdd =
    checkDigitOk && !already && !add.isPending && (state.trim() === '' || /^[A-Za-z]{2}$/.test(state.trim()));
  const submit = () => {
    if (canAdd) add.mutate();
  };

  return (
    <Stack spacing={1.5} sx={{ mb: 2 }}>
      <Alert
        severity={msg.severity}
        action={
          <Stack direction="row" spacing={1}>
            {need.kind === 'REGISTRY_ERROR' && writable && (
              <Button color="inherit" size="small" variant="outlined" onClick={onReverify} disabled={reverifying}>
                {reverifying ? 'Verifying…' : 'Re-verify'}
              </Button>
            )}
            {writable && !open && (
              <Button color="inherit" size="small" onClick={() => setOpen(true)}>
                {need.kind === 'VERIFIED' ? 'Add an NPI' : 'Enter an NPI'}
              </Button>
            )}
          </Stack>
        }
      >
        <AlertTitle sx={{ mb: 0.25 }}>{msg.title}</AlertTitle>
        {msg.detail}
        {need.kind === 'NO_NPI_STATED' && need.candidates.length > 0 && (
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {need.candidates.map((c) => (
              <Box key={c.npi}>
                {writable ? (
                  <Link
                    component="button"
                    type="button"
                    variant="body2"
                    onClick={() => {
                      setOpen(true);
                      setNpi(c.npi);
                    }}
                    sx={{ fontFamily: 'ui-monospace, Consolas, monospace', mr: 1 }}
                  >
                    {c.npi}
                  </Link>
                ) : (
                  <Box component="span" sx={{ fontFamily: 'ui-monospace, Consolas, monospace', mr: 1 }}>
                    {c.npi}
                  </Box>
                )}
                <Typography component="span" variant="caption">
                  {c.description}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </Alert>

      {writable && (
        <Collapse in={open} unmountOnExit>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              noValidate
            >
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-start' }}>
                <TextField
                  label="NPI"
                  value={npi}
                  autoFocus
                  onChange={(e) => setNpi(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  inputProps={{
                    inputMode: 'numeric',
                    sx: { fontFamily: 'ui-monospace, Consolas, monospace', letterSpacing: 1 },
                  }}
                  error={(complete && !checkDigitOk) || already || add.isError}
                  helperText={
                    complete && !checkDigitOk
                      ? 'Check digit does not match. Check for a typo.'
                      : already
                        ? 'This NPI is already on the submission.'
                        : `${npi.length}/10 digits`
                  }
                  sx={{ width: { md: 230 } }}
                />
                <TextField
                  label="Claimed name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  helperText="Optional"
                  sx={{ flex: 1 }}
                />
                <TextField
                  label="State"
                  value={state}
                  onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
                  error={state !== '' && !/^[A-Z]{2}$/.test(state)}
                  helperText={state !== '' && !/^[A-Z]{2}$/.test(state) ? '2 letters' : 'Optional'}
                  sx={{ width: { md: 90 } }}
                />
                <TextField
                  label="Note (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  sx={{ flex: 1 }}
                />
                <Stack direction="row" spacing={1} sx={{ pt: { md: 1 } }}>
                  <Button type="submit" variant="contained" disabled={!canAdd}>
                    {add.isPending ? 'Verifying…' : 'Add & verify'}
                  </Button>
                  <Button
                    onClick={() => {
                      setOpen(false);
                      setNpi('');
                      setName('');
                      setState('');
                      setNote('');
                      add.reset();
                    }}
                  >
                    Cancel
                  </Button>
                </Stack>
              </Stack>
            </form>
            {add.isError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {errorMessage(add.error)}
              </Alert>
            )}
            {checkDigitOk && (
              <Box sx={{ mt: 1.25, p: 1.25, bgcolor: 'action.hover', borderRadius: 1 }}>
                {lookup.isFetching ? (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <CircularProgress size={14} />
                    <Typography variant="body2">Looking up the CMS NPI Registry…</Typography>
                  </Stack>
                ) : lookup.isError ? (
                  <Typography variant="body2" color="error">
                    Registry lookup failed: {errorMessage(lookup.error)}. You can still add it; it will show as an error
                    until re-verified.
                  </Typography>
                ) : preview ? (
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.4 }}>
                      CMS registry
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {preview.name}
                      {preview.credential ? `, ${preview.credential}` : ''}
                    </Typography>
                    {preview.location && (
                      <Typography variant="body2" color="text.secondary">
                        {preview.location}
                      </Typography>
                    )}
                    {preview.taxonomy && (
                      <Typography variant="body2" color="text.secondary">
                        · {preview.taxonomy}
                      </Typography>
                    )}
                    {preview.active !== null && (
                      <Chip
                        size="small"
                        variant="outlined"
                        color={preview.active ? 'success' : 'error'}
                        label={preview.active ? 'Active' : 'Deactivated'}
                      />
                    )}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="warning.dark">
                    Not found in the CMS NPI Registry.
                  </Typography>
                )}
              </Box>
            )}
          </Paper>
        </Collapse>
      )}
    </Stack>
  );
}
