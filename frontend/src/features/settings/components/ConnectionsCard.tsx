import CancelIcon from '@mui/icons-material/CancelOutlined';
import CheckIcon from '@mui/icons-material/CheckCircleOutline';
import SyncIcon from '@mui/icons-material/Sync';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Grid,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, KeyValue, Loading } from '../../../components/common';
import { POLL_MS } from '../../../constants';
import { friendlyMessage } from '../../../lib/friendlyError';
import { formatDateTime, formatRelative } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { ConnectionKey, ConnectionTest, Ims2QueueState } from '../../../types';
import { ims2Keys } from '../../submissions';
import { settingsKeys, systemKeys } from '../queryKeys';
import { Ims2QueueSettingsForm } from './Ims2QueueSettingsForm';
import { LimitFields } from './LimitsCard';
import { SettingsPanel } from './SettingsShell';

// The automatic status check (GET /system/status, every minute) names some services differently.
const STATUS_KEY: Partial<Record<ConnectionKey, string>> = {
  database: 'database',
  llm: 'llm',
  gmail: 'google',
  drive: 'storage',
  npi: 'npi',
};

const QUEUE_STATE_LABEL: Record<Ims2QueueState, string> = {
  SENDING: 'Sending',
  QUEUED: 'Queued',
  LINKED: 'Linked',
  REJECTED: 'Rejected',
  ERROR: 'Refused',
  FAILED: 'Not delivered',
};

const QUEUE_STATE_COLOR: Record<Ims2QueueState, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  SENDING: 'default',
  QUEUED: 'info',
  LINKED: 'success',
  REJECTED: 'warning',
  ERROR: 'error',
  FAILED: 'warning',
};

/**
 * Settings → IMS 2 intake: submissions sent to IMS 2's Submission Intake queue, and a sync that reads what IMS 2 users
 * did with them (linked to a submission, rejected) and the live workflow status and policy number of linked ones.
 * IMS 2 sends no notifications, so this sync (or Refresh status on a submission) is how results arrive.
 */
export function Ims2IntakeSyncCard() {
  const info = useQuery({
    queryKey: ims2Keys.sync(),
    queryFn: ({ signal }) => apiWith(signal).ims2QueueSyncInfo(),
    refetchInterval: (q) => (q.state.data?.running ? POLL_MS.ims2SyncRunning : false),
  });
  const last = info.data?.lastSync ?? null;
  const counts = info.data?.counts ?? {};
  const total = Object.values(counts).reduce((a, n) => a + (n ?? 0), 0);

  return (
    <SettingsPanel
      title="IMS 2 intake"
      subtitle="The IMS 2 Submission Intake queue's URL and token, and the submissions sent to it. IMS 2 does not notify this app: Sync IMS status (on the Submissions tab of the Submission Inbox) reads which intakes IMS 2 users linked to a submission or rejected, and refreshes the workflow status and policy number of linked ones."
    >
      <Ims2QueueSettingsForm />
      <Divider sx={{ my: 2 }} />
      {info.isLoading ? (
        <Loading label="Loading IMS 2 intake…" shape="form" />
      ) : info.isError ? (
        <ErrorState error={info.error} onRetry={() => info.refetch()} />
      ) : !info.data!.configured ? (
        <Alert severity="info" variant="outlined">
          The IMS 2 intake queue is not configured. Enter its URL (IMS 2's /api/submission-intake) and token above.
        </Alert>
      ) : (
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Intakes
            </Typography>
            {total ? (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {(Object.keys(QUEUE_STATE_LABEL) as Ims2QueueState[])
                  .filter((s) => counts[s])
                  .map((s) => (
                    <Chip
                      key={s}
                      label={`${QUEUE_STATE_LABEL[s]}: ${counts[s]}`}
                      color={QUEUE_STATE_COLOR[s]}
                      variant="outlined"
                    />
                  ))}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Nothing has been sent to the IMS 2 intake queue yet.
              </Typography>
            )}
          </Box>
          <Divider />
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Last sync
            </Typography>
            {last ? (
              <Grid container spacing={1}>
                <Grid item xs={12} sm={6}>
                  <KeyValue label="When" value={`${formatDateTime(last.at)}${last.by ? ` · ${last.by}` : ''}`} />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <KeyValue
                    label="Result"
                    value={
                      last.error
                        ? 'Failed'
                        : `${last.linked} linked · ${last.rejected} rejected · ${last.updated} refreshed`
                    }
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <KeyValue
                    label="Status changes read"
                    value={`${last.seen} in ${last.pages} page${last.pages === 1 ? '' : 's'}`}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <KeyValue
                    label="Read up to"
                    value={info.data!.lastStatusChangedAt ? formatDateTime(info.data!.lastStatusChangedAt) : '—'}
                  />
                </Grid>
              </Grid>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Not synced yet.
              </Typography>
            )}
            {last?.error && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {friendlyMessage(last.error)}
              </Alert>
            )}
          </Box>
          {info.data!.running && <LinearProgress />}
        </Stack>
      )}
    </SettingsPanel>
  );
}

/**
 * Settings → Connections: every service's status from the automatic check (the same one the dot on the avatar sums
 * up), and for admins a live test per service. A test newer than the last check replaces that row's status.
 */
