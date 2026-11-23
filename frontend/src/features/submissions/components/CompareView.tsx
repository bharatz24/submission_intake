// Compare tab: two versions of ONE report kind (Synthesis vX vs vY, or Analysis vX vs vY), never across kinds.
// The backend diffs the structured content field by field, then the report-comparison skill explains what matters.
// Kind and versions live in the URL (?tab=compare&kind=&base=&target=) so the report tabs can deep-link here.
import CompareIcon from '@mui/icons-material/CompareArrowsOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Button,
  Chip,
  Grid,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, EnumChip, ErrorState, Linkify, Loading, Markdown, SectionCard } from '../../../components/common';
import { TokenUsageChip } from '../../../components/TokenCount';
import { FAILURE_MESSAGES, POLL_MS } from '../../../constants';
import { friendlyMessage } from '../../../lib/friendlyError';
import { formatDateTime, humanize, levelColor, reportStatusColor } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type {
  Comparison,
  ComparisonChange,
  ComparisonSummary,
  FieldChange,
  Level,
  ReportKind,
  ReportSummary,
} from '../../../types';
import { comparisonKeys } from '../queryKeys';
import { useReport, useReportList } from './ReportShell';

const KIND_LABEL: Record<ReportKind, string> = { SYNTHESIS: 'Synthesis', ANALYSIS: 'Analysis' };
const OVERALL_COLOR = { NONE: 'success', MINOR: 'warning', MATERIAL: 'error' } as const;
const CHANGE_COLOR = { ADDED: 'success', REMOVED: 'error', MODIFIED: 'info' } as const;
const SIGNIFICANCE_ORDER: Record<Level, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function useComparisonList(submissionId: string, kind: ReportKind) {
  return useQuery({
    queryKey: comparisonKeys.list(submissionId, kind),
    queryFn: ({ signal }) => apiWith(signal).listComparisons(submissionId, kind),
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'RUNNING') ? POLL_MS.reportRunning : false),
  });
}

function useComparison(id: string | null) {
  return useQuery({
    queryKey: comparisonKeys.detail(id),
    queryFn: ({ signal }) => apiWith(signal).getComparison(id as string),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? POLL_MS.reportRunning : false),
  });
}

/** Same pair in either order, ignoring failed runs. */
const samePair = (c: ComparisonSummary, a: string, b: string) =>
  c.status !== 'FAILED' &&
  ((c.baseReportId === a && c.targetReportId === b) || (c.baseReportId === b && c.targetReportId === a));

