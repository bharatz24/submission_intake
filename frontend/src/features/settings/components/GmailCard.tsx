import LinkOffIcon from '@mui/icons-material/LinkOff';
import LinkIcon from '@mui/icons-material/LinkOutlined';
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
  Grid,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, KeyValue, Loading } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import {
  GMAIL_OAUTH_POPUP_CLOSED_POLL_MS,
  GMAIL_OAUTH_POPUP_HEIGHT,
  GMAIL_OAUTH_POPUP_WIDTH,
  POLL_MS,
  TOAST_MESSAGES,
} from '../../../constants';
import { friendlyMessage } from '../../../lib/friendlyError';
import { formatDateTime, formatRelative, humanize } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import { submissionKeys } from '../../submissions';
import { gmailKeys, monitoringKeys } from '../queryKeys';
import { SettingsPanel } from './SettingsShell';

// Google sign-in runs in a pop-up so the app tab never leaves the page. The pop-up reports back over this
// channel because Google's pages sever window.opener.
export const GMAIL_OAUTH_CHANNEL = 'gmail-oauth';

const GMAIL_OAUTH_POPUP_NAME = 'gmail-oauth';

/** Window features that open the sign-in pop-up centred over the app window. */
function gmailPopupFeatures() {
  const left = window.screenX + Math.max(0, (window.outerWidth - GMAIL_OAUTH_POPUP_WIDTH) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - GMAIL_OAUTH_POPUP_HEIGHT) / 2);
  return `popup,width=${GMAIL_OAUTH_POPUP_WIDTH},height=${GMAIL_OAUTH_POPUP_HEIGHT},left=${Math.round(left)},top=${Math.round(top)}`;
}

