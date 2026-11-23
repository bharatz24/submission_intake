import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SyncIcon from '@mui/icons-material/Sync';
import TodayIcon from '@mui/icons-material/Today';
import { Alert, Button, LinearProgress, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, KeyValue, Loading } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { POLL_MS, TOAST_MESSAGES } from '../../../constants';
import { formatDateTime } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import { submissionKeys } from '../../submissions';
import { gmailKeys, monitoringKeys } from '../queryKeys';
import { SettingsPanel } from './SettingsShell';

export function GmailImportCard() {
  const { user } = useAuth();
  const admin = hasPermission(user, 'gmail:manage');
  const qc = useQueryClient();
  const canProcess = hasPermission(user, 'submission:write');
  const toast = useToast();
  // Polled: imported emails arrive in the background, so the "not processed yet" count grows after an import.
  const settings = useQuery({
    queryKey: gmailKeys.importSettings(),
    queryFn: ({ signal }) => apiWith(signal).gmailImportSettings(),
    refetchInterval: POLL_MS.gmailStatusSettings,
  });
  const gmail = useQuery({
    queryKey: gmailKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).gmailStatus(),
    refetchInterval: POLL_MS.gmailStatusSettings,
  });
  const [value, setValue] = useState('');
  const runImport = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.gmailImport,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: gmailKeys.importSettings() });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: monitoringKeys.all() });
    },
  });
  const processAll = useMutation({
    mutationFn: api.processAllImported,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: gmailKeys.importSettings() });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      toast.success(TOAST_MESSAGES.importProcessAllQueued(r.queued));
    },
    onError: (err) => toast.error(err),
  });

  const s = settings.data;
  const days = Number(value);
  const valid = !!s && value.trim() !== '' && Number.isInteger(days) && days >= s.minDays && days <= s.maxDays;
  const connected = !!gmail.data?.connected;

  return (
    <SettingsPanel
      title="Import older email"
      subtitle="New emails arrive automatically from the moment the mailbox was connected. Earlier emails, including today's, come in only when you import them here."
    >
      {settings.isLoading ? (
        <Loading label="Loading settings…" shape="form" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
      ) : s ? (
        <Stack spacing={2}>
          <KeyValue
            label="Automatic import from"
            value={s.autoImportSince ? formatDateTime(s.autoImportSince) : 'The moment Gmail is connected'}
          />
          {admin ? (
            <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
              <TextField
                size="small"
                type="number"
                label="Import emails from the last"
                placeholder="e.g. 30"
                value={value}
                onChange={(e) => {
                  runImport.reset();
                  setValue(e.target.value);
                }}
                error={value !== '' && !valid}
                helperText={value === '' || valid ? 'days' : `Whole number of days, ${s.minDays}–${s.maxDays}`}
                InputProps={{ inputProps: { min: s.minDays, max: s.maxDays, step: 1 } }}
                sx={{ width: 220 }}
              />
              <Tooltip title={!connected ? 'Connect Gmail first' : !valid ? 'Enter the number of days to import' : ''}>
                <span>
                  <Button
                    variant="contained"
                    startIcon={<SyncIcon />}
                    disabled={!connected || !valid || runImport.isPending}
                    onClick={() => {
                      runImport.reset();
                      runImport.mutate({ days });
                    }}
                  >
                    {runImport.isPending ? 'Importing…' : 'Import now'}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={!connected ? 'Connect Gmail first' : 'Everything in the inbox since midnight US Eastern'}>
                <span>
                  <Button
                    variant="outlined"
                    startIcon={<TodayIcon />}
                    disabled={!connected || runImport.isPending}
                    onClick={() => {
                      runImport.reset();
                      runImport.mutate({ today: true });
                    }}
                  >
                    Import today&apos;s emails
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Only administrators can import older emails.
            </Typography>
          )}
          {runImport.error && <Alert severity="error">{errorMessage(runImport.error)}</Alert>}
          {runImport.isSuccess && (
            <Alert severity="success">
              Found {runImport.data.found} inbox email{runImport.data.found === 1 ? '' : 's'}{' '}
              {'today' in runImport.data
                ? 'from today (since midnight US Eastern)'
                : `from the last ${runImport.data.days} day${runImport.data.days === 1 ? '' : 's'}`}
              .{' '}
              {runImport.data.enqueued
                ? `${runImport.data.enqueued} not yet in the app ${runImport.data.enqueued === 1 ? 'is' : 'are'} being imported now; they appear in the inbox as each one is classified, marked Not processed.`
                : 'All of them are already in the app.'}
            </Alert>
          )}
          {runImport.isPending && <LinearProgress />}
          <KeyValue
            label="Imported, not processed yet"
            value={`${s.awaitingProcess} email${s.awaitingProcess === 1 ? '' : 's'}`}
          />
          <Typography variant="caption" color="text.secondary">
            Imported emails are only classified. Extraction, NPI checks and reports run when you press Process, on one
            email or on all of them here.
          </Typography>
          {canProcess && (
            <Stack direction="row">
              <Button
                variant="outlined"
                startIcon={<PlayArrowIcon />}
                disabled={s.awaitingProcess === 0 || processAll.isPending}
                onClick={() => processAll.mutate()}
              >
                {processAll.isPending ? 'Queuing…' : `Process all imported (${s.awaitingProcess})`}
              </Button>
            </Stack>
          )}
        </Stack>
      ) : null}
    </SettingsPanel>
  );
}
