import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Box,
  Button,
  Grid,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, type Theme, useTheme } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, ErrorState, fillCell, Loading, SectionCard } from '../../../components/common';
import { UnsavedChangesGuard } from '../../../hooks/useUnsavedChanges';
import { type ChipColor, decisionColor, formatDateTime, riskColor } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { Assessment, Decision, RiskRating, SubmissionDetail } from '../../../types';
import { assessmentKeys, ims2Keys, quoteKeys, reportKeys, submissionKeys } from '../queryKeys';
import { Ims2IntakeQueueCard } from './Ims2IntakeQueueCard';
import { useReportList } from './ReportShell';

type DecisionMeta = { value: Decision; label: string; past: string; help: string };
/** Non-empty, so the first entry is the fallback for an unknown decision. */
const DECISIONS: [DecisionMeta, ...DecisionMeta[]] = [
  { value: 'ACCEPT', label: 'Accept', past: 'Accepted', help: 'Approve this submission as it is.' },
  {
    value: 'ACCEPT_WITH_CONDITIONS',
    label: 'Accept with conditions',
    past: 'Accepted with conditions',
    help: 'Approve, as long as the conditions in the notes are met.',
  },
  { value: 'REFER', label: 'Refer', past: 'Referred', help: 'Pass to a senior underwriter for a second opinion.' },
  {
    value: 'REQUEST_INFORMATION',
    label: 'Request info',
    past: 'Info requested',
    help: 'Ask the broker for missing details before deciding.',
  },
  { value: 'DECLINE', label: 'Decline', past: 'Declined', help: 'Do not offer coverage.' },
];
const RISKS: { value: RiskRating; label: string }[] = [
  { value: 'LOW', label: 'Low' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'ELEVATED', label: 'Elevated' },
  { value: 'HIGH', label: 'High' },
];
/** Accepting needs a primary quote priced above zero; the API refuses it too (assessments.service.ts). */
const ACCEPT_DECISIONS: readonly Decision[] = ['ACCEPT', 'ACCEPT_WITH_CONDITIONS'];
const NO_PRIMARY_QUOTE =
  'This submission cannot be accepted yet because it has no primary quote. Open Coverage & Rating, price a quote and make it the primary one, then accept. You can still refer, request information or decline.';
const UNPRICED_PRIMARY_QUOTE =
  'This submission cannot be accepted yet because its primary quote has no premium or total above $0. Open Coverage & Rating and price the primary quote (or make a priced quote primary), then accept. You can still refer, request information or decline.';
const decisionMeta = (d: Decision) => DECISIONS.find((x) => x.value === d) ?? DECISIONS[0];
const riskLabel = (r: RiskRating) => RISKS.find((x) => x.value === r)?.label ?? r;

export const DECISION_VALUES = ['ACCEPT', 'ACCEPT_WITH_CONDITIONS', 'DECLINE', 'REFER', 'REQUEST_INFORMATION'] as const;
const RISK_VALUES = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH'] as const;
const assessmentSchema = z.object({
  // Both start unchosen (''), which the input allows and the output does not.
  decision: z.enum([...DECISION_VALUES, '']).pipe(z.enum(DECISION_VALUES, { error: 'Choose an outcome.' })),
  riskRating: z.enum([...RISK_VALUES, '']).pipe(z.enum(RISK_VALUES, { error: 'Choose a risk level.' })),
  notes: z.string().trim().min(10, 'Please explain the decision (at least 10 characters).').max(20_000),
  analysisReportId: z.string(),
});
type Values = z.output<typeof assessmentSchema>;
/** The form starts with no outcome or risk level chosen, and is cleared again after each save. */
type FormValues = z.input<typeof assessmentSchema>;

const tone = (theme: Theme, c: ChipColor) => (c === 'default' ? theme.palette.text.secondary : theme.palette[c].main);

/** Toggle button that fills with its own status color when selected. */
const colored = (c: string) => ({
  flex: '1 1 auto',
  py: 0.6,
  px: 1.25,
  fontWeight: 600,
  fontSize: '0.8rem',
  color: 'text.primary',
  borderColor: 'divider',
  '&.Mui-selected, &.Mui-selected:hover': { bgcolor: c, color: 'common.white', borderColor: c },
  '&:hover': { bgcolor: alpha(c, 0.08) },
});