export function CompareView({ submissionId }: { submissionId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const kind: ReportKind = params.get('kind') === 'ANALYSIS' ? 'ANALYSIS' : 'SYNTHESIS';
  const reports = useReportList(submissionId, kind);
  const syntheses = useReportList(submissionId, 'SYNTHESIS');
  const comparisons = useComparisonList(submissionId, kind);
  const [startedId, setStartedId] = useState<string | null>(null);

  const completed = useMemo(
    () => (reports.data ?? []).filter((r) => r.status === 'COMPLETED').sort((a, b) => b.version - a.version),
    [reports.data],
  );
  const byId = (id: string | null) => completed.find((r) => r.id === id) ?? null;
  // Default: the latest version against the one before it.
  const base = byId(params.get('base')) ?? completed[1] ?? null;
  const target = byId(params.get('target')) ?? completed[0] ?? null;
  const validPair = !!base && !!target && base.id !== target.id;

  const setParam = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates))
      if (v) next.set(k, v);
      else next.delete(k);
    setParams(next, { replace: true });
    setStartedId(null);
  };

  const existing = validPair ? ((comparisons.data ?? []).find((c) => samePair(c, base.id, target.id)) ?? null) : null;
  const comparisonId = startedId ?? existing?.id ?? null;
  const comparison = useComparison(comparisonId);

  // When a comparison finishes, refresh the list so its status and cache entry are current.
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const st = comparison.data?.status;
    if (lastStatus.current === 'RUNNING' && st && st !== 'RUNNING')
      qc.invalidateQueries({ queryKey: comparisonKeys.all(submissionId) });
    lastStatus.current = st;
  }, [comparison.data?.status, qc, submissionId]);

  const run = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.compareReports(submissionId, { kind, baseReportId: base!.id, targetReportId: target!.id }),
    onSuccess: (summary) => {
      qc.invalidateQueries({ queryKey: comparisonKeys.list(submissionId, kind) });
      setStartedId(summary.id);
    },
  });

  const synthVersion = (id: string | null) => (syntheses.data ?? []).find((r) => r.id === id)?.version ?? null;
  const writable = hasPermission(user, 'submission:write');

  const versionPicker = (
    label: string,
    value: ReportSummary | null,
    other: ReportSummary | null,
    key: 'base' | 'target',
  ) => (
    <TextField
      select
      size="small"
      label={label}
      value={value?.id ?? ''}
      onChange={(e) => setParam({ [key]: e.target.value })}
      sx={{ minWidth: 200 }}
    >
      {completed.map((r, i) => (
        <MenuItem key={r.id} value={r.id} disabled={r.id === other?.id}>
          v{r.version}
          {i === 0 ? ' (latest)' : ''} · context v{r.contextVersion}
        </MenuItem>
      ))}
    </TextField>
  );

  return (
    <Stack spacing={2}>
      <SectionCard
        title="Compare versions"
        subtitle="Compares two versions of the same report: Synthesis with Synthesis, or Analysis with Analysis."
        actions={
          <ToggleButtonGroup
            size="small"
            exclusive
            value={kind}
            onChange={(_, v: ReportKind | null) =>
              v && setParam({ kind: v === 'SYNTHESIS' ? null : v, base: null, target: null })
            }
          >
            <ToggleButton value="SYNTHESIS">Synthesis</ToggleButton>
            <ToggleButton value="ANALYSIS">Analysis</ToggleButton>
          </ToggleButtonGroup>
        }
      >
        {reports.isLoading ? (
          <Loading label="Loading versions…" minHeight={60} />
        ) : reports.isError ? (
          <ErrorState error={reports.error} onRetry={() => reports.refetch()} title="Could not load versions" />
        ) : completed.length < 2 ? (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Comparison needs at least two completed {KIND_LABEL[kind]} versions; this submission has {completed.length}.
          </Alert>
        ) : (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            alignItems={{ sm: 'center' }}
            sx={{ mt: 1.5 }}
            flexWrap="wrap"
            useFlexGap
          >
            {versionPicker(`${KIND_LABEL[kind]} A (base)`, base, target, 'base')}
            <CompareIcon color="action" sx={{ display: { xs: 'none', sm: 'block' } }} />
            {versionPicker(`${KIND_LABEL[kind]} B (target)`, target, base, 'target')}
            {writable && !existing && (
              <Button
                variant="contained"
                startIcon={<CompareIcon />}
                disabled={!validPair || run.isPending}
                onClick={() => run.mutate()}
              >
                {run.isPending ? 'Starting…' : 'Compare'}
              </Button>
            )}
          </Stack>
        )}
        {run.isError && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {errorMessage(run.error)}
          </Alert>
        )}
        {validPair && !existing && !startedId && !writable && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            These versions have not been compared yet.
          </Alert>
        )}
      </SectionCard>

      {validPair && base && target && (
        <VersionMetaTable kind={kind} base={base} target={target} synthVersion={synthVersion} />
      )}

      {comparisonId &&
        (comparison.isLoading ? (
          <Loading label="Loading comparison…" />
        ) : comparison.isError ? (
          <ErrorState error={comparison.error} onRetry={() => comparison.refetch()} title="Could not load comparison" />
        ) : comparison.data ? (
          <ComparisonResult c={comparison.data} />
        ) : null)}

      {!comparisonId && completed.length >= 2 && (
        <Paper variant="outlined">
          <EmptyState
            icon={<CompareIcon />}
            title="No comparison yet"
            description={
              writable ? 'Pick two versions and click Compare.' : 'An underwriter has not compared these versions yet.'
            }
          />
        </Paper>
      )}

      {(comparisons.data?.length ?? 0) > 0 && (
        <PastComparisons
          items={comparisons.data!}
          activeId={comparisonId}
          onOpen={(c) => setParam({ base: c.baseReportId, target: c.targetReportId })}
        />
      )}
    </Stack>
  );
}

