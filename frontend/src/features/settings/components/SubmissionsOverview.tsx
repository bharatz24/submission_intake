import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Grid,
  Link as MuiLink,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';

import { EnumChip, SectionCard } from '../../../components/common';
import { submissionStatusColor } from '../../../lib/status';
import type { SubmissionStatus } from '../../../types';

/** A headline number. `info` explains it in plain words; `to` or `onClick` makes the whole card clickable. */
export function StatCard({
  label,
  value,
  hint,
  tone,
  icon,
  info,
  to,
  onClick,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: 'error' | 'warning' | 'success';
  icon?: ReactNode;
  info?: string;
  to?: string;
  onClick?: () => void;
}) {
  const body = (
    <CardContent sx={{ py: 1.75, '&:last-child': { pb: 1.75 } }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
        {icon && (
          <Box
            sx={(t) => ({
              display: 'grid',
              placeItems: 'center',
              width: 28,
              height: 28,
              borderRadius: 1,
              flexShrink: 0,
              color: tone ? `${tone}.main` : 'primary.main',
              bgcolor: alpha(tone ? t.palette[tone].main : t.palette.primary.main, 0.1),
              '& svg': { fontSize: 18 },
            })}
          >
            {icon}
          </Box>
        )}
        <Typography variant="body2" color="text.secondary" fontWeight={500} sx={{ flexGrow: 1, lineHeight: 1.3 }}>
          {label}
        </Typography>
        {info && (
          <Tooltip title={info}>
            <InfoOutlinedIcon sx={{ fontSize: 16, color: 'text.disabled' }} aria-label={info} />
          </Tooltip>
        )}
      </Stack>
      <Typography variant="h4" component="div" sx={{ color: tone ? `${tone}.main` : 'text.primary', lineHeight: 1.2 }}>
        {value}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
          {hint}
        </Typography>
      )}
    </CardContent>
  );
  return (
    <Card sx={{ height: '100%', borderColor: tone && tone !== 'success' ? `${tone}.main` : undefined }}>
      {to ? (
        <CardActionArea component={RouterLink} to={to} sx={{ height: '100%' }}>
          {body}
        </CardActionArea>
      ) : onClick ? (
        <CardActionArea onClick={onClick} sx={{ height: '100%' }}>
          {body}
        </CardActionArea>
      ) : (
        body
      )}
    </Card>
  );
}

// The pipeline a real submission moves through, in order (the inbox's Submissions tab).
const PIPELINE: SubmissionStatus[] = ['NEW', 'PROCESSING', 'READY_FOR_REVIEW', 'IN_REVIEW', 'COMPLETED', 'ERROR'];

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

/** One card for all submissions: how the inbox splits, where real submissions are in the pipeline, and what needs a person. */
export function SubmissionsOverview({
  byStatus,
  byClassification,
  period,
}: {
  byStatus: Record<string, number>;
  byClassification: Record<string, number>;
  period: string;
}) {
  const count = (s: string) => byStatus?.[s] ?? 0;
  const total = Object.values(byStatus ?? {}).reduce((n, v) => n + v, 0);
  const ignored = count('NOT_SUBMISSION');
  const duplicates = count('DUPLICATE');
  const real = total - ignored - duplicates;
  const reviewRequired = byClassification?.REVIEW_REQUIRED ?? 0;
  const split = [
    { label: 'Submissions', n: real, to: '/?view=submissions', color: 'primary.main' },
    { label: 'Ignored', n: ignored, to: '/?view=ignored', color: 'grey.400' },
    { label: 'Duplicates', n: duplicates, to: '/?view=duplicates', color: 'warning.light' },
  ];
  const attention = [
    {
      label: 'Ready for review',
      hint: 'Processed, waiting for an underwriter',
      n: count('READY_FOR_REVIEW'),
      to: '/?view=submissions&status=READY_FOR_REVIEW',
    },
    {
      label: 'Review required',
      hint: 'The classifier was not sure these are submissions',
      n: reviewRequired,
      to: '/?view=submissions&classification=REVIEW_REQUIRED',
    },
  ];

  return (
    <SectionCard
      title="Submissions"
      subtitle={`${total} email${total === 1 ? '' : 's'} received · ${period} · click a number to open the list (all dates)`}
    >
      {total === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No emails in this period.
        </Typography>
      ) : (
        <Grid container spacing={3}>
          <Grid item xs={12} md={4}>
            <Typography variant="overline" color="text.secondary">
              Inbox
            </Typography>
            <Box
              sx={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', bgcolor: 'action.hover', my: 1 }}
            >
              {split
                .filter((x) => x.n > 0)
                .map((x) => (
                  <Tooltip key={x.label} title={`${x.label}: ${x.n} (${pct(x.n, total)}%)`}>
                    <Box sx={{ width: `${pct(x.n, total)}%`, minWidth: 6, bgcolor: x.color }} />
                  </Tooltip>
                ))}
            </Box>
            <Stack spacing={0.5}>
              {split.map((x) => (
                <Stack key={x.label} direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: x.color, flexShrink: 0 }} />
                  <MuiLink
                    component={RouterLink}
                    to={x.to}
                    underline="hover"
                    color="text.primary"
                    variant="body2"
                    sx={{ flexGrow: 1 }}
                  >
                    {x.label}
                  </MuiLink>
                  <Typography variant="body2" fontWeight={600}>
                    {x.n}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ width: 36, textAlign: 'right' }}>
                    {pct(x.n, total)}%
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Grid>

          <Grid item xs={12} md={5}>
            <Typography variant="overline" color="text.secondary">
              Pipeline ({real} submission{real === 1 ? '' : 's'})
            </Typography>
            <Grid container spacing={1} sx={{ mt: 0.25 }}>
              {PIPELINE.map((st) => {
                const n = count(st);
                const isError = st === 'ERROR' && n > 0;
                return (
                  <Grid item xs={4} key={st}>
                    <Paper
                      component={RouterLink}
                      to={`/?view=submissions&status=${st}`}
                      variant="outlined"
                      sx={{
                        display: 'block',
                        p: 1,
                        textDecoration: 'none',
                        color: 'inherit',
                        borderColor: isError ? 'error.main' : undefined,
                        opacity: n ? 1 : 0.6,
                        '&:hover': { borderColor: 'primary.main' },
                      }}
                    >
                      <Typography variant="h6" lineHeight={1.2} color={isError ? 'error.main' : 'text.primary'}>
                        {n}
                      </Typography>
                      <EnumChip value={st} color={submissionStatusColor(st)} />
                    </Paper>
                  </Grid>
                );
              })}
            </Grid>
          </Grid>

          <Grid item xs={12} md={3}>
            <Typography variant="overline" color="text.secondary">
              Needs a person
            </Typography>
            <Stack spacing={1} sx={{ mt: 0.25 }}>
              {attention.map((a) => (
                <Paper
                  key={a.label}
                  component={RouterLink}
                  to={a.to}
                  variant="outlined"
                  sx={{
                    display: 'block',
                    p: 1,
                    textDecoration: 'none',
                    color: 'inherit',
                    borderColor: a.n ? 'warning.main' : undefined,
                    '&:hover': { borderColor: 'primary.main' },
                  }}
                >
                  <Stack direction="row" alignItems="baseline" spacing={1}>
                    <Typography variant="h6" lineHeight={1.2} color={a.n ? 'warning.dark' : 'text.secondary'}>
                      {a.n}
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {a.label}
                    </Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {a.hint}
                  </Typography>
                </Paper>
              ))}
            </Stack>
          </Grid>
        </Grid>
      )}
    </SectionCard>
  );
}
