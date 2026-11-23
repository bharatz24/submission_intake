// Shared scaffolding for versioned, async reports (Synthesis + Analysis):
// version selector, generate button, 2s polling while RUNNING, metadata, structured/markdown toggle.
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CompareIcon from '@mui/icons-material/CompareArrowsOutlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, EnumChip, ErrorState, Loading, Markdown } from '../../../components/common';
import { TokenUsageChip } from '../../../components/TokenCount';
import { FAILURE_MESSAGES, POLL_MS } from '../../../constants';
import { friendlyMessage } from '../../../lib/friendlyError';
import { formatDateTime, reportStatusColor } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { Report, ReportKind, ReportSummary } from '../../../types';
import { reportKeys, submissionKeys } from '../queryKeys';
import { GroundingSummary } from './GroundingSummary';
import { NeedsReviewChip } from './NeedsReviewChip';

export function useReportList(submissionId: string, kind: ReportKind) {
  return useQuery({
    queryKey: reportKeys.list(submissionId, kind),
    queryFn: ({ signal }) => apiWith(signal).listReports(submissionId, kind),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'RUNNING') ? POLL_MS.reportRunning : false),
  });
}

export function useReport(reportId: string | null) {
  return useQuery({
    queryKey: reportKeys.detail(reportId),
    queryFn: ({ signal }) => apiWith(signal).getReport(reportId as string),
    enabled: !!reportId,
    refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? POLL_MS.reportRunning : false),
  });
}

interface ShellProps {
  submissionId: string;
  kind: ReportKind;
  title: string;
  description: string;
  /** If set, Generate is disabled and this hint is shown. */
  generateBlockedReason?: string | null;
  /** Replaces the empty state's text when there is no version yet (e.g. the step is Manual in Settings → Automation). */
  emptyDescription?: string | null;
  generate: () => Promise<ReportSummary>;
  renderStructured: (report: Report) => ReactNode;
  extraHeader?: ReactNode;
}