/** What differs between the two versions' inputs: the likely causes of any change. */
function VersionMetaTable({
  kind,
  base,
  target,
  synthVersion,
}: {
  kind: ReportKind;
  base: ReportSummary;
  target: ReportSummary;
  synthVersion: (id: string | null) => number | null;
}) {
  const rows: [string, string, string][] = [
    ['Version', `v${base.version}`, `v${target.version}`],
    ['Evidence context', `v${base.contextVersion}`, `v${target.contextVersion}`],
    ...(kind === 'ANALYSIS'
      ? [
          [
            'Based on Synthesis',
            `v${synthVersion(base.basedOnReportId) ?? '?'}`,
            `v${synthVersion(target.basedOnReportId) ?? '?'}`,
          ] as [string, string, string],
        ]
      : []),
    ['Skill version', base.skillVersion, target.skillVersion],
    ['Model', base.model, target.model],
    [
      'Generated',
      formatDateTime(base.completedAt ?? base.createdAt),
      formatDateTime(target.completedAt ?? target.createdAt),
    ],
  ];
  return (
    <SectionCard
      title="Version inputs"
      subtitle="Highlighted rows differ between A and B and may explain the changes below."
      dense
    >
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell width="22%" />
              <TableCell>A · v{base.version}</TableCell>
              <TableCell>B · v{target.version}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(([label, a, b]) => {
              const changed = label !== 'Version' && label !== 'Generated' && a !== b;
              return (
                <TableRow key={label} sx={changed ? { bgcolor: 'action.selected' } : undefined}>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {label}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ wordBreak: 'break-all' }}>{a}</TableCell>
                  <TableCell sx={{ wordBreak: 'break-all' }}>
                    {b}
                    {changed && (
                      <Chip
                        size="small"
                        label="changed"
                        color="warning"
                        variant="outlined"
                        sx={{ ml: 1, height: 18, fontSize: '0.65rem' }}
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </SectionCard>
  );
}

function ComparisonResult({ c }: { c: Comparison }) {
  const [mode, setMode] = useState<'explained' | 'side' | 'markdown'>('explained');
  return (
    <Stack spacing={2} useFlexGap>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1}
        justifyContent="space-between"
        alignItems={{ md: 'center' }}
      >
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
          <Chip size="small" color="primary" label={`${KIND_LABEL[c.kind]} v${c.baseVersion} → v${c.targetVersion}`} />
          <EnumChip value={c.status} color={reportStatusColor(c.status)} />
          {c.content && (
            <EnumChip
              value={c.content.overallChange}
              color={OVERALL_COLOR[c.content.overallChange]}
              label={`${humanize(c.content.overallChange)} change`}
            />
          )}
          <Chip
            size="small"
            variant="outlined"
            label={`${c.changeCount} field change${c.changeCount === 1 ? '' : 's'}`}
          />
          <Chip size="small" variant="outlined" label={`Skill ${c.skillName} @ ${c.skillVersion}`} />
          <Chip size="small" variant="outlined" label={c.model} />
          <TokenUsageChip usage={c.usage} />
          <Typography variant="caption" color="text.secondary">
            {c.createdBy ? `by ${c.createdBy.name} · ` : ''}
            {formatDateTime(c.completedAt ?? c.createdAt)}
          </Typography>
        </Stack>
        <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)}>
          <ToggleButton value="explained">Changes</ToggleButton>
          <ToggleButton value="side">Side by side</ToggleButton>
          <ToggleButton value="markdown">Markdown</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {c.status === 'RUNNING' && (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Stack spacing={1.5} alignItems="center">
            <Typography variant="body2">
              Claude is explaining {c.changeCount} field changes with skill <b>{c.skillName}</b>… this view updates
              automatically.
            </Typography>
            <LinearProgress sx={{ width: '60%' }} />
          </Stack>
        </Paper>
      )}
      {c.status === 'FAILED' && (
        <Alert severity="error">
          <b>Comparison failed.</b> {friendlyMessage(c.error, { empty: FAILURE_MESSAGES.noReason })} Click Compare to
          retry.
        </Alert>
      )}

      {mode === 'side' ? (
        <SideBySide c={c} />
      ) : c.status !== 'COMPLETED' || !c.content ? (
        c.status === 'FAILED' && c.fieldDiff.length > 0 ? (
          <FieldDiff items={c.fieldDiff} defaultExpanded />
        ) : null
      ) : mode === 'markdown' ? (
        <Paper variant="outlined" sx={{ p: 2.5 }}>
          {c.markdown ? (
            <Markdown>{c.markdown}</Markdown>
          ) : (
            <Typography color="text.secondary">No markdown rendering.</Typography>
          )}
        </Paper>
      ) : (
        <>
          <Grid container spacing={2}>
            <Grid item xs={12} lg={8}>
              <SectionCard title="Summary">
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  <Linkify>{c.content.summary}</Linkify>
                </Typography>
              </SectionCard>
            </Grid>
            <Grid item xs={12} lg={4}>
              <SectionCard title="Reviewer note">
                <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
                  <Linkify>{c.content.reviewerNote}</Linkify>
                </Typography>
              </SectionCard>
            </Grid>
          </Grid>
          <ChangesTable changes={c.content.changes} />
          {c.content.unchangedSections.length > 0 && (
            <SectionCard title="Unchanged sections" dense>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {c.content.unchangedSections.map((s) => (
                  <Chip key={s} size="small" variant="outlined" label={humanize(s)} />
                ))}
              </Stack>
            </SectionCard>
          )}
          {c.fieldDiff.length > 0 && <FieldDiff items={c.fieldDiff} />}
        </>
      )}
    </Stack>
  );
}