export function GmailCard() {
  const { user } = useAuth();
  const admin = hasPermission(user, 'gmail:manage');
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: gmailKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).gmailStatus(),
    refetchInterval: POLL_MS.gmailStatusSettings,
  });
  const popupRef = useRef<Window | null>(null);
  const [awaitingGoogle, setAwaitingGoogle] = useState(false);
  const connect = useMutation({
    mutationFn: (popup: Window | null) => {
      if (!popup)
        return Promise.reject(
          new Error('The browser blocked the Google sign-in window. Allow pop-ups for this site and try again.'),
        );
      return api.gmailAuthUrl().then(({ url }) => {
        popup.location.href = url;
      });
    },
    onError: (_err, popup) => {
      popup?.close();
      popupRef.current = null;
      setAwaitingGoogle(false);
    },
  });
  const connectGmail = () => {
    // Opened synchronously in the click so the browser allows it; it is pointed at Google once the URL is known.
    const popup = window.open('about:blank', GMAIL_OAUTH_POPUP_NAME, gmailPopupFeatures());
    popupRef.current = popup;
    setAwaitingGoogle(!!popup);
    connect.mutate(popup);
  };
  // Detects the pop-up being closed, whether after success or abandoned, and refreshes the connection state.
  useEffect(() => {
    if (!awaitingGoogle) return;
    const timer = window.setInterval(() => {
      const popup = popupRef.current;
      if (popup && !popup.closed) return;
      popupRef.current = null;
      setAwaitingGoogle(false);
      qc.invalidateQueries({ queryKey: gmailKeys.status() });
    }, GMAIL_OAUTH_POPUP_CLOSED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [awaitingGoogle, qc]);
  const toast = useToast();
  const poll = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.gmailPoll,
    onSuccess: (r) => {
      toast.success(TOAST_MESSAGES.pollStarted(r.started));
      qc.invalidateQueries({ queryKey: gmailKeys.status() });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: monitoringKeys.all() });
    },
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const disconnect = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.gmailDisconnect,
    onSuccess: () => {
      toast.success(TOAST_MESSAGES.gmailDisconnected);
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: gmailKeys.status() });
    },
  });

  const s = status.data;
  const err = connect.error ?? poll.error ?? disconnect.error;

  return (
    <SettingsPanel
      title="Gmail connection"
      subtitle="The mailbox new submissions arrive in, and how often the app checks it for new mail."
    >
      {status.isLoading ? (
        <Loading label="Loading Gmail connection…" shape="form" />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : s ? (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              color={s.connected ? 'success' : 'default'}
              variant={s.connected ? 'filled' : 'outlined'}
              label={s.connected ? 'Connected' : 'Not connected'}
            />
            <Chip
              size="small"
              variant="outlined"
              color={s.mode === 'PUSH' ? 'primary' : s.mode === 'POLLING' ? 'info' : 'default'}
              label={`Mode: ${humanize(s.mode)}`}
            />
            <Chip size="small" variant="outlined" label={s.source === 'MCP' ? 'Source: MCP' : 'Source: Google OAuth'} />
            {!s.configured && (
              <Chip
                size="small"
                color="warning"
                label={s.source === 'MCP' ? 'MCP not configured' : 'OAuth not configured'}
              />
            )}
          </Stack>
          {!s.configured && (
            <Alert severity="warning" variant="outlined">
              {s.source === 'MCP'
                ? 'Gmail is set to read through MCP, but no MCP server is configured. Set GMAIL_MCP_URL or GMAIL_MCP_COMMAND in the backend environment (or set the Google client ID/secret and GMAIL_ENABLE_VIA_MCP=false).'
                : 'Gmail OAuth credentials are not configured on the server. Set the Google client ID/secret in the backend environment to enable monitoring.'}
            </Alert>
          )}
          {s.configured && s.error && (
            <Alert severity="error" variant="outlined">
              MCP connection failed: {friendlyMessage(s.error)}
            </Alert>
          )}
          <Grid container spacing={1.5}>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Mailbox" value={s.email} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue
                label="Last poll"
                value={s.lastPollAt ? `${formatDateTime(s.lastPollAt)} (${formatRelative(s.lastPollAt)})` : null}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Last history ID" value={s.lastHistoryId} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Push watch expires" value={s.watchExpiresAt ? formatDateTime(s.watchExpiresAt) : null} />
            </Grid>
          </Grid>
          <PollIntervalField admin={admin} />
          {err && <Alert severity="error">{errorMessage(err)}</Alert>}
          {admin ? (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {!s.connected && s.source === 'MCP' ? (
                <Button
                  variant="contained"
                  startIcon={<SyncIcon />}
                  disabled={!s.configured}
                  onClick={() => status.refetch()}
                >
                  Retry MCP connection
                </Button>
              ) : !s.connected ? (
                <Button
                  variant="contained"
                  startIcon={<LinkIcon />}
                  disabled={!s.configured || connect.isPending || awaitingGoogle}
                  onClick={connectGmail}
                >
                  {connect.isPending ? 'Opening Google…' : awaitingGoogle ? 'Waiting for Google…' : 'Connect Gmail'}
                </Button>
              ) : (
                <>
                  <Button
                    variant="contained"
                    startIcon={<SyncIcon />}
                    disabled={poll.isPending}
                    onClick={() => poll.mutate()}
                  >
                    {poll.isPending ? 'Polling…' : 'Poll now'}
                  </Button>
                  <Button
                    color="error"
                    variant="outlined"
                    startIcon={<LinkOffIcon />}
                    disabled={disconnect.isPending}
                    onClick={() => {
                      disconnect.reset();
                      setConfirmOpen(true);
                    }}
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </Stack>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Only administrators can change the mailbox connection.
            </Typography>
          )}
          {poll.isPending && <LinearProgress />}
        </Stack>
      ) : null}
      <Dialog open={confirmOpen} onClose={() => !disconnect.isPending && setConfirmOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Disconnect Gmail?</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {disconnect.isError && <Alert severity="error">{errorMessage(disconnect.error)}</Alert>}
            <DialogContentText>
              {s?.email ? (
                <>
                  The mailbox <strong>{s.email}</strong> will be disconnected.
                </>
              ) : (
                'The connected mailbox will be disconnected.'
              )}{' '}
              New submission emails will not be picked up until Gmail is connected again.
            </DialogContentText>
            <DialogContentText>
              {s?.source === 'MCP'
                ? 'The MCP session will be closed and reopened on the next poll. Mailbox access itself is managed by the MCP server.'
                : 'Push notifications will be stopped and the stored Google authorization removed. Reconnecting will require signing in with Google again.'}
            </DialogContentText>
            <DialogContentText>Existing submissions and reports are not affected.</DialogContentText>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={disconnect.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            startIcon={<LinkOffIcon />}
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </DialogActions>
      </Dialog>
    </SettingsPanel>
  );
}

/** Seconds between automatic Gmail checks, stored as an app setting; 0 turns polling off. */
function PollIntervalField({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: gmailKeys.importSettings(),
    queryFn: ({ signal }) => apiWith(signal).gmailImportSettings(),
  });
  const [value, setValue] = useState<string | null>(null);
  const toast = useToast();
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.gmailSetPollInterval,
    onSuccess: (r) => {
      toast.success(TOAST_MESSAGES.pollIntervalSaved(r.pollIntervalSeconds));
      setValue(null);
      qc.invalidateQueries({ queryKey: gmailKeys.all() });
    },
  });
  const s = settings.data;
  if (!s) return null;
  const shown = value ?? String(s.pollIntervalSeconds);
  const seconds = Number(shown);
  const valid =
    shown.trim() !== '' &&
    Number.isInteger(seconds) &&
    (seconds === 0 || (seconds >= s.minPollIntervalSeconds && seconds <= s.maxPollIntervalSeconds));
  const changed = valid && seconds !== s.pollIntervalSeconds;
  if (!admin) {
    return (
      <KeyValue
        label="Check for new mail every"
        value={s.pollIntervalSeconds ? `${s.pollIntervalSeconds} seconds` : 'Off (push only)'}
      />
    );
  }
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          type="number"
          label="Check for new mail every"
          value={shown}
          onChange={(e) => {
            save.reset();
            setValue(e.target.value);
          }}
          error={!valid}
          helperText={
            valid
              ? seconds === 0
                ? 'seconds · 0 = off (push only)'
                : 'seconds · 0 = off'
              : `0 (off) or ${s.minPollIntervalSeconds}–${s.maxPollIntervalSeconds} seconds`
          }
          InputProps={{ inputProps: { min: 0, max: s.maxPollIntervalSeconds, step: 1 } }}
          sx={{ width: 240 }}
        />
        <Button variant="outlined" disabled={!changed || save.isPending} onClick={() => save.mutate(seconds)}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </Stack>
      {save.error && <Alert severity="error">{errorMessage(save.error)}</Alert>}
    </Stack>
  );
}
