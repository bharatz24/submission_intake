// Settings → Data retention (GET/PUT /settings/retention): how long transcripts, Claude request records, chat,
// deleted submissions and ignored emails are kept before the daily purge removes them. Empty = keep forever (the default).
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Box, Button, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ConfirmDialog, ErrorState, Loading } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { formatDateTime } from '../../../lib/status';
import { api, ApiError, apiWith, errorMessage } from '../../../services/api';
import type { RetentionKey, RetentionSettings } from '../../../types';
import { settingsKeys } from '../queryKeys';
import { SettingsPanel } from './SettingsShell';

/** Same range as the server (backend RETENTION_DAYS); the server re-checks it. */
const MIN_DAYS = 30;
const MAX_DAYS = 3650;

const FIELDS: { key: RetentionKey; label: string; helper: string }[] = [
  {
    key: 'llmTranscriptsDays',
    label: 'Claude transcripts',
    helper: 'Full prompts and outputs kept for reports, quotes and chat.',
  },
  {
    key: 'llmCallsDays',
    label: 'Claude request records',
    helper: 'Token usage rows on Monitoring (and their transcripts).',
  },
  { key: 'chatDays', label: 'Chat messages', helper: 'Questions and answers in the submission chat.' },
  {
    key: 'deletedSubmissionsDays',
    label: 'Deleted submissions',
    helper: 'After this long in the trash, email text, documents, fields, reports and chat are erased.',
  },
  {
    key: 'skippedEmailsDays',
    label: 'Ignored emails',
    helper: 'Sender, subject and reasons of emails skipped at intake are erased and the email leaves the Ignored tab.',
  },
];

/** A period: empty means keep forever (null); otherwise whole days in range. */
const days = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : Number(v)))
  .pipe(
    z
      .number({ error: 'Enter a number of days, or leave it empty to keep forever' })
      .int('Enter a whole number of days')
      .min(MIN_DAYS, `Minimum ${MIN_DAYS} days`)
      .max(MAX_DAYS, `Maximum ${MAX_DAYS.toLocaleString('en-US')} days`)
      .nullable(),
  );
const retentionSchema = z.object({
  llmTranscriptsDays: days,
  llmCallsDays: days,
  chatDays: days,
  deletedSubmissionsDays: days,
  skippedEmailsDays: days,
});
type RetentionFormValues = z.input<typeof retentionSchema>;
type RetentionPayload = z.output<typeof retentionSchema>;

const toFormValues = (s: RetentionSettings): RetentionFormValues =>
  Object.fromEntries(FIELDS.map(({ key }) => [key, s.values[key] === null ? '' : String(s.values[key])])) as Record<
    RetentionKey,
    string
  >;

export function RetentionCard() {
  const settings = useQuery({
    queryKey: settingsKeys.retention(),
    queryFn: ({ signal }) => apiWith(signal).retentionSettings(),
  });
  return (
    <SettingsPanel
      title="Data retention"
      subtitle="How long Claude transcripts, request records, chat, deleted submissions and ignored emails are kept. A daily purge removes older data; active submissions are never purged, and the audit trail (which holds no applicant data) is kept."
    >
      {settings.isLoading && <Loading label="Loading retention settings…" shape="form" />}
      {settings.isError && <ErrorState error={settings.error} onRetry={() => settings.refetch()} />}
      {/* Remounted on a save, so the form starts from what the server stored. */}
      {settings.data && <RetentionForm key={settings.data.updatedAt ?? 'never'} saved={settings.data} />}
    </SettingsPanel>
  );
}

function RetentionForm({ saved }: { saved: RetentionSettings }) {
  const { user } = useAuth();
  const admin = hasPermission(user, 'settings:manage');
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState<RetentionPayload | null>(null);
  const form = useForm<RetentionFormValues, unknown, RetentionPayload>({
    resolver: zodResolver(retentionSchema),
    defaultValues: toFormValues(saved),
    mode: 'onTouched',
  });
  const save = useMutation({
    mutationFn: (body: RetentionPayload) => api.saveRetentionSettings(body),
    meta: { silentError: true },
    onSuccess: (data) => {
      qc.setQueryData(settingsKeys.retention(), data);
      form.reset(toFormValues(data));
      toast.success(TOAST_MESSAGES.retentionSaved);
    },
  });

  const submit = async (values: RetentionPayload) => {
    try {
      await save.mutateAsync(values);
      setPending(null);
    } catch (err) {
      setPending(null);
      const fieldErrors =
        err instanceof ApiError && err.details && typeof err.details === 'object'
          ? ((err.details as { fieldErrors?: Partial<Record<RetentionKey, string[]>> }).fieldErrors ?? {})
          : {};
      for (const { key } of FIELDS) {
        const message = fieldErrors[key]?.[0];
        if (message) form.setError(key, { message });
      }
    }
  };
  // Any period set means data will be deleted: ask first. Keeping everything forever saves straight away.
  const onSubmit = form.handleSubmit(async (values) => {
    if (FIELDS.some(({ key }) => values[key] !== null)) setPending(values);
    else await submit(values);
  });

  return (
    <Box component="form" noValidate onSubmit={(e) => void onSubmit(e)}>
      <Stack spacing={2.5}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            columnGap: 3,
            rowGap: 2.5,
          }}
        >
          {FIELDS.map((f) => (
            <Controller
              key={f.key}
              name={f.key}
              control={form.control}
              render={({ field: { ref, ...field }, fieldState }) => (
                <TextField
                  {...field}
                  inputRef={ref}
                  fullWidth
                  size="small"
                  label={f.label}
                  placeholder="Keep forever"
                  disabled={!admin || save.isPending}
                  error={Boolean(fieldState.error)}
                  helperText={fieldState.error?.message ?? `${f.helper} Empty = Keep forever.`}
                  slotProps={{
                    htmlInput: { inputMode: 'numeric' },
                    input: { endAdornment: <InputAdornment position="end">days</InputAdornment> },
                  }}
                />
              )}
            />
          ))}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Stack sx={{ flexGrow: 1 }}>
            {saved.updatedAt && (
              <Typography variant="caption" color="text.secondary">
                Last changed {saved.updatedBy ? `by ${saved.updatedBy} ` : ''}on {formatDateTime(saved.updatedAt)}
              </Typography>
            )}
            {!admin && (
              <Typography variant="caption" color="text.secondary">
                Only administrators can change how long data is kept.
              </Typography>
            )}
          </Stack>
          {admin && (
            <>
              <Button disabled={!form.formState.isDirty || save.isPending} onClick={() => form.reset()}>
                Discard
              </Button>
              <Button type="submit" variant="contained" loading={save.isPending}>
                Save retention
              </Button>
            </>
          )}
        </Stack>
        {save.error && !pending && <Alert severity="error">{errorMessage(save.error)}</Alert>}
      </Stack>
      <ConfirmDialog
        open={pending !== null}
        title="Permanently remove old data?"
        confirmLabel="Remove data"
        busy={save.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => pending && void submit(pending)}
        message={
          <Stack spacing={1} component="span">
            {FIELDS.filter(({ key }) => pending?.[key] != null).map(({ key, label }) => (
              <span key={key}>
                <strong>{label}:</strong> Data older than {pending?.[key]} days will be permanently removed.
              </span>
            ))}
            <span>This cannot be undone. The audit trail is kept.</span>
          </Stack>
        }
      />
    </Box>
  );
}
