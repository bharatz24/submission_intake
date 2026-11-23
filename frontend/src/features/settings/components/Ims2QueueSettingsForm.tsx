import SyncIcon from '@mui/icons-material/Sync';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, Loading, PasswordField } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { api, apiWith, errorMessage } from '../../../services/api';
import { ims2Keys } from '../../submissions';
import { settingsKeys, systemKeys } from '../queryKeys';

const isHttpUrl = (v: string) => {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
};

/**
 * Settings → IMS 2 intake: the queue URL (IMS 2's /api/submission-intake) and its token (IMS 2's
 * SUBMISSION_INTAKE_TOKEN), kept in the database instead of the server's environment. The saved token is never shown;
 * a new one replaces it. Sending to IMS 2 is off until both are set. Also the IMS URL: the application or website the
 * top bar's IMS button opens in a new tab (no button while it is empty).
 */
export function Ims2QueueSettingsForm() {
  const { user } = useAuth();
  const admin = hasPermission(user, 'settings:manage');
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({
    queryKey: settingsKeys.ims2Queue(),
    queryFn: ({ signal }) => apiWith(signal).ims2QueueSettings(),
  });
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [imsUrl, setImsUrl] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const test = useMutation({ meta: { silentError: true }, mutationFn: api.testIms2QueueSettings });
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.saveIms2QueueSettings,
    onSuccess: (data) => {
      toast.success(TOAST_MESSAGES.ims2QueueSaved);
      qc.setQueryData(settingsKeys.ims2Queue(), data);
      // Whether the queue is configured shows on the intake cards and in Connections.
      qc.invalidateQueries({ queryKey: ims2Keys.all() });
      qc.invalidateQueries({ queryKey: settingsKeys.connections() });
      qc.invalidateQueries({ queryKey: systemKeys.status() });
      setBaseUrl(null);
      setToken('');
      setImsUrl(null);
      setConfirmRemove(false);
    },
  });
  const s = settings.data;
  const shownUrl = (baseUrl ?? s?.baseUrl ?? '').trim();
  const urlValid = shownUrl === '' || isHttpUrl(shownUrl);
  const tokenValid = token.trim() === '' || token.trim().length >= 16;
  const shownImsUrl = (imsUrl ?? s?.imsUrl ?? '').trim();
  const imsUrlValid = shownImsUrl === '' || isHttpUrl(shownImsUrl);
  const dirty = !!s && (token.trim() !== '' || shownUrl !== (s.baseUrl ?? '') || shownImsUrl !== (s.imsUrl ?? ''));
  const reset = () => {
    test.reset();
    save.reset();
  };

  if (settings.isLoading) return <Loading label="Loading IMS 2 connection…" shape="form" />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  if (!s) return null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip
          size="small"
          color={s.configured ? 'success' : 'warning'}
          variant={s.configured ? 'filled' : 'outlined'}
          label={s.configured ? 'Configured' : 'Not configured'}
        />
        <Chip size="small" variant="outlined" label={s.tokenSet ? `Token set ${s.tokenHint ?? ''}` : 'No token'} />
      </Stack>
      {s.tokenError && (
        <Alert severity="error" variant="outlined">
          {s.tokenError}
        </Alert>
      )}
      {admin ? (
        <>
          <TextField
            size="small"
            label="Queue URL"
            placeholder="https://ims2.example.com/api/submission-intake"
            value={shownUrl}
            onChange={(e) => {
              reset();
              setBaseUrl(e.target.value);
            }}
            error={!urlValid}
            helperText={
              urlValid ? "IMS 2's /api/submission-intake (the IMS 2 app, not its database)" : 'Use an http(s) URL'
            }
          />
          <PasswordField
            size="small"
            autoComplete="off"
            label={s.tokenSet ? 'Replace token' : 'Token'}
            placeholder={s.tokenSet ? 'Leave empty to keep the saved token' : "IMS 2's SUBMISSION_INTAKE_TOKEN"}
            value={token}
            onChange={(e) => {
              reset();
              setToken(e.target.value);
            }}
            error={!tokenValid}
            helperText={
              tokenValid
                ? 'The same secret as IMS 2’s SUBMISSION_INTAKE_TOKEN. Stored encrypted; it is never shown again.'
                : 'The token must be at least 16 characters'
            }
          />
          <TextField
            size="small"
            label="IMS URL"
            placeholder="https://ims.example.com"
            value={shownImsUrl}
            onChange={(e) => {
              reset();
              setImsUrl(e.target.value);
            }}
            error={!imsUrlValid}
            helperText={
              imsUrlValid
                ? 'The application or website the IMS button in the top bar opens in a new tab. Leave empty to hide the button.'
                : 'Use an http(s) URL'
            }
          />
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button
              variant="outlined"
              startIcon={<SyncIcon />}
              disabled={!shownUrl || !urlValid || !tokenValid || test.isPending || (!s.tokenSet && !token.trim())}
              onClick={() => {
                reset();
                test.mutate({ baseUrl: shownUrl, ...(token.trim() ? { token: token.trim() } : {}) });
              }}
            >
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            <Button
              variant="contained"
              disabled={!dirty || !urlValid || !tokenValid || !imsUrlValid || save.isPending}
              onClick={() => {
                reset();
                save.mutate({
                  baseUrl: shownUrl || null,
                  ...(token.trim() ? { token: token.trim() } : {}),
                  imsUrl: shownImsUrl || null,
                });
              }}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {(s.tokenSet || s.baseUrl) && (
              <Button
                color="error"
                variant="text"
                disabled={save.isPending}
                onClick={() => {
                  reset();
                  setConfirmRemove(true);
                }}
              >
                Remove
              </Button>
            )}
          </Stack>
          {test.isSuccess && <Alert severity={test.data.ok ? 'success' : 'error'}>{test.data.detail}</Alert>}
          {test.error && <Alert severity="error">{errorMessage(test.error)}</Alert>}
          {save.error && <Alert severity="error">{errorMessage(save.error)}</Alert>}
          {(test.isPending || save.isPending) && <LinearProgress />}
        </>
      ) : (
        <Typography variant="caption" color="text.secondary">
          {s.baseUrl ? `Queue URL: ${s.baseUrl}. ` : ''}
          {s.imsUrl ? `IMS URL: ${s.imsUrl}. ` : ''}Only administrators can change the IMS 2 queue URL, token or IMS
          URL.
        </Typography>
      )}
      <Dialog open={confirmRemove} onClose={() => !save.isPending && setConfirmRemove(false)} fullWidth maxWidth="xs">
        <DialogTitle>Remove the IMS 2 connection?</DialogTitle>
        <DialogContent dividers>
          <DialogContentText>
            The queue URL and token are deleted. Sending to IMS 2 and syncing its status stop until they are entered
            again. Intakes already sent stay in IMS 2.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRemove(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={save.isPending}
            onClick={() => save.mutate({ baseUrl: null, token: null })}
          >
            {save.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
