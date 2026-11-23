// Monitoring > Token usage: estimated Claude spend (GET /monitoring/llm-usage) — fixed 24 h / 7 d / 30 d totals, spend
// by task and by model for the chosen range, and the submissions that cost the most. Estimates from list prices.
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import {
  Box,
  Grid,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { type ReactNode, useId } from 'react';
import { Link as RouterLink } from 'react-router';

import { humanize } from '../../../lib/status';
import { paths } from '../../../paths';
import type { LlmUsage } from '../../../types';

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** US dollars with cents; a positive amount under one cent shows as "<$0.01"; null (no known price) as a dash. */
export const formatUsd = (n: number | null) => (n === null ? '—' : n > 0 && n < 0.005 ? '<$0.01' : currency.format(n));

const num = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } as const;

const PERIODS = [
  ['24h', 'Spend (24 h)', 'Rolling last 24 hours'],
  ['7d', 'Spend (7 d)', 'Rolling last 7 days'],
  ['30d', 'Spend (30 d)', 'Rolling last 30 days'],
] as const;

/** The amount with a bar: its share of the largest amount in the table (one hue, no legend: the column names it). */
function CostCell({ value, max }: { value: number | null; max: number }) {
  return (
    <TableCell align="right" sx={{ width: '35%', minWidth: 96 }}>
      <Tooltip title={value === null ? 'No price known for these calls' : `${currency.format(value)} estimated`}>
        <Box component="span" sx={num}>
          {formatUsd(value)}
        </Box>
      </Tooltip>
      <Box aria-hidden sx={{ mt: 0.5, height: 4, borderRadius: 2, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box
          sx={{
            height: '100%',
            width: `${max > 0 && value ? (value / max) * 100 : 0}%`,
            bgcolor: 'primary.main',
            borderRadius: 2,
          }}
        />
      </Box>
    </TableCell>
  );
}

function SpendTable({
  label,
  first,
  rows,
}: {
  label: string;
  first: string;
  rows: { key: string; name: ReactNode; calls: number; costUsd: number | null }[];
}) {
  const max = Math.max(0, ...rows.map((r) => r.costUsd ?? 0));
  return (
    <TableContainer>
      <Table size="small" aria-label={label}>
        <TableHead>
          <TableRow>
            <TableCell>{first}</TableCell>
            <TableCell align="right">Requests</TableCell>
            <TableCell align="right">Est. cost</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell sx={{ overflowWrap: 'anywhere' }}>{r.name}</TableCell>
              <TableCell align="right" sx={num}>
                {r.calls.toLocaleString('en-US')}
              </TableCell>
              <CostCell value={r.costUsd} max={max} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

const byCostDesc = (a: { costUsd: number | null }, b: { costUsd: number | null }) =>
  (b.costUsd ?? -1) - (a.costUsd ?? -1);

/** byModel holds one row per task and model; summed per model here. */
function perModel(rows: LlmUsage['summary']['byModel']) {
  const out = new Map<string, { calls: number; costUsd: number | null }>();
  for (const r of rows) {
    const m = out.get(r.model) ?? { calls: 0, costUsd: null };
    m.calls += r.calls;
    if (r.costUsd !== null) m.costUsd = (m.costUsd ?? 0) + r.costUsd;
    out.set(r.model, m);
  }
  return [...out].map(([model, v]) => ({ model, ...v }));
}

export function SpendPanel({ usage, period }: { usage: LlmUsage; period: string }) {
  const headingId = useId();
  const t = usage.summary;
  const tasks = [...t.byTask].sort(byCostDesc);
  const models = perModel(t.byModel).sort(byCostDesc);
  const priced = t.costUsd !== null;
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} variant="subtitle2" component="h2">
        Estimated Claude spend
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
        Estimated from list prices per model, not billing · calls with an unknown model show “—”
      </Typography>
      <Grid container spacing={1.5}>
        {PERIODS.map(([key, label, hint]) => (
          <Grid item xs={12} sm={4} key={key}>
            <Paper
              variant="outlined"
              role="group"
              aria-label={label}
              sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1.5, height: '100%' }}
            >
              <PaymentsOutlinedIcon aria-hidden sx={{ fontSize: 28, color: 'primary.main' }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="overline" component="div" sx={{ fontSize: '0.65rem', lineHeight: 1.4 }}>
                  {label}
                </Typography>
                <Typography variant="h5" component="div" sx={{ lineHeight: 1.2, ...num }}>
                  {formatUsd(usage.spend[key])}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {hint}
                </Typography>
              </Box>
            </Paper>
          </Grid>
        ))}
      </Grid>
      {!priced && usage.topSubmissions.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          No priced Claude requests in this period.
        </Typography>
      ) : (
        <Grid container spacing={2.5} sx={{ mt: 0 }}>
          <Grid item xs={12} md={4}>
            <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
              By task · {period} · {formatUsd(t.costUsd)}
            </Typography>
            <SpendTable
              label="Spend by task"
              first="Task"
              rows={tasks.map((r) => ({ key: r.task, name: humanize(r.task), calls: r.calls, costUsd: r.costUsd }))}
            />
          </Grid>
          <Grid item xs={12} md={4}>
            <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
              By model · {period}
            </Typography>
            <SpendTable
              label="Spend by model"
              first="Model"
              rows={models.map((r) => ({
                key: r.model,
                name: (
                  <Box component="span" sx={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.75rem' }}>
                    {r.model}
                  </Box>
                ),
                calls: r.calls,
                costUsd: r.costUsd,
              }))}
            />
          </Grid>
          <Grid item xs={12} md={4}>
            <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
              Top submissions · {period}
            </Typography>
            {usage.topSubmissions.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No submission-linked spend in this period.
              </Typography>
            ) : (
              <SpendTable
                label="Top submissions by cost"
                first="Submission"
                rows={usage.topSubmissions.map((s) => ({
                  key: s.submissionId,
                  name: (
                    <Link component={RouterLink} to={paths.submission(s.submissionId)} variant="body2">
                      {s.applicantName || 'Unnamed applicant'}
                    </Link>
                  ),
                  calls: s.calls,
                  costUsd: s.costUsd,
                }))}
              />
            )}
          </Grid>
        </Grid>
      )}
    </Box>
  );
}
