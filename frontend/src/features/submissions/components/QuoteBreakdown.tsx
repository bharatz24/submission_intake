import {
  Alert,
  Box,
  Chip,
  Grid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';

import { formatDate } from '../../../lib/status';
import type { QuoteFactors, QuotePricing, QuoteStatus } from '../../../types';

export const money = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : n.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

export const limitLabel = (l: { incidentLimit: number; aggregateLimit: number }) => {
  const short = (n: number) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}K`);
  return `${short(l.incidentLimit)} / ${short(l.aggregateLimit)}`;
};

const firstLine = (t: string) => t.split(/\n|\.\s/)[0];

function KvTable({ rows, numeric }: { rows: [ReactNode, ReactNode][]; numeric?: boolean }) {
  return (
    <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Table size="small">
        <TableBody>
          {rows.map(([k, v], i) => (
            <TableRow key={i}>
              <TableCell sx={{ color: 'text.secondary', width: '44%', verticalAlign: 'top' }}>{k}</TableCell>
              <TableCell align={numeric ? 'right' : 'left'} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {v}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** Factors and pricing of one rating: shared by the dialog's preview and saved quotes. */
export function QuoteBreakdown({
  status,
  total,
  premium,
  factors: f,
  pricing: p,
  flags,
  missing,
}: {
  status: QuoteStatus;
  total: number | null;
  premium: number | null;
  factors: QuoteFactors;
  pricing: QuotePricing | null;
  flags: string[];
  missing: string[];
}) {
  const loc = f.location;
  const rows: [ReactNode, ReactNode][] = [
    [
      'Location',
      loc ? (
        <>
          {[loc.city, loc.state, loc.zip].filter(Boolean).join(', ') || '—'} · county <b>{loc.county || '?'}</b>
          {loc.countySource && (
            <Typography component="span" variant="caption" color="text.secondary">
              {' '}
              ({loc.countySource})
            </Typography>
          )}
        </>
      ) : (
        '—'
      ),
    ],
    ['State / base rate', f.state ? `${f.state.state} · ${money(f.state.baseRate)} · defense ${f.state.defense}` : '—'],
    [
      'Dates',
      f.dates
        ? `${formatDate(f.dates.effectiveDate)} → ${formatDate(f.dates.expirationDate)} · retro ${formatDate(f.dates.retroDate)} (year ${f.dates.retroYears})`
        : '—',
    ],
    [
      'Specialty factor',
      f.speciality !== undefined ? (
        <>
          <b>{f.speciality}</b>
          {(f.specialities ?? []).map((x, i) => (
            <Box key={i} sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
              {x.manual ? (
                <>
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label="Manual factor"
                    sx={{ height: 18, mr: 0.5 }}
                  />
                  {x.requested}
                </>
              ) : (
                <>
                  {x.code} {firstLine(x.title)}
                </>
              )}{' '}
              · {x.surgeryType} · class {x.specialityClass} × {x.practicePercent}%
              <Box sx={{ fontSize: '0.7rem' }}>
                “{x.requested}”: {x.manual ? `no rate class matched; reason: ${x.manual.reason}` : x.matchedFrom}
              </Box>
            </Box>
          ))}
        </>
      ) : (
        '—'
      ),
    ],
    ['Step-up', f.stepUp ?? '—'],
    [
      'Territory',
      f.territory ? (
        <>
          <b>{f.territory.factor}</b> · territory {f.territory.territory} · {f.territory.county || 'county unknown'} (
          {f.territory.matched})
        </>
      ) : (
        '—'
      ),
    ],
    [
      'Limits (ILF/DLF)',
      f.limits ? (
        <>
          <b>{f.limits.factor}</b> · {limitLabel(f.limits)}
        </>
      ) : (
        '—'
      ),
    ],
    [
      'Hours worked',
      f.fte ? (
        <>
          <b>{f.fte.factor}</b> · {f.fte.title}
        </>
      ) : (
        '—'
      ),
    ],
  ];
  const priceRows: [ReactNode, ReactNode][] = p
    ? [
        ['Base modifier total', Number(p.baseModifierTotal).toFixed(6)],
        ['Scheduled premium', money(p.scheduledPremium)],
        ...p.scheduled.map((c) => [`${c.title} (${c.percent}%)`, money(c.amount)] as [string, string]),
        ...(p.uwCredit.percent
          ? [[`UW credit/debit (${p.uwCredit.percent}%)`, money(p.uwCredit.amount)] as [string, string]]
          : []),
        [<b key="p">Premium</b>, <b key="pv">{money(p.premium)}</b>],
        ...p.ratingFees.map((x) => [x.title, money(x.amount)] as [string, string]),
        ...p.taxes.map((t) => [t.label, money(t.amount)] as [string, string]),
        ...(f.policyFees ?? []).map((x) => [`${x.title} (policy fee)`, money(x.amount)] as [string, string]),
        [<b key="t">Total</b>, <b key="tv">{money(p.total)}</b>],
      ]
    : [];

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip size="small" color={status === 'QUOTED' ? 'success' : 'warning'} label={status} />
        <Typography variant="h5">{money(total)}</Typography>
        {premium !== null && (
          <Typography variant="caption" color="text.secondary">
            premium {money(premium)}
          </Typography>
        )}
      </Stack>
      {missing.length > 0 && (
        <Alert severity="error" variant="outlined">
          <b>Cannot price until supplied:</b>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </Box>
        </Alert>
      )}
      {flags.length > 0 && (
        <Alert severity="warning" variant="outlined">
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {flags.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </Box>
        </Alert>
      )}
      {/* Box: Stack's child margin would cancel the Grid's negative margin. */}
      <Box>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <KvTable rows={rows} />
          </Grid>
          {priceRows.length > 0 && (
            <Grid item xs={12} md={6}>
              <KvTable rows={priceRows} numeric />
            </Grid>
          )}
        </Grid>
      </Box>
    </Stack>
  );
}
