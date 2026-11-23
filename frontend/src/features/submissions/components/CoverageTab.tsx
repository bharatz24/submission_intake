import WarningIcon from '@mui/icons-material/WarningAmberOutlined';
import { Alert, Box, Chip, Grid, Stack, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { EmptyState, KeyValue, SectionCard } from '../../../components/common';
import { formatPercent, nameTypeLabel } from '../../../lib/status';
import type { CoverageValue, SubmissionDetail } from '../../../types';
import { QuotesCard } from './QuotesCard';

const money = (n: number | null | undefined) =>
  n === null || n === undefined
    ? null
    : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** A value with its source/confidence on hover and a warning when sources disagree. */
function Val({ v, children }: { v: CoverageValue | null | undefined; children?: ReactNode }) {
  if (!v) return null;
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" component="span">
      <Tooltip
        title={
          <>
            Source: {v.sourceLabel} · confidence {formatPercent(v.confidence)}
            {v.evidenceQuote && (
              <>
                <br />“{v.evidenceQuote}”
              </>
            )}
          </>
        }
      >
        <span>{children ?? v.value}</span>
      </Tooltip>
      {v.conflicts.length > 0 && (
        <Tooltip title={`Other sources say: ${v.conflicts.join(' | ')}`}>
          <WarningIcon fontSize="inherit" color="warning" />
        </Tooltip>
      )}
    </Stack>
  );
}