export function ReportShell({
  submissionId,
  kind,
  title,
  description,
  generateBlockedReason,
  emptyDescription,
  generate,
  renderStructured,
  extraHeader,
}: ShellProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const list = useReportList(submissionId, kind);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'structured' | 'markdown'>('structured');
  const [params, setParams] = useSearchParams();

  const effectiveId = selectedId ?? list.data?.[0]?.id ?? null;
  const report = useReport(effectiveId);

  // When a report finishes, refresh dependent views (submission header, versions, other kind's gating).
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const st = report.data?.status;
    if (lastStatus.current === 'RUNNING' && st && st !== 'RUNNING') {
      qc.invalidateQueries({ queryKey: reportKeys.all(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.detail(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.versions(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
    }
    lastStatus.current = st;
  }, [report.data?.status, qc, submissionId]);

  const gen = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: generate,
    onSuccess: (summary) => {
      qc.setQueryData<ReportSummary[]>(reportKeys.list(submissionId, kind), (old) => [
        summary,
        ...(old ?? []).filter((r) => r.id !== summary.id),
      ]);
      qc.invalidateQueries({ queryKey: reportKeys.list(submissionId, kind) });
      qc.invalidateQueries({ queryKey: submissionKeys.versions(submissionId) });
      setSelectedId(summary.id);
    },
  });

  // "Mark reviewed" on a report generated automatically; the decision views and inbox read needsReview too.
  const review = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (reportId: string) => api.reviewReport(submissionId, reportId),
    onSuccess: (updated) => {
      qc.setQueryData(reportKeys.detail(updated.id), updated);
      qc.invalidateQueries({ queryKey: reportKeys.all(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.detail(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
    },
  });

  const running = list.data?.some((r) => r.status === 'RUNNING') ?? false;

  // The selected version against the completed version just before it, on the Compare tab.
  const completed = (list.data ?? []).filter((r) => r.status === 'COMPLETED');
  const selected = completed.find((r) => r.id === effectiveId);
  const previous = selected ? completed.find((r) => r.version < selected.version) : undefined;
  const openCompare = () => {
    const next = new URLSearchParams(params);
    next.set('tab', 'compare');
    if (kind === 'SYNTHESIS') next.delete('kind');
    else next.set('kind', kind);
    next.set('base', previous!.id);
    next.set('target', selected!.id);
    setParams(next, { replace: true });
  };
  const blocked = !!generateBlockedReason;
  const writable = hasPermission(user, 'submission:write');

  const generateButton = writable && (
    <Tooltip title={generateBlockedReason ?? (running ? 'A version is already running' : '')}>
      <span>
        <Button
          variant="contained"
          startIcon={<AutoAwesomeIcon />}
          onClick={() => gen.mutate()}
          disabled={blocked || gen.isPending || running}
        >
          {gen.isPending ? 'Starting…' : 'Generate new version'}
        </Button>
      </span>
    </Tooltip>
  );

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          alignItems={{ md: 'center' }}
          justifyContent="space-between"
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1">{title}</Typography>
            <Typography variant="caption" color="text.secondary">
              {description}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {list.data && list.data.length > 0 && (
              <TextField
                select
                label="Version"
                value={effectiveId ?? ''}
                onChange={(e) => setSelectedId(e.target.value)}
                sx={{ minWidth: 200 }}
              >
                {list.data.map((r, i) => (
                  <MenuItem key={r.id} value={r.id}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>
                        v{r.version}
                        {i === 0 ? ' (latest)' : ''}
                      </span>
                      <EnumChip value={r.status} color={reportStatusColor(r.status)} />
                    </Stack>
                  </MenuItem>
                ))}
              </TextField>
            )}
            {previous && (
              <Tooltip title={`Compare v${selected!.version} with v${previous.version}`}>
                <Button variant="outlined" startIcon={<CompareIcon />} onClick={openCompare}>
                  Compare with previous
                </Button>
              </Tooltip>
            )}
            {generateButton}
          </Stack>
        </Stack>
        {blocked && writable && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            {generateBlockedReason}
          </Alert>
        )}
        {gen.isError && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {errorMessage(gen.error)}
          </Alert>
        )}
        {extraHeader}
      </Paper>

      {list.isLoading ? (
        <Loading label="Loading versions…" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} title="Could not load report versions" />
      ) : !effectiveId ? (
        <Paper variant="outlined">
          <EmptyState
            icon={<AutoAwesomeIcon />}
            title={`No ${kind === 'SYNTHESIS' ? 'synthesis' : 'analysis'} yet`}
            description={
              blocked
                ? (generateBlockedReason ?? undefined)
                : (emptyDescription ??
                  (writable
                    ? 'Generate the first version to get started.'
                    : 'An underwriter has not generated this report yet.'))
            }
          />
        </Paper>
      ) : report.isLoading ? (
        <Loading label="Loading report…" minHeight={320} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => report.refetch()} title="Could not load report" />
      ) : report.data ? (
        // useFlexGap: margin-based spacing would reset the report Grid's negative margins and shift its cards out of line.
        <Stack spacing={2} useFlexGap>
          <ReportMeta report={report.data} mode={mode} onMode={setMode} />
          {report.data.status === 'RUNNING' && (
            <Paper variant="outlined" sx={{ p: 3 }}>
              <Stack spacing={1.5} alignItems="center">
                <Typography variant="body2">
                  Claude is generating v{report.data.version} with skill <b>{report.data.skillName}</b>… this view
                  updates automatically.
                </Typography>
                <LinearProgress sx={{ width: '60%' }} />
              </Stack>
            </Paper>
          )}
          {report.data.status === 'FAILED' && (
            <Alert severity="error">
              <b>Generation failed.</b> {friendlyMessage(report.data.error, { empty: FAILURE_MESSAGES.reportNoReason })}
            </Alert>
          )}
          {report.data.status === 'COMPLETED' && (
            <ReportChecks
              report={report.data}
              onReview={writable ? (id) => review.mutate(id) : undefined}
              pending={review.isPending}
              error={review.isError ? errorMessage(review.error) : null}
            />
          )}
          {report.data.status === 'COMPLETED' &&
            (mode === 'markdown' ? (
              <Paper variant="outlined" sx={{ p: 2.5 }}>
                {report.data.markdown ? (
                  <Markdown>{report.data.markdown}</Markdown>
                ) : (
                  <Typography color="text.secondary">No markdown rendering for this version.</Typography>
                )}
              </Paper>
            ) : report.data.content ? (
              renderStructured(report.data)
            ) : (
              <Alert severity="warning">This version has no structured content. Switch to the markdown view.</Alert>
            ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

/** Review status of automatic output and the grounding summary, above the report body. */
function ReportChecks({
  report,
  onReview,
  pending,
  error,
}: {
  report: Report;
  onReview?: (reportId: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const showsReview = report.needsReview || !!report.reviewedBy;
  if (!showsReview && !report.grounding?.unverified && !error) return null;
  return (
    <Stack spacing={1}>
      <NeedsReviewChip
        needsReview={report.needsReview}
        reviewedBy={report.reviewedBy}
        reviewedAt={report.reviewedAt}
        onReview={onReview && (() => onReview(report.id))}
        pending={pending}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <GroundingSummary grounding={report.grounding} />
    </Stack>
  );
}

function ReportMeta({
  report,
  mode,
  onMode,
}: {
  report: Report;
  mode: 'structured' | 'markdown';
  onMode: (m: 'structured' | 'markdown') => void;
}) {
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1}
      justifyContent="space-between"
      alignItems={{ md: 'center' }}
    >
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip size="small" color="primary" label={`v${report.version}`} />
        <EnumChip value={report.status} color={reportStatusColor(report.status)} />
        <Chip size="small" variant="outlined" label={`Skill ${report.skillName} @ ${report.skillVersion}`} />
        <Chip size="small" variant="outlined" label={report.model} />
        <Chip size="small" variant="outlined" label={`Context v${report.contextVersion}`} />
        <TokenUsageChip usage={report.usage} />
        <Typography variant="caption" color="text.secondary">
          {report.createdBy ? `by ${report.createdBy.name} · ` : ''}started {formatDateTime(report.createdAt)}
          {report.completedAt ? ` · completed ${formatDateTime(report.completedAt)}` : ''}
        </Typography>
      </Stack>
      <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && onMode(v)}>
        <ToggleButton value="structured">Structured</ToggleButton>
        <ToggleButton value="markdown">Markdown</ToggleButton>
      </ToggleButtonGroup>
    </Stack>
  );
}