export function AssessmentView({ submissionId }: { submissionId: string }) {
  const theme = useTheme();
  const { user } = useAuth();
  const qc = useQueryClient();
  const history = useQuery({
    queryKey: assessmentKeys.list(submissionId),
    queryFn: ({ signal }) => apiWith(signal).listAssessments(submissionId),
  });
  const analyses = useReportList(submissionId, 'ANALYSIS');
  const quotes = useQuery({
    queryKey: quoteKeys.list(submissionId),
    queryFn: ({ signal }) => apiWith(signal).quotes(submissionId),
  });
  const completedAnalyses = (analyses.data ?? []).filter((r) => r.status === 'COMPLETED');
  const emptyForm: FormValues = {
    decision: '',
    riskRating: '',
    notes: '',
    analysisReportId: completedAnalyses[0]?.id ?? '',
  };

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<FormValues, unknown, Values>({
    resolver: zodResolver(assessmentSchema),
    values: emptyForm,
    resetOptions: { keepDirtyValues: true },
  });
  const decision = useWatch({ control, name: 'decision' });

  // Only judged once the quotes have loaded; while they load or fail, the API still enforces the rule on save.
  const primaryQuote = quotes.data?.find((q) => q.isPrimary);
  const acceptBlocker = !quotes.data
    ? null
    : !primaryQuote
      ? NO_PRIMARY_QUOTE
      : (primaryQuote.premium ?? 0) > 0 && (primaryQuote.total ?? 0) > 0
        ? null
        : UNPRICED_PRIMARY_QUOTE;
  const acceptBlocked = !!decision && ACCEPT_DECISIONS.includes(decision) && !!acceptBlocker;

  const create = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (v: Values) =>
      api.createAssessment(submissionId, {
        decision: v.decision,
        riskRating: v.riskRating,
        notes: v.notes,
        ...(v.analysisReportId ? { analysisReportId: v.analysisReportId } : {}),
      }),
    onSuccess: (a) => {
      qc.setQueryData(assessmentKeys.list(submissionId), (old: typeof history.data) => [a, ...(old ?? [])]);
      qc.invalidateQueries({ queryKey: assessmentKeys.list(submissionId) });
      qc.setQueryData<SubmissionDetail>(submissionKeys.detail(submissionId), (old) =>
        old ? { ...old, latestAssessment: a } : old,
      );
      qc.invalidateQueries({ queryKey: submissionKeys.detail(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.versions(submissionId) });
      qc.invalidateQueries({ queryKey: ims2Keys.submission(submissionId) });
      // Recording a decision also marks the automatic reports and quotes reviewed.
      qc.invalidateQueries({ queryKey: reportKeys.all(submissionId) });
      qc.invalidateQueries({ queryKey: reportKeys.details() });
      qc.invalidateQueries({ queryKey: quoteKeys.list(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      // reset() applies resetOptions too; without this override the typed reason would survive as a dirty value.
      reset(emptyForm, { keepDirtyValues: false });
    },
  });

  // The same decision as the current one would only add a copy to the history; the API refuses it too.
  const save = (v: Values) => {
    if (ACCEPT_DECISIONS.includes(v.decision) && acceptBlocker) {
      setError('root', { message: acceptBlocker });
      return;
    }
    const current = history.data?.[0];
    if (
      current &&
      current.decision === v.decision &&
      current.riskRating === v.riskRating &&
      current.notes.trim() === v.notes.trim() &&
      (current.analysisReportId ?? '') === v.analysisReportId
    ) {
      setError('root', {
        message:
          'This decision is already the current one. Change the outcome, risk level, report or reason to record a new one.',
      });
      return;
    }
    create.mutate(v);
  };

  const analysisLabel = (id: string | null) => {
    if (!id) return null;
    const r = (analyses.data ?? []).find((x) => x.id === id);
    return r ? `Analysis v${r.version}` : 'Analysis report';
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={6} sx={fillCell}>
        <SectionCard title="Decision" subtitle="Each save is kept on record; earlier decisions are never overwritten.">
          {!hasPermission(user, 'submission:write') ? (
            <Typography variant="body2" color="text.secondary">
              You can view decisions. Only Underwriters can record one.
            </Typography>
          ) : (
            <form onSubmit={handleSubmit(save)} noValidate>
              <UnsavedChangesGuard when={isDirty && !create.isPending} />
              <Stack spacing={1.5}>
                {create.isError && <Alert severity="error">{errorMessage(create.error)}</Alert>}
                {errors.root ? (
                  <Alert severity="warning">{errors.root.message}</Alert>
                ) : (
                  acceptBlocked && <Alert severity="info">{acceptBlocker}</Alert>
                )}
                {create.isSuccess && !errors.root && (
                  <Alert severity="success">
                    Saved: {decisionMeta(create.data.decision).past}, {riskLabel(create.data.riskRating).toLowerCase()}{' '}
                    risk.
                  </Alert>
                )}

                <Box>
                  <Label>Outcome</Label>
                  <Controller
                    name="decision"
                    control={control}
                    render={({ field }) => (
                      <ToggleButtonGroup
                        exclusive
                        size="small"
                        value={field.value}
                        aria-label="Decision"
                        onChange={(_, v: Decision | null) => v && field.onChange(v)}
                        onBlur={field.onBlur}
                        sx={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 0.75,
                          '& .MuiToggleButtonGroup-grouped': { border: 1, borderRadius: '6px !important', m: 0 },
                        }}
                      >
                        {DECISIONS.map((d) => (
                          <Tooltip key={d.value} title={d.help} placement="top" arrow>
                            <ToggleButton value={d.value} sx={colored(tone(theme, decisionColor(d.value)))}>
                              {d.label}
                            </ToggleButton>
                          </Tooltip>
                        ))}
                      </ToggleButtonGroup>
                    )}
                  />
                  <Typography
                    variant="caption"
                    color={errors.decision ? 'error' : 'text.secondary'}
                    sx={{ display: 'block', mt: 0.5 }}
                  >
                    {errors.decision?.message ?? (decision ? decisionMeta(decision).help : 'Choose the outcome.')}
                  </Typography>
                </Box>

                <Box>
                  <Label>Risk level</Label>
                  <Controller
                    name="riskRating"
                    control={control}
                    render={({ field }) => (
                      <ToggleButtonGroup
                        exclusive
                        size="small"
                        fullWidth
                        value={field.value}
                        aria-label="Risk level"
                        onChange={(_, v: RiskRating | null) => v && field.onChange(v)}
                        onBlur={field.onBlur}
                      >
                        {RISKS.map((r) => (
                          <ToggleButton key={r.value} value={r.value} sx={colored(tone(theme, riskColor(r.value)))}>
                            {r.label}
                          </ToggleButton>
                        ))}
                      </ToggleButtonGroup>
                    )}
                  />
                  {errors.riskRating && (
                    <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
                      {errors.riskRating.message}
                    </Typography>
                  )}
                </Box>

                <Controller
                  name="analysisReportId"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      select
                      label="Based on"
                      fullWidth
                      {...field}
                      helperText={
                        completedAnalyses.length
                          ? undefined
                          : 'No finished analysis yet; the decision will not be linked to one.'
                      }
                    >
                      <MenuItem value="">
                        <em>No report</em>
                      </MenuItem>
                      {completedAnalyses.map((r, i) => (
                        <MenuItem key={r.id} value={r.id}>
                          Analysis v{r.version}
                          {i === 0 ? ' (newest)' : ''} · {formatDateTime(r.completedAt ?? r.createdAt)}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />

                <TextField
                  label="Reason for decision"
                  fullWidth
                  multiline
                  minRows={3}
                  maxRows={8}
                  {...register('notes')}
                  placeholder="e.g. Clean claims history, standard limits for the specialty."
                  error={!!errors.notes}
                  helperText={errors.notes?.message}
                />

                <Box>
                  <Button type="submit" variant="contained" disabled={create.isPending || acceptBlocked} sx={{ px: 3 }}>
                    {create.isPending ? 'Saving…' : 'Save decision'}
                  </Button>
                </Box>
              </Stack>
            </form>
          )}
        </SectionCard>
      </Grid>

      <Grid item xs={12} lg={6} sx={fillCell}>
        <SectionCard title="History" subtitle="Newest first.">
          {history.isLoading ? (
            <Loading label="Loading decisions…" shape="list" />
          ) : history.isError ? (
            <ErrorState error={history.error} onRetry={() => history.refetch()} />
          ) : !history.data?.length ? (
            <EmptyState title="No decisions yet" description="Saved decisions will appear here." />
          ) : (
            <Stack
              component="ol"
              spacing={0}
              sx={{ listStyle: 'none', m: 0, p: 0, maxHeight: 420, overflowY: 'auto', pr: 0.5 }}
            >
              {history.data.map((a, i) => (
                <HistoryRow key={a.id} a={a} current={i === 0} analysisLabel={analysisLabel(a.analysisReportId)} />
              ))}
            </Stack>
          )}
        </SectionCard>
      </Grid>

      <Grid item xs={12}>
        <Ims2IntakeQueueCard submissionId={submissionId} />
      </Grid>
    </Grid>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
      {children}
    </Typography>
  );
}

function HistoryRow({ a, current, analysisLabel }: { a: Assessment; current: boolean; analysisLabel: string | null }) {
  const theme = useTheme();
  const c = tone(theme, decisionColor(a.decision));
  const rc = tone(theme, riskColor(a.riskRating));
  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        gap: 1.25,
        py: 1.25,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Box
        aria-hidden
        sx={{
          mt: 0.6,
          width: 10,
          height: 10,
          borderRadius: '50%',
          flexShrink: 0,
          bgcolor: current ? c : 'transparent',
          border: 2,
          borderColor: c,
        }}
      />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" sx={{ fontWeight: 700, color: c }}>
            {decisionMeta(a.decision).past}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, color: rc }}>
            · {riskLabel(a.riskRating)} risk
          </Typography>
          {current && (
            <Typography variant="caption" sx={{ fontWeight: 700, color: 'primary.main' }}>
              CURRENT
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {a.createdBy.name} · {formatDateTime(a.createdAt)}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.25 }}>
          {a.notes}
        </Typography>
        <Typography variant="caption" color="text.disabled">
          v{a.version}
          {analysisLabel ? ` · ${analysisLabel}` : ''}
        </Typography>
      </Box>
    </Box>
  );
}