export function ConnectionsCard() {
  const { user } = useAuth();
  const admin = hasPermission(user, 'settings:manage');
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: settingsKeys.connections(),
    queryFn: ({ signal }) => apiWith(signal).connections(),
    refetchOnMount: 'always', // opening the tab shows what was just saved elsewhere in Settings
  });
  const system = useQuery({
    queryKey: systemKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).systemStatus(),
    refetchInterval: POLL_MS.systemStatusSettings,
  });
  const [results, setResults] = useState<Partial<Record<ConnectionKey, ConnectionTest>>>({});
  const [running, setRunning] = useState<Set<ConnectionKey>>(() => new Set());
  const [error, setError] = useState<unknown>(null);

  const run = async (key: ConnectionKey) => {
    setRunning((r) => new Set(r).add(key));
    try {
      const res = await api.testConnection(key);
      setResults((prev) => ({ ...prev, [key]: res }));
    } catch (err) {
      setError(err);
    } finally {
      setRunning((r) => {
        const n = new Set(r);
        n.delete(key);
        return n;
      });
    }
  };
  const runSome = async (keys: ConnectionKey[]) => {
    setError(null);
    await Promise.all(keys.map(run));
    // A test also refreshes the status shown in the header and whether each service counts as configured.
    qc.invalidateQueries({ queryKey: systemKeys.status() });
    qc.invalidateQueries({ queryKey: settingsKeys.connections() });
  };

  return (
    <SettingsPanel
      title="Connections"
      fullWidth
      subtitle="The services the app depends on, checked automatically every minute. Admins can test one now; a test runs live, so it can take a few seconds."
      action={
        admin && list.data ? (
          <Button
            variant="contained"
            startIcon={<SyncIcon />}
            disabled={running.size > 0}
            onClick={() => void runSome(list.data.map((c) => c.key))}
          >
            {running.size > 0 ? 'Testing…' : 'Test all connections'}
          </Button>
        ) : undefined
      }
    >
      {list.isLoading ? (
        <Loading label="Loading connections…" shape="list" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.data ? (
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              {system.isError
                ? 'The server did not answer the status check.'
                : system.data
                  ? `Checked ${formatRelative(system.data.checkedAt)}`
                  : 'Checking…'}
            </Typography>
            <Button
              size="small"
              startIcon={<SyncIcon />}
              disabled={system.isFetching}
              onClick={() => void system.refetch()}
            >
              {system.isFetching ? 'Checking…' : 'Refresh'}
            </Button>
          </Stack>
          {system.isError && (
            <Alert severity="error" variant="outlined">
              {errorMessage(system.error)}
            </Alert>
          )}
          <List dense disablePadding>
            {list.data.map((c) => {
              const busy = running.has(c.key);
              const tested = results[c.key];
              const checked = system.data?.services.find((x) => x.key === STATUS_KEY[c.key]);
              // The newer of the last test and the last automatic check.
              const useTest = tested && (!checked || !system.data || tested.testedAt >= system.data.checkedAt);
              const shown = useTest
                ? {
                    ok: tested.ok,
                    text: `${tested.detail}${tested.configured ? ` · ${tested.latencyMs} ms` : ''} · tested ${formatRelative(tested.testedAt)}`,
                  }
                : checked
                  ? { ok: checked.ok, text: checked.detail }
                  : null;
              return (
                <ListItem key={c.key} divider sx={{ px: 0, gap: 1 }}>
                  <Box sx={{ width: 20, display: 'flex', flexShrink: 0 }}>
                    {!busy &&
                      shown &&
                      (shown.ok ? (
                        <CheckIcon fontSize="small" color="success" />
                      ) : (
                        <CancelIcon fontSize="small" color="error" />
                      ))}
                  </Box>
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="body2" fontWeight={600}>
                          {c.label}
                        </Typography>
                        {!c.configured && (
                          <Chip
                            size="small"
                            color="warning"
                            variant="outlined"
                            label="Not configured"
                            sx={{ height: 20, fontSize: '0.7rem' }}
                          />
                        )}
                      </Stack>
                    }
                    secondary={
                      busy ? (
                        'Testing…'
                      ) : shown ? (
                        <Box
                          component="span"
                          sx={{ color: shown.ok ? 'text.secondary' : 'error.main', wordBreak: 'break-word' }}
                        >
                          {shown.text}
                        </Box>
                      ) : c.configured ? (
                        admin ? (
                          'Not checked automatically; use Test'
                        ) : (
                          'Not checked automatically'
                        )
                      ) : (
                        'Not configured'
                      )
                    }
                  />
                  {admin && (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<SyncIcon />}
                      disabled={busy}
                      sx={{ flexShrink: 0 }}
                      onClick={() => void runSome([c.key])}
                    >
                      Test
                    </Button>
                  )}
                </ListItem>
              );
            })}
          </List>
          {!admin && (
            <Typography variant="caption" color="text.secondary">
              Only administrators can run connection tests.
            </Typography>
          )}
          {error != null && <Alert severity="error">{errorMessage(error)}</Alert>}
          {running.size > 0 && <LinearProgress />}
        </Stack>
      ) : null}
      <LimitFields group="timeouts" />
    </SettingsPanel>
  );
}
