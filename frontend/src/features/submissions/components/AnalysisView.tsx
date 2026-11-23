import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  alpha,
  Box,
  Chip,
  Divider,
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
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import { EnumChip, KeyValue, Linkify } from '../../../components/common';
import type { Tone } from '../../../components/ReportSection';
import { accent, Section, SlimEmpty } from '../../../components/ReportSection';
import { COMPLETENESS_THRESHOLDS } from '../../../constants';
import { useManualStep } from '../../../lib/automation';
import type { ApplicantName } from '../../../lib/status';
import { applicantNameFields, humanize, levelColor, recommendationColor, riskColor } from '../../../lib/status';
import { api } from '../../../services/api';
import type { AnalysisContent, Finding, GroundingItem, Report } from '../../../types';
import { NotFoundMarker, unverifiedByPath } from './GroundingSummary';
import { ReportShell, useReportList } from './ReportShell';

export function AnalysisView({
  submissionId,
  applicant,
  held = false,
}: {
  submissionId: string;
  applicant: ApplicantName;
  held?: boolean;
}) {
  const manual = useManualStep('analysis', held);
  const syntheses = useReportList(submissionId, 'SYNTHESIS');
  const completed = (syntheses.data ?? []).filter((r) => r.status === 'COMPLETED');
  const [basedOn, setBasedOn] = useState<string>('');

  const blocked = syntheses.isLoading
    ? 'Checking synthesis status…'
    : completed.length === 0
      ? 'Analysis needs a completed Synthesis Report first — generate one on the Synthesis tab.'
      : null;

  const synthLabel = (id: string | null) => {
    const r = (syntheses.data ?? []).find((x) => x.id === id);
    return r ? `Synthesis v${r.version}` : null;
  };

  return (
    <ReportShell
      submissionId={submissionId}
      kind="ANALYSIS"
      title="Analysis Report"
      description="LLM Analysis interprets the risks: grounded only in the facts established by a completed Synthesis."
      generateBlockedReason={blocked}
      emptyDescription={
        manual ? "Analysis is Manual in Settings → Automation. Generate the first version when you're ready." : null
      }
      generate={() => api.generateAnalysis(submissionId, basedOn || undefined)}
      extraHeader={
        completed.length > 1 ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
            <TextField
              select
              label="Base new version on"
              value={basedOn}
              onChange={(e) => setBasedOn(e.target.value)}
              sx={{ minWidth: 260 }}
            >
              <MenuItem value="">Latest completed synthesis (v{completed[0]?.version})</MenuItem>
              {completed.map((r) => (
                <MenuItem key={r.id} value={r.id}>
                  Synthesis v{r.version} (context v{r.contextVersion})
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        ) : undefined
      }
      renderStructured={(r: Report) => (
        <AnalysisBody
          c={r.content as AnalysisContent}
          basedOn={synthLabel(r.basedOnReportId)}
          applicant={applicant}
          unverified={unverifiedByPath(r.grounding)}
        />
      )}
    />
  );
}

function AnalysisBody({
  c,
  basedOn,
  applicant,
  unverified,
}: {
  c: AnalysisContent;
  basedOn: string | null;
  applicant: ApplicantName;
  /** Evidence not found in the submission, by path ("riskIndicators[0].evidence[1]"). */
  unverified: Map<string, GroundingItem>;
}) {
  const score = Math.max(0, Math.min(100, Number(c.applicationCompleteness?.score ?? 0)));
  const scoreColor =
    score >= COMPLETENESS_THRESHOLDS.success
      ? 'success'
      : score >= COMPLETENESS_THRESHOLDS.warning
        ? 'warning'
        : 'error';
  const risk = riskColor(c.overallRisk);
  const all = [c.riskIndicators, c.inconsistencies, c.potentialConcerns].flatMap((g) => g ?? []);
  const high = all.filter((f) => f.severity === 'HIGH').length;
  const medium = all.filter((f) => f.severity === 'MEDIUM').length;
  const low = all.filter((f) => f.severity === 'LOW').length;
  const questions = c.followUpQuestions ?? [];
  const steps = c.recommendedNextSteps ?? [];

  return (
    <Stack spacing={1.5} useFlexGap>
      {/* Hero: identity + the decision signals, always on top. */}
      <Paper variant="outlined" sx={{ p: 2, borderLeft: 5, borderLeftColor: accent(risk) }}>
        <Grid container spacing={1.5}>
          {applicantNameFields(applicant).map((f) => (
            <Grid key={f.label} item xs={6} md={3}>
              <KeyValue label={f.label} value={f.value} />
            </Grid>
          ))}
        </Grid>
        <Divider sx={{ my: 1.5 }} />
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={6} md={2.5}>
            <Typography variant="overline" sx={{ fontSize: '0.65rem' }}>
              Overall risk
            </Typography>
            <Box>
              <EnumChip value={c.overallRisk} color={risk} size="medium" label={`${humanize(c.overallRisk)} risk`} />
            </Box>
          </Grid>
          <Grid item xs={6} md={3}>
            <Typography variant="overline" sx={{ fontSize: '0.65rem' }}>
              Recommendation
            </Typography>
            <Box>
              <EnumChip value={c.recommendation} color={recommendationColor(c.recommendation)} size="medium" />
            </Box>
          </Grid>
          <Grid item xs={12} sm={6} md={3.5}>
            <Typography variant="overline" sx={{ fontSize: '0.65rem' }}>
              Application completeness
            </Typography>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <LinearProgress
                variant="determinate"
                value={score}
                color={scoreColor}
                sx={{ flex: 1, height: 8, borderRadius: 4 }}
              />
              <Typography variant="subtitle1">{score}%</Typography>
            </Stack>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="overline" sx={{ fontSize: '0.65rem' }}>
              Findings by severity
            </Typography>
            <Stack direction="row" spacing={0.5}>
              <Chip size="small" color="error" variant={high ? 'filled' : 'outlined'} label={`${high} high`} />
              <Chip size="small" color="warning" variant={medium ? 'filled' : 'outlined'} label={`${medium} med`} />
              <Chip size="small" color="info" variant={low ? 'filled' : 'outlined'} label={`${low} low`} />
            </Stack>
          </Grid>
        </Grid>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
          {basedOn ? `Based on ${basedOn} · ` : ''}AI-generated interpretation to support — not replace — underwriter
          judgment.
        </Typography>
      </Paper>

      {/* Every section is a full-width band, like Follow-up questions; content uses the width horizontally. */}
      <Section title="Executive summary">
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          <Linkify>{c.executiveSummary}</Linkify>
        </Typography>
      </Section>
      <Section title="Recommended next steps" tone="success" count={steps.length}>
        {steps.length ? (
          <Box
            component="ol"
            sx={{
              m: 0,
              pl: 2.5,
              columnCount: { xs: 1, md: 2 },
              columnGap: '32px',
              '& li': { fontSize: '0.85rem', mb: 0.75, breakInside: 'avoid' },
            }}
          >
            {steps.map((s, i) => (
              <li key={i}>
                <Linkify>{s}</Linkify>
              </li>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            None.
          </Typography>
        )}
      </Section>
      <FindingsSection
        title="Risk indicators"
        tone="error"
        findings={c.riskIndicators}
        path="riskIndicators"
        unverified={unverified}
      />
      <FindingsSection
        title="Inconsistencies"
        tone="warning"
        findings={c.inconsistencies}
        path="inconsistencies"
        unverified={unverified}
      />
      <FindingsSection
        title="Potential concerns"
        tone="info"
        findings={c.potentialConcerns}
        path="potentialConcerns"
        unverified={unverified}
      />
      <ListSection
        title="Completeness gaps"
        tone="warning"
        items={c.applicationCompleteness?.gaps ?? []}
        subtitle={c.applicationCompleteness?.summary}
        empty="No gaps identified."
      />
      <ListSection
        title="Missing information"
        tone="error"
        items={c.missingInformation ?? []}
        empty="Nothing missing."
      />
      <ListSection
        title="Limitations & uncertainties"
        tone="secondary"
        items={c.limitationsAndUncertainties ?? []}
        empty="None stated."
      />

      {/* Follow-up questions: full-width table, open by default but collapsible. */}
      <Accordion
        variant="outlined"
        defaultExpanded
        disableGutters
        sx={{
          '&:before': { display: 'none' },
          overflow: 'hidden',
          '&, &:first-of-type, &:last-of-type': { borderRadius: 1 },
        }}
      >
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          sx={{
            borderLeft: 4,
            borderLeftColor: 'primary.main',
            bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
            minHeight: 40,
            '& .MuiAccordionSummary-content': { my: 0.75 },
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: 0.2, color: 'primary.dark' }}>
              Follow-up questions
            </Typography>
            <Chip
              size="small"
              color="primary"
              label={questions.length}
              sx={{ height: 20, minWidth: 24, fontWeight: 700, fontSize: '0.72rem' }}
            />
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 1.5 }}>
          {questions.length ? (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Question</TableCell>
                    <TableCell>Rationale</TableCell>
                    <TableCell width={160}>Addressed to</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {questions.map((q, i) => (
                    <TableRow key={i}>
                      <TableCell sx={{ fontWeight: 600 }}>
                        <Linkify>{q.question}</Linkify>
                      </TableCell>
                      <TableCell>
                        <Linkify>{q.rationale}</Linkify>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" variant="outlined" label={q.addressedTo} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No follow-up questions.
            </Typography>
          )}
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}

/** Bullet list laid out in columns across the full width; an empty list becomes a slim line. */
function ListSection({
  title,
  tone,
  items,
  subtitle,
  empty,
}: {
  title: string;
  tone: Tone;
  items: string[];
  subtitle?: string;
  empty: string;
}) {
  if (items.length === 0) return <SlimEmpty title={title} tone={tone} text={empty} />;
  return (
    <Section title={title} tone={tone} count={items.length} subtitle={subtitle}>
      <Box
        component="ul"
        sx={{
          m: 0,
          pl: 2.5,
          columnCount: { xs: 1, md: 2, xl: 3 },
          columnGap: '32px',
          '& li': { fontSize: '0.85rem', mb: 0.5, breakInside: 'avoid' },
        }}
      >
        {items.map((it, i) => (
          <li key={i}>
            <Linkify>{it}</Linkify>
          </li>
        ))}
      </Box>
    </Section>
  );
}

/** Findings as a full-width table: one row per finding, details and evidence beside the severity. */
function FindingsSection({
  title,
  tone,
  findings,
  path,
  unverified,
}: {
  title: string;
  tone: Tone;
  findings: Finding[] | undefined;
  /** The content key, for matching grounding paths ("riskIndicators[0].evidence[1]"). */
  path: string;
  unverified: Map<string, GroundingItem>;
}) {
  // Each finding keeps its index in the content: grounding paths refer to it, and the table sorts by severity.
  const list = (findings ?? []).map((f, at) => ({ ...f, at })).sort((a, b) => sev(a.severity) - sev(b.severity));
  if (list.length === 0) return <SlimEmpty title={title} tone={tone} text="None identified" />;
  return (
    <Section title={title} tone={tone} count={list.length}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell width="22%">Finding</TableCell>
              <TableCell width={150}>Severity / confidence</TableCell>
              <TableCell>Detail</TableCell>
              <TableCell width="28%">Evidence</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {list.map((f, i) => {
              const color = levelColor(f.severity);
              return (
                <TableRow
                  key={i}
                  sx={{
                    '& > td': { verticalAlign: 'top' },
                    '& > td:first-of-type': { borderLeft: 3, borderLeftColor: accent(color) },
                  }}
                >
                  <TableCell sx={{ fontWeight: 600 }}>{f.title}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" alignItems="center">
                      <Tooltip title={`${humanize(f.severity)} severity`} arrow>
                        <span>
                          <EnumChip value={f.severity} color={color} label={`${short(f.severity)} sev`} />
                        </span>
                      </Tooltip>
                      <Tooltip title={`${humanize(f.confidence)} confidence`} arrow>
                        <span>
                          <EnumChip
                            value={f.confidence}
                            color={levelColor(f.confidence, true)}
                            variant="outlined"
                            label={`${short(f.confidence)} conf`}
                          />
                        </span>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Linkify>{f.detail}</Linkify>
                  </TableCell>
                  <TableCell>
                    {(f.evidence ?? []).map((e, j) => (
                      <Typography
                        key={j}
                        variant="caption"
                        component="div"
                        color="text.secondary"
                        sx={{ borderLeft: 2, borderColor: 'divider', pl: 1, mb: 0.25, fontStyle: 'italic' }}
                      >
                        <Linkify>{e}</Linkify>
                        <NotFoundMarker item={unverified.get(`${path}[${f.at}].evidence[${j}]`)} />
                      </Typography>
                    ))}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Section>
  );
}

/** Short chip text for a level; the tooltip carries the full name. */
function short(v: string): string {
  const h = humanize(v);
  return h === 'Medium' ? 'Med' : h;
}

function sev(s: string): number {
  return s === 'HIGH' ? 0 : s === 'MEDIUM' ? 1 : 2;
}
