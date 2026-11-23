import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { EnumChip } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { DEBOUNCE_MS, PAGE_SIZE, TOAST_MESSAGES } from '../../../constants';
import { classificationColor, formatDateTime, humanize } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { Classification, SubmissionDetail, SubmissionSummary } from '../../../types';
import { auditKeys } from '../../audit';
import { submissionKeys } from '../queryKeys';

// The four places an email can go. Duplicate is not a classification (it links to an original), but a person
// moves an email there the same way they move it to Ignored.
type Choice = Classification | 'DUPLICATE';

const CHOICES: { value: Choice; hint: string }[] = [
  { value: 'SUBMISSION', hint: 'Processed: extraction, NPI, reports' },
  { value: 'REVIEW_REQUIRED', hint: 'Processed, flagged for a person to check' },
  { value: 'NOT_SUBMISSION', hint: 'Ignored: not processed' },
  { value: 'DUPLICATE', hint: 'Not processed: linked to the original' },
];

const overrideSchema = z
  .object({
    choice: z.enum(['SUBMISSION', 'REVIEW_REQUIRED', 'NOT_SUBMISSION', 'DUPLICATE']),
    duplicateOfId: z.string(),
    reason: z.string().trim().min(5, 'Please give a reason (min 5 characters) — it is recorded in the audit trail'),
  })
  .refine((v) => v.choice !== 'DUPLICATE' || v.duplicateOfId, {
    path: ['duplicateOfId'],
    message: 'Choose the original submission',
  });

type OverrideValues = z.infer<typeof overrideSchema>;

type OriginalOption = Pick<SubmissionSummary, 'id' | 'subject'> &
  Partial<Pick<SubmissionSummary, 'fromAddress' | 'receivedAt' | 'status'>>;

/** One field to search the inbox and pick the original: type to search, choose from the results. */
function OriginalPicker({
  excludeId,
  initial,
  onChange,
  error,
  helperText,
}: {
  excludeId: string;
  initial: OriginalOption | null;
  onChange: (id: string) => void;
  error: boolean;
  helperText: ReactNode;
}) {
  const [selected, setSelected] = useState<OriginalOption | null>(initial);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(input === selected?.subject ? '' : input), DEBOUNCE_MS.mergeSearch);
    return () => clearTimeout(t);
  }, [input, selected]);
  const results = useQuery({
    queryKey: submissionKeys.list({ q, pageSize: PAGE_SIZE.mergeSearch, purpose: 'choose-original' }),
    queryFn: ({ signal }) => apiWith(signal).listSubmissions({ q, pageSize: PAGE_SIZE.mergeSearch }),
  });
  const found = (results.data?.items ?? []).filter((c) => c.id !== excludeId);
  const options = selected && !found.some((o) => o.id === selected.id) ? [selected, ...found] : found;
  return (
    <Autocomplete
      options={options}
      value={selected}
      onChange={(_, o) => {
        setSelected(o);
        onChange(o?.id ?? '');
      }}
      inputValue={input}
      onInputChange={(_, v) => setInput(v)}
      filterOptions={(x) => x} // the server searches
      getOptionLabel={(o) => o.subject || '(no subject)'}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      loading={results.isFetching}
      noOptionsText={q ? 'No matching submissions' : 'Type to search the inbox'}
      renderOption={(props, o) => (
        <li {...props} key={o.id}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              {o.subject || '(no subject)'}
            </Typography>
            {o.fromAddress && (
              <Typography variant="caption" color="text.secondary">
                {o.fromAddress} · {formatDateTime(o.receivedAt)}
                {o.status ? ` · ${humanize(o.status)}` : ''}
              </Typography>
            )}
          </Box>
        </li>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          label="Original submission"
          placeholder="Type a subject, sender or applicant…"
          error={error}
          helperText={helperText}
        />
      )}
    />
  );
}

export function OverrideDialog({ s, open, onClose }: { s: SubmissionDetail; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const busy = s.status === 'NEW' || s.status === 'PROCESSING';
  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<OverrideValues>({
    resolver: zodResolver(overrideSchema),
    values: {
      choice: s.status === 'DUPLICATE' ? 'DUPLICATE' : (s.classification ?? 'REVIEW_REQUIRED'),
      duplicateOfId: s.duplicateOf?.id ?? '',
      reason: '',
    },
    // The detail polls while processing; keep what the user has typed.
    resetOptions: { keepDirtyValues: true },
  });
  const choice = watch('choice');
  const toast = useToast();
  const m = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (v: OverrideValues) =>
      v.choice === 'DUPLICATE'
        ? api.setDuplicate(s.id, v.duplicateOfId, v.reason)
        : api.overrideClassification(s.id, v.choice, v.reason),
    onSuccess: (d) => {
      qc.setQueryData(submissionKeys.detail(s.id), d);
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
      toast.success(TOAST_MESSAGES.classificationSaved);
      reset();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={() => !m.isPending && onClose()} fullWidth maxWidth="sm">
      <form onSubmit={handleSubmit((v) => m.mutate(v))} noValidate>
        <DialogTitle>Change classification</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {m.isError && <Alert severity="error">{errorMessage(m.error)}</Alert>}
            <Controller
              name="choice"
              control={control}
              render={({ field }) => (
                <TextField select label="Classification" fullWidth {...field}>
                  {CHOICES.map((c) => (
                    <MenuItem key={c.value} value={c.value} disabled={c.value === 'DUPLICATE' && busy}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <EnumChip
                          value={c.value}
                          color={c.value === 'DUPLICATE' ? 'default' : classificationColor(c.value)}
                        />
                        <Typography variant="caption" color="text.secondary">
                          {c.value === 'DUPLICATE' && busy ? 'Available once processing finishes' : c.hint}
                        </Typography>
                      </Stack>
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
            {choice === 'DUPLICATE' && (
              <Controller
                name="duplicateOfId"
                control={control}
                render={({ field }) => (
                  <OriginalPicker
                    excludeId={s.id}
                    initial={s.duplicateOf}
                    onChange={field.onChange}
                    error={!!errors.duplicateOfId}
                    helperText={errors.duplicateOfId?.message ?? 'A duplicate of a duplicate links to its original.'}
                  />
                )}
              />
            )}
            <TextField
              label="Reason"
              fullWidth
              multiline
              minRows={3}
              {...register('reason')}
              error={!!errors.reason}
              helperText={errors.reason?.message ?? 'Recorded in the audit trail.'}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={m.isPending}>
            {m.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Documents & Evidence