function ChangesTable({ changes }: { changes: ComparisonChange[] }) {
  const [filter, setFilter] = useState<Level | 'ALL'>('ALL');
  const rows = [...changes]
    .filter((x) => filter === 'ALL' || x.significance === filter)
    .sort((a, b) => SIGNIFICANCE_ORDER[a.significance] - SIGNIFICANCE_ORDER[b.significance]);
  const count = (l: Level) => changes.filter((x) => x.significance === l).length;
  return (
    <SectionCard
      title="What changed"
      subtitle="Each change is grounded in the field-level diff; significance is for the underwriting decision."
      actions={
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)}>
          <ToggleButton value="ALL">All {changes.length}</ToggleButton>
          {(['HIGH', 'MEDIUM', 'LOW'] as const).map((l) => (
            <ToggleButton key={l} value={l}>
              {humanize(l)} {count(l)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No changes{filter === 'ALL' ? '' : ` of ${humanize(filter).toLowerCase()} significance`}.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={100}>Significance</TableCell>
                <TableCell width="16%">Section</TableCell>
                <TableCell>Before → after</TableCell>
                <TableCell width="30%">Why it matters</TableCell>
                <TableCell width={130}>Likely cause</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((x, i) => (
                <TableRow key={i} sx={{ verticalAlign: 'top' }}>
                  <TableCell>
                    <EnumChip value={x.significance} color={levelColor(x.significance)} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{humanize(x.section)}</Typography>
                    <EnumChip value={x.changeType} color={CHANGE_COLOR[x.changeType]} variant="outlined" />
                  </TableCell>
                  <TableCell sx={{ wordBreak: 'break-word' }}>
                    <BeforeAfter before={x.before} after={x.after} />
                  </TableCell>
                  <TableCell sx={{ wordBreak: 'break-word' }}>
                    <Typography variant="body2">
                      <Linkify>{x.explanation}</Linkify>
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{humanize(x.likelyCause)}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </SectionCard>
  );
}

function BeforeAfter({ before, after }: { before: string; after: string }) {
  const line = (label: string, text: string, color: string, strike: boolean) => (
    <Stack direction="row" spacing={1} alignItems="baseline">
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 14 }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{ color, textDecoration: strike ? 'line-through' : 'none', whiteSpace: 'pre-wrap' }}
      >
        {text || '—'}
      </Typography>
    </Stack>
  );
  return (
    <Stack spacing={0.5}>
      {line('A', before, 'error.main', before !== '—' && !!before)}
      {line('B', after, 'success.main', false)}
    </Stack>
  );
}

const preview = (v: unknown) => {
  if (v === null || v === undefined) return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
  return s.length > 400 ? `${s.slice(0, 399)}…` : s;
};

/** The deterministic diff the explanation is grounded in. */
function FieldDiff({ items, defaultExpanded = false }: { items: FieldChange[]; defaultExpanded?: boolean }) {
  return (
    <Accordion variant="outlined" disableGutters defaultExpanded={defaultExpanded}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Field-level diff ({items.length})</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width="30%">Field</TableCell>
                <TableCell width={100}>Change</TableCell>
                <TableCell>A</TableCell>
                <TableCell>B</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((f, i) => (
                <TableRow key={i} sx={{ verticalAlign: 'top' }}>
                  <TableCell
                    sx={{
                      fontFamily: 'ui-monospace, Consolas, monospace',
                      fontSize: '0.75rem',
                      wordBreak: 'break-all',
                    }}
                  >
                    {f.path}
                  </TableCell>
                  <TableCell>
                    <EnumChip value={f.changeType} color={CHANGE_COLOR[f.changeType]} variant="outlined" />
                  </TableCell>
                  <TableCell sx={{ fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {preview(f.before)}
                  </TableCell>
                  <TableCell sx={{ fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {preview(f.after)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </AccordionDetails>
    </Accordion>
  );
}

/** Both versions' rendered reports next to each other (stacked on narrow screens). */
function SideBySide({ c }: { c: Comparison }) {
  const a = useReport(c.baseReportId);
  const b = useReport(c.targetReportId);
  const pane = (label: string, q: typeof a) => (
    <Grid item xs={12} lg={6}>
      <Paper variant="outlined" sx={{ p: 2.5, height: '100%' }}>
        <Typography variant="overline" color="text.secondary">
          {label}
        </Typography>
        {q.isLoading ? (
          <Loading label="Loading report…" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load report" />
        ) : q.data?.markdown ? (
          <Markdown>{q.data.markdown}</Markdown>
        ) : (
          <Typography color="text.secondary">No markdown rendering for this version.</Typography>
        )}
      </Paper>
    </Grid>
  );
  return (
    <Grid container spacing={2}>
      {pane(`A · ${KIND_LABEL[c.kind]} v${c.baseVersion}`, a)}
      {pane(`B · ${KIND_LABEL[c.kind]} v${c.targetVersion}`, b)}
    </Grid>
  );
}

function PastComparisons({
  items,
  activeId,
  onOpen,
}: {
  items: ComparisonSummary[];
  activeId: string | null;
  onOpen: (c: ComparisonSummary) => void;
}) {
  return (
    <SectionCard title="Previous comparisons" dense>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Versions</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Field changes</TableCell>
              <TableCell>Skill</TableCell>
              <TableCell>When</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((c) => (
              <TableRow
                key={c.id}
                hover
                selected={c.id === activeId}
                onClick={() => onOpen(c)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell>
                  v{c.baseVersion} → v{c.targetVersion}
                </TableCell>
                <TableCell>
                  <EnumChip value={c.status} color={reportStatusColor(c.status)} />
                </TableCell>
                <TableCell>{c.changeCount}</TableCell>
                <TableCell>
                  <Typography variant="caption">{c.skillVersion}</Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="caption">
                    {c.createdBy ? `${c.createdBy.name} · ` : ''}
                    {formatDateTime(c.createdAt)}
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </SectionCard>
  );
}