function ListTable({ items, empty }: { items: CoverageValue[]; empty: string }) {
  if (!items.length)
    return (
      <Typography variant="body2" color="text.secondary">
        {empty}
      </Typography>
    );
  return (
    <Stack spacing={0.75}>
      {items.map((it, i) => (
        <Box key={i} sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Typography variant="body2">
            <Val v={it} />
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {it.sourceLabel} · {formatPercent(it.confidence)}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

export function CoverageTab({ s }: { s: SubmissionDetail }) {
  const c = s.coverage;
  if (!s.extractedFields.length) {
    return (
      <Stack spacing={2}>
        <SectionCard title="Coverage & rating">
          <EmptyState
            title="No extracted information yet"
            description="Fields appear here after document extraction runs (requires a Claude API key in Settings)."
          />
        </SectionCard>
        <QuotesCard submissionId={s.id} held={s.heldForClassification || s.heldForImport} />
      </Stack>
    );
  }
  const v = c.values;
  const d = c.derived;
  const limits = (l: { perClaim: number | null; aggregate: number | null }) =>
    l.perClaim === null ? null : `${money(l.perClaim)}${l.aggregate !== null ? ` / ${money(l.aggregate)}` : ''}`;

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={6}>
        <SectionCard title="Applicant & contact">
          <Grid container spacing={1.5}>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Applicant" value={v.applicant_name && <Val v={v.applicant_name} />} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Practice / entity" value={v.practice_name && <Val v={v.practice_name} />} />
            </Grid>
            {s.applicantType && (
              <>
                <Grid item xs={12} sm={6}>
                  <KeyValue label="Applicant type" value={nameTypeLabel(s.applicantType)} />
                </Grid>
                {s.applicantType === 'ORGANIZATION' ? (
                  <Grid item xs={12} sm={6}>
                    <KeyValue label="Entity name" value={s.applicantEntityName} />
                  </Grid>
                ) : (
                  <>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="First name" value={s.applicantFirstName} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <KeyValue label="Last name" value={s.applicantLastName} />
                    </Grid>
                  </>
                )}
              </>
            )}
            <Grid item xs={12} sm={6}>
              <KeyValue label="NPI" value={v.npi && <Val v={v.npi} />} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Contact" value={v.contact_name && <Val v={v.contact_name} />} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Email" value={v.contact_email && <Val v={v.contact_email} />} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Phone" value={v.contact_phone && <Val v={v.contact_phone} />} />
            </Grid>
            <Grid item xs={12}>
              <KeyValue label="Mailing address" value={v.mailing_address && <Val v={v.mailing_address} />} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Years in practice" value={v.years_in_practice && <Val v={v.years_in_practice} />} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue
                label="Board certification"
                value={v.board_certification && <Val v={v.board_certification} />}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Broker" value={v.broker_name && <Val v={v.broker_name} />} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <KeyValue label="Broker email" value={v.broker_email && <Val v={v.broker_email} />} />
            </Grid>
          </Grid>
        </SectionCard>
      </Grid>

      <Grid item xs={12} lg={6}>
        <SectionCard title="Locations & specialties">
          <Grid container spacing={1.5} sx={{ mb: 2 }}>
            <Grid item xs={4}>
              <KeyValue label="ZIP" value={v.practice_zip && <Val v={v.practice_zip} />} />
            </Grid>
            <Grid item xs={4}>
              <KeyValue label="County" value={v.practice_county && <Val v={v.practice_county} />} />
            </Grid>
            <Grid item xs={4}>
              <KeyValue label="State" value={v.practice_state && <Val v={v.practice_state} />} />
            </Grid>
          </Grid>
          <Typography variant="overline">Practice locations</Typography>
          <ListTable items={c.lists.practice_location ?? []} empty="No locations extracted." />
          <Typography variant="overline" sx={{ display: 'block', mt: 2 }}>
            Specialties
          </Typography>
          {(c.lists.specialty ?? []).length ? (
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              {c.lists.specialty!.map((sp, i) => (
                <Tooltip key={i} title={`${sp.sourceLabel} · ${formatPercent(sp.confidence)}`}>
                  <Chip label={sp.value} />
                </Tooltip>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No specialties extracted.
            </Typography>
          )}
          {v.surgery_type && (
            <Box sx={{ mt: 1.5 }}>
              <KeyValue label="Surgery type" value={<Val v={v.surgery_type} />} />
            </Box>
          )}
          {(c.lists.procedures ?? []).length > 0 && (
            <>
              <Typography variant="overline" sx={{ display: 'block', mt: 2 }}>
                Procedures
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {c.lists.procedures!.map((p, i) => (
                  <Chip key={i} size="small" variant="outlined" label={p.value} />
                ))}
              </Stack>
            </>
          )}
        </SectionCard>
      </Grid>

      <Grid item xs={12}>
        <SectionCard title="Coverage terms">
          <Grid container spacing={1.5}>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Coverage type" value={v.coverage_type && <Val v={v.coverage_type} />} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Effective" value={v.effective_date && <Val v={v.effective_date} />} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Expiration" value={v.expiration_date && <Val v={v.expiration_date} />} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Policy term" value={d.policyTermDays !== null ? `${d.policyTermDays} days` : null} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Retro date" value={v.retroactive_date && <Val v={v.retroactive_date} />} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue
                label="Claims-made year"
                value={
                  d.claimsMadeStep && (
                    <Tooltip title="Full years from retro date to effective date, plus 1. Year 5+ is mature.">
                      <Chip size="small" color={d.claimsMadeYear! >= 5 ? 'success' : 'info'} label={d.claimsMadeStep} />
                    </Tooltip>
                  )
                }
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue
                label="Coverage limits"
                value={
                  v.requested_limits && <Val v={v.requested_limits}>{limits(d.limits) ?? v.requested_limits.value}</Val>
                }
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue
                label="Retro limits"
                value={v.retro_limit && <Val v={v.retro_limit}>{limits(d.retroLimits) ?? v.retro_limit.value}</Val>}
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Defense costs" value={v.defense_costs && <Val v={v.defense_costs} />} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue
                label="Deductible"
                value={v.deductible && <Val v={v.deductible}>{money(d.deductibleAmount) ?? v.deductible.value}</Val>}
              />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Prior carrier" value={v.prior_carrier && <Val v={v.prior_carrier} />} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <KeyValue label="Expiring premium" value={v.expiring_premium && <Val v={v.expiring_premium} />} />
            </Grid>
          </Grid>
        </SectionCard>
      </Grid>

      <Grid item xs={12}>
        <QuotesCard submissionId={s.id} held={s.heldForClassification || s.heldForImport} />
      </Grid>

      <Grid item xs={12}>
        <SectionCard
          title="Loss history"
          subtitle={v.claims_count_5yr ? undefined : 'Claims count not stated'}
          actions={
            v.claims_count_5yr && (
              <Chip
                size="small"
                color={Number(v.claims_count_5yr.value) > 0 ? 'warning' : 'success'}
                label={`Claims (5 yr): ${v.claims_count_5yr.value}`}
              />
            )
          }
        >
          <ListTable items={c.lists.claims_detail ?? []} empty="No individual claims described." />
          {v.disciplinary_actions && (
            <Alert severity="warning" variant="outlined" sx={{ mt: 1.5 }}>
              Disciplinary actions: <Val v={v.disciplinary_actions} />
            </Alert>
          )}
        </SectionCard>
      </Grid>
    </Grid>
  );
}
