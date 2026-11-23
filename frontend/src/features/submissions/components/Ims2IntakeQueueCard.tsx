import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  Grid,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, fillCell, KeyValue, Loading, SectionCard, UsDateField } from '../../../components/common';
import { POLL_MS, STALE_MS } from '../../../constants';
import { friendlyMessage } from '../../../lib/friendlyError';
import { safeWebUrl } from '../../../lib/safeUrl';
import { formatDateTime, humanize } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type {
  Ims2FieldSource,
  Ims2LookupQuery,
  Ims2Policy,
  Ims2QueueBrokerHit,
  Ims2QueueContact,
  Ims2QueueDefaults,
  Ims2QueueForm,
  Ims2QueueInfo,
  Ims2QueueLocation,
  Ims2QueueNewInsured,
  Ims2QueuePolicy,
  Ims2QueueRow,
  Ims2QueueState,
} from '../../../types';
import { ims2Keys, quoteKeys, submissionKeys } from '../queryKeys';
import { QuoteBreakdown } from './QuoteBreakdown';

/**
 * Hand-off of an accepted submission to IMS 2's Submission Intake queue. The reviewer confirms the prefilled intake and
 * sends it; an IMS 2 user creates the submission from it and links it, or rejects it with a reason. The broker may go
 * by name only and every location / contact field is optional: whatever is missing, the IMS 2 user completes. A
 * rejected intake is fixed here and sent again; a linked one is final and edited in IMS 2.
 */

const BLANK_LOCATION: Ims2QueueLocation = { address1: null, address2: null, city: null, state: null, zipcode: null };
const BLANK_CONTACT: Ims2QueueContact = { name: null, email: null, phone: null };

const SOURCE_COLOR: Record<Ims2FieldSource, 'info' | 'warning' | 'default'> = {
  extracted: 'info',
  edited: 'warning',
  manual: 'default',
};
const SOURCE_TEXT: Record<Ims2FieldSource, string> = {
  extracted: 'Filled in automatically',
  edited: 'Changed by you',
  manual: 'Entered by you',
};
const MATCH_LABEL: Record<string, string> = {
  npi: 'NPI',
  email: 'Email',
  licenseNumber: 'License',
  name: 'Name',
  brokerCode: 'Broker code',
  brokerName: 'Name',
};
const SUGGESTION_LABEL: Record<string, string> = {
  premium: 'Premium',
  total: 'Total',
  rateGroup: 'Rate group',
  quoteVersion: 'Quote version',
  basis: 'Basis',
  coverageLimit: 'Coverage limit',
  deductible: 'Deductible',
  classCode: 'Class code',
  retroDate: 'Retro date',
};
const MONEY_KEYS = new Set(['premium', 'total']);
const money = (v: unknown) =>
  typeof v === 'number'
    ? v.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : String(v);
const keyLabel = (k: string) =>
  SUGGESTION_LABEL[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const brokerTitle = (b: Ims2QueueBrokerHit) =>
  `${b.brokerName}${b.shortName && b.shortName !== b.brokerName ? ` (${b.shortName})` : ''}`;
const exact = (matchedOn: string[]) => matchedOn.some((m) => m !== 'name' && m !== 'brokerName');
// Inactive insureds are not offered; one IMS 2 sent without a status is (nothing says it is inactive).
const linkable = (c: { status: string | null }) => !c.status || c.status === 'active';

export const STATE_CHIP: Record<
  Ims2QueueState,
  { label: string; color: 'default' | 'info' | 'success' | 'warning' | 'error' }
> = {
  SENDING: { label: 'Sending', color: 'default' },
  QUEUED: { label: 'Queued in IMS 2', color: 'info' },
  LINKED: { label: 'Linked', color: 'success' },
  REJECTED: { label: 'Rejected', color: 'warning' },
  ERROR: { label: 'Refused', color: 'error' },
  FAILED: { label: 'Not delivered', color: 'warning' },
};

export function Ims2IntakeQueueCard({ submissionId }: { submissionId: string }) {
  const { user } = useAuth();
  const state = useQuery({
    queryKey: ims2Keys.submission(submissionId),
    queryFn: ({ signal }) => apiWith(signal).ims2Queue(submissionId),
  });
  const row = state.data?.row ?? null;

  let body: ReactNode;
  if (state.isLoading) body = <Loading label="Loading IMS 2 status…" minHeight={80} />;
  else if (state.isError) body = <ErrorState error={state.error} onRetry={() => state.refetch()} />;
  else if (!state.data!.configured) {
    body = (
      <Alert severity="info">
        The IMS 2 intake queue is not configured. An administrator sets its URL and token in Settings → IMS 2 intake.
      </Alert>
    );
  } else if (row?.state === 'LINKED') body = <Linked submissionId={submissionId} row={row} />;
  else if (!hasPermission(user, 'submission:write')) {
    body = row ? (
      <Stack direction="row" spacing={1} alignItems="center">
        <Chip label={STATE_CHIP[row.state].label} color={STATE_CHIP[row.state].color} />
        <Typography variant="body2" color="text.secondary">
          Read-only access.
        </Typography>
      </Stack>
    ) : (
      <Typography variant="body2" color="text.secondary">
        Read-only access: sending to IMS 2 requires the Underwriter role.
      </Typography>
    );
  } else body = <QueueForm submissionId={submissionId} info={state.data!} defaults={state.data!.defaults!} />;
  return (
    <SectionCard
      title="Send to IMS 2"
      subtitle="Check the details below and send. An IMS 2 user creates the submission from it."
      actions={
        row ? <Chip size="small" label={STATE_CHIP[row.state].label} color={STATE_CHIP[row.state].color} /> : undefined
      }
    >
      {body}
    </SectionCard>
  );
}

/**
 * Reads the intake's status and keeps the answer in the card's query. Those who may write ask IMS 2 for it (POST
 * …/status/refresh, which stores what IMS 2 says); everyone else reads the last state stored (GET …/status).
 */
function useRemoteStatus(submissionId: string, row: Ims2QueueRow | null, pollMs: number | false) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canRefresh = hasPermission(user, 'submission:write');
  return useQuery({
    queryKey: ims2Keys.status(submissionId),
    queryFn: async () => {
      const r = canRefresh ? await api.ims2QueueRefreshStatus(submissionId) : await api.ims2QueueStatus(submissionId);
      qc.setQueryData(ims2Keys.submission(submissionId), (old: Ims2QueueInfo | undefined) =>
        old ? { ...old, row: r } : old,
      );
      if (r.state !== row?.state) qc.invalidateQueries({ queryKey: ims2Keys.submission(submissionId) });
      return r;
    },
    enabled: !!row && row.state !== 'SENDING',
    refetchInterval: pollMs,
    refetchOnWindowFocus: false,
  });
}

// ---- Linked -------------------------------------------------------------------------------------------------------

function Linked({ submissionId, row }: { submissionId: string; row: Ims2QueueRow }) {
  const status = useRemoteStatus(submissionId, row, false);
  const live = status.data ?? row;
  const remote = live.remoteStatus;
  // The link comes from IMS 2's API: only an http(s) address becomes an href (FE-06).
  const imsUrl = safeWebUrl(live.imsUrl);
  return (
    <Stack spacing={1.5}>
      <Alert severity="success">
        IMS 2 created this submission from the intake{live.imsSubmissionNumber ? ` as ${live.imsSubmissionNumber}` : ''}
        . Further edits happen in IMS 2.
      </Alert>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {imsUrl && (
          <Button
            variant="contained"
            href={imsUrl}
            target="_blank"
            rel="noopener noreferrer"
            endIcon={<OpenInNewIcon />}
          >
            Open in IMS 2
          </Button>
        )}
        <Button onClick={() => status.refetch()} disabled={status.isFetching}>
          {status.isFetching ? 'Checking…' : 'Refresh status'}
        </Button>
        {remote?.workflowStatus && <Chip label={humanize(remote.workflowStatus)} />}
      </Stack>
      {status.isError && <Alert severity="warning">{errorMessage(status.error)}</Alert>}
      <Grid container spacing={1}>
        <Grid item xs={6} md={4}>
          <KeyValue label="IMS 2 submission" value={live.imsSubmissionNumber ?? live.imsSubmissionId ?? '—'} />
        </Grid>
        <Grid item xs={6} md={4}>
          <KeyValue label="Policy number" value={remote?.policyNumber ?? 'Assigned at bind'} />
        </Grid>
        <Grid item xs={6} md={4}>
          <KeyValue label="Insured" value={live.imsInsuredId ?? '—'} />
        </Grid>
        <Grid item xs={6} md={4}>
          <KeyValue label="Intake" value={`${live.intakeId} · v${live.version}`} />
        </Grid>
        <Grid item xs={6} md={4}>
          <KeyValue label="Sent by" value={`${live.sentBy.name} · ${formatDateTime(live.sentAt)}`} />
        </Grid>
        <Grid item xs={6} md={4}>
          <KeyValue label="Status checked" value={live.remoteCheckedAt ? formatDateTime(live.remoteCheckedAt) : '—'} />
        </Grid>
      </Grid>
    </Stack>
  );
}

// ---- Form ---------------------------------------------------------------------------------------------------------

function QueueForm({
  submissionId,
  info,
  defaults,
}: {
  submissionId: string;
  info: Ims2QueueInfo;
  defaults: Ims2QueueDefaults;
}) {
  const qc = useQueryClient();
  // A resend starts from what was sent last, so the reviewer fixes the rejected or refused intake instead of retyping it.
  const [form, setForm] = useState<Ims2QueueForm>(() => structuredClone(info.row?.form ?? defaults.form));
  // The new-insured details survive switching to an existing insured and back.
  const [newInsured, setNewInsured] = useState(() =>
    structuredClone(info.row?.form?.insured.mode === 'create' ? info.row.form.insured : defaults.form.insured),
  );
  const [query, setQuery] = useState<Ims2LookupQuery>(defaults.lookup);
  const [searched, setSearched] = useState<Ims2LookupQuery | null>(null);

  const lookup = useQuery({
    queryKey: ims2Keys.lookup(submissionId, searched),
    queryFn: ({ signal }) => apiWith(signal).ims2QueueLookup(submissionId, searched ?? undefined),
    staleTime: STALE_MS.ims2Lookup,
  });
  // Inactive candidates cannot be chosen, so they are not listed.
  const brokers = (lookup.data?.brokers ?? []).filter((b) => b.active);
  const insureds = (lookup.data?.insureds ?? []).filter(linkable);

  // A single active exact-identifier insured is linked by default; a broker is preselected when it is the only active one.
  useEffect(() => {
    const insureds = (lookup.data?.insureds ?? []).filter((c) => linkable(c) && exact(c.matchedOn));
    const [onlyInsured] = insureds;
    if (insureds.length === 1 && onlyInsured && form.insured.mode === 'create')
      setForm((f) => ({ ...f, insured: { mode: 'link', insuredId: onlyInsured.insuredId } }));
    const active = (lookup.data?.brokers ?? []).filter((b) => b.active);
    const [onlyBroker] = active;
    if (active.length === 1 && onlyBroker && form.broker.brokerId === null) chooseBroker(onlyBroker);
    // Preselects once per lookup answer: the form is read, not watched, so a reviewer who changes the insured or
    // clears the broker is not overridden on the next keystroke. chooseBroker only calls the stable setForm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup.data]);

  const chooseBroker = (b: Ims2QueueBrokerHit | null) =>
    setForm((f) => ({
      ...f,
      broker: b ? { brokerId: b.id, brokerName: b.brokerName } : { ...f.broker, brokerId: null },
    }));

  // The quote the suggested terms come from (intakeDraft.ts: the primary QUOTED rating), shown in full.
  const quotes = useQuery({
    queryKey: quoteKeys.list(submissionId),
    queryFn: ({ signal }) => apiWith(signal).quotes(submissionId),
  });
  const primaryQuote = (quotes.data ?? []).find((q) => q.isPrimary && q.status === 'QUOTED') ?? null;

  const row = info.row;
  const status = useRemoteStatus(submissionId, row, row?.state === 'QUEUED' ? POLL_MS.ims2Queued : false);
  const send = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.ims2QueueSend(submissionId, form),
    onSuccess: (r) => {
      qc.setQueryData(ims2Keys.submission(submissionId), (old: Ims2QueueInfo | undefined) =>
        old ? { ...old, row: r } : old,
      );
      qc.invalidateQueries({ queryKey: ims2Keys.submission(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.versions(submissionId) });
    },
  });
  const result = send.data ?? status.data ?? row;
  const failedField = result && result.state === 'ERROR' ? result.lastErrorField : null;
  const fieldError = (path: string) => (failedField === path ? result!.lastError : null);

  const setPolicy = <K extends keyof Ims2QueuePolicy>(k: K, v: Ims2QueuePolicy[K]) =>
    setForm((f) => ({ ...f, policy: { ...f.policy, [k]: v } }));
  const create = form.insured.mode === 'create' ? form.insured : null;
  const setNew = (k: keyof Ims2QueueNewInsured, v: string) => {
    const next = {
      ...newInsured,
      create: { ...newInsured.create, [k]: k === 'canonicalName' ? v : v || null } as Ims2QueueNewInsured,
    };
    setNewInsured(next);
    setForm((f) => ({ ...f, insured: next }));
  };

  const missing = [
    !form.broker.brokerName.trim() && 'broker name',
    create && !create.create.canonicalName.trim() && 'insured name',
    !form.policy.effectiveDate && 'effective date',
    !form.policy.businessType && 'business type',
    !form.policy.recordType && 'record type',
  ].filter(Boolean) as string[];

  const policyField = (k: keyof Ims2QueuePolicy, label: string, props: Record<string, unknown> = {}) => {
    const src = defaults.sources[k as keyof Ims2Policy];
    const value = form.policy[k];
    const prefill = defaults.form.policy[k];
    const edited = src && String(prefill ?? '') !== String(value ?? '');
    const tag: Ims2FieldSource | null =
      value === null || value === '' || k === 'recordType'
        ? null
        : !src
          ? 'manual'
          : edited
            ? src.source === 'manual'
              ? 'manual'
              : 'edited'
            : src.source;
    const err = fieldError(`policy.${k}`);
    const fullLabel = (
      <>
        {label}
        {tag && <SourceTag source={tag} from={!edited ? src?.from : undefined} />}
      </>
    );
    if (props.type === 'date') {
      return (
        <UsDateField
          label={fullLabel}
          fullWidth
          size="small"
          required={!!props.required}
          value={value as string | null}
          error={!!err}
          helperText={err}
          onChange={(iso) => setPolicy(k, iso as never)}
        />
      );
    }
    return (
      <TextField
        label={fullLabel}
        fullWidth
        size="small"
        value={value ?? ''}
        error={!!err}
        helperText={err}
        onChange={(e) =>
          setPolicy(
            k,
            (k === 'premium'
              ? e.target.value === ''
                ? null
                : Number(e.target.value)
              : e.target.value || null) as never,
          )
        }
        {...props}
      />
    );
  };

  const blockedByLegacy = info.legacyHandoff?.state === 'ACCEPTED';
  const sendLabel = !row
    ? 'Send to IMS 2 Intake'
    : row.state === 'REJECTED'
      ? 'Resend to IMS 2'
      : row.state === 'QUEUED'
        ? 'Update in IMS 2'
        : 'Send again';

  return (
    <Stack spacing={1.5}>
      {!info.canSend && (
        <Alert severity="warning">
          {info.latestDecision ? (
            <>
              The current decision is <strong>{humanize(info.latestDecision)}</strong>. Save an <strong>Accept</strong>{' '}
              (or Accept with conditions) decision above to send this to IMS 2.
            </>
          ) : (
            <>
              Save an <strong>Accept</strong> (or Accept with conditions) decision above to send this to IMS 2.
            </>
          )}
        </Alert>
      )}
      {blockedByLegacy && (
        <Alert severity="info">
          IMS 2 already created this submission through the direct hand-off
          {info.legacyHandoff?.imsSubmissionNumber ? ` (${info.legacyHandoff.imsSubmissionNumber})` : ''}.
        </Alert>
      )}
      {result?.state === 'QUEUED' && (
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" onClick={() => status.refetch()} disabled={status.isFetching}>
              {status.isFetching ? 'Checking…' : 'Refresh status'}
            </Button>
          }
        >
          Waiting for an IMS 2 user (sent {formatDateTime(result.sentAt)} by {result.sentBy.name}). Sending again
          updates it there.
        </Alert>
      )}
      {result?.state === 'REJECTED' && (
        <Alert severity="warning">
          IMS 2 sent this back
          {result.rejectedReason ? (
            <>
              : <strong>{result.rejectedReason}</strong>
            </>
          ) : (
            ''
          )}
          . Fix it below and resend.
        </Alert>
      )}
      {(result?.state === 'ERROR' || result?.state === 'FAILED') && result.lastError && (
        <Alert severity={result.state === 'FAILED' ? 'warning' : 'error'}>
          {result.state === 'FAILED' ? 'IMS 2 did not take the intake' : 'IMS 2 refused the intake'}
          {result.lastHttpStatus ? ` (${result.lastHttpStatus})` : ''}: {friendlyMessage(result.lastError)}
          {result.lastErrorField && ` [${result.lastErrorField}]`}
          {result.state === 'FAILED' && ' Sending again is safe.'}
          {(result.lastHttpStatus === 401 || result.lastHttpStatus === 503) &&
            ' This is a configuration problem: ask an administrator to check the IMS 2 intake token.'}
        </Alert>
      )}
      {status.isError && <Alert severity="warning">{errorMessage(status.error)}</Alert>}
      {send.isError && <Alert severity="error">{errorMessage(send.error)}</Alert>}

      {/* Lookup: Enter in any field searches. */}
      <Box
        component="form"
        onSubmit={(e) => {
          e.preventDefault();
          setSearched({ ...query });
        }}
      >
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Look up existing records in IMS 2
        </Typography>
        <Grid container spacing={1}>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Insured name"
              size="small"
              fullWidth
              value={query.name ?? ''}
              onChange={(e) => setQuery({ ...query, name: e.target.value })}
            />
          </Grid>
          <Grid item xs={6} sm={2}>
            <TextField
              label="NPI"
              size="small"
              fullWidth
              value={query.npi ?? ''}
              onChange={(e) => setQuery({ ...query, npi: e.target.value })}
            />
          </Grid>
          <Grid item xs={6} sm={2}>
            <TextField
              label="License"
              size="small"
              fullWidth
              value={query.licenseNumber ?? ''}
              onChange={(e) => setQuery({ ...query, licenseNumber: e.target.value })}
            />
          </Grid>
          <Grid item xs={12} sm={3}>
            <TextField
              label="Broker name"
              size="small"
              fullWidth
              value={query.brokerName ?? ''}
              onChange={(e) => setQuery({ ...query, brokerName: e.target.value })}
            />
          </Grid>
          <Grid item xs={12} sm={2} sx={{ display: 'flex' }}>
            <Button type="submit" fullWidth variant="outlined" disabled={lookup.isFetching}>
              {lookup.isFetching ? 'Searching…' : 'Search'}
            </Button>
          </Grid>
        </Grid>
        {lookup.isError && (
          <Alert severity="warning" sx={{ mt: 1 }}>
            {errorMessage(lookup.error)}
          </Alert>
        )}
      </Box>

      {/* Broker, insured, and location + contact side by side so the card stays short. */}
      <Grid container spacing={1.5}>
        <Grid item xs={12} md={4} sx={fillCell}>
          <Panel
            title="Broker"
            count={brokers.length}
            hint={
              brokers.some((b) => !exact(b.matchedOn))
                ? 'Name matches only: confirm the broker before choosing it.'
                : undefined
            }
          >
            <RadioGroup
              value={form.broker.brokerId ?? 'none'}
              onChange={(e) =>
                chooseBroker(
                  e.target.value === 'none' ? null : (brokers.find((b) => b.id === Number(e.target.value)) ?? null),
                )
              }
            >
              <Box sx={{ maxHeight: 168, overflowY: 'auto', mx: -0.5, px: 0.5 }}>
                {brokers.map((b) => (
                  <Option key={b.id} value={b.id} selected={form.broker.brokerId === b.id}>
                    <Candidate title={brokerTitle(b)} detail={b.brokerCode ?? ''} matchedOn={b.matchedOn} />
                  </Option>
                ))}
              </Box>
              <Option value="none" selected={form.broker.brokerId === null}>
                <Typography variant="body2">Not listed: send the name only</Typography>
              </Option>
            </RadioGroup>
            <TextField
              label="Broker name to send"
              size="small"
              fullWidth
              required
              sx={{ mt: 1.5 }}
              value={form.broker.brokerName}
              error={!!fieldError('broker.brokerName') || !!fieldError('broker.brokerId')}
              helperText={
                fieldError('broker.brokerName') ??
                fieldError('broker.brokerId') ??
                (form.broker.brokerId ? 'Matched to an IMS 2 broker' : 'The IMS 2 user picks the broker by this name')
              }
              onChange={(e) => setForm((f) => ({ ...f, broker: { ...f.broker, brokerName: e.target.value } }))}
            />
          </Panel>
        </Grid>
        <Grid item xs={12} md={4} sx={fillCell}>
          <Panel
            title="Insured"
            count={insureds.length}
            hint={
              insureds.some((c) => !exact(c.matchedOn))
                ? 'Name matches only: confirm the insured before choosing it.'
                : undefined
            }
          >
            <RadioGroup
              value={form.insured.mode === 'link' ? form.insured.insuredId : 'create'}
              onChange={(e) =>
                setForm({
                  ...form,
                  insured: e.target.value === 'create' ? newInsured : { mode: 'link', insuredId: e.target.value },
                })
              }
            >
              <Box sx={{ maxHeight: 168, overflowY: 'auto', mx: -0.5, px: 0.5 }}>
                {insureds.map((c) => (
                  <Option
                    key={c.insuredId}
                    value={c.insuredId}
                    selected={form.insured.mode === 'link' && form.insured.insuredId === c.insuredId}
                  >
                    <Candidate
                      title={c.canonicalName}
                      detail={[c.insuredId, c.npi && `NPI ${c.npi}`, !c.status && 'no status']
                        .filter(Boolean)
                        .join(' · ')}
                      matchedOn={c.matchedOn}
                    />
                  </Option>
                ))}
              </Box>
              <Option value="create" selected={!!create}>
                <Typography variant="body2">Not listed: IMS 2 creates a new one</Typography>
              </Option>
            </RadioGroup>
            {fieldError('insured.insuredId') && (
              <Typography variant="caption" color="error">
                {fieldError('insured.insuredId')}
              </Typography>
            )}
            {create && (
              <Grid container spacing={1} sx={{ mt: 1 }}>
                <Grid item xs={4}>
                  <TextField
                    select
                    label="Type"
                    size="small"
                    fullWidth
                    value={create.create.insuredType}
                    onChange={(e) => setNew('insuredType', e.target.value)}
                  >
                    <MenuItem value="person">Person</MenuItem>
                    <MenuItem value="entity">Entity</MenuItem>
                  </TextField>
                </Grid>
                <Grid item xs={8}>
                  <TextField
                    label="Name"
                    size="small"
                    fullWidth
                    required
                    value={create.create.canonicalName}
                    error={!!fieldError('insured.canonicalName')}
                    helperText={fieldError('insured.canonicalName')}
                    onChange={(e) => setNew('canonicalName', e.target.value)}
                  />
                </Grid>
                {create.create.insuredType === 'person' ? (
                  <>
                    <Grid item xs={6}>
                      <TextField
                        label="First name"
                        size="small"
                        fullWidth
                        value={create.create.firstname ?? ''}
                        onChange={(e) => setNew('firstname', e.target.value)}
                      />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField
                        label="Last name"
                        size="small"
                        fullWidth
                        value={create.create.lastname ?? ''}
                        onChange={(e) => setNew('lastname', e.target.value)}
                      />
                    </Grid>
                  </>
                ) : (
                  <Grid item xs={12}>
                    <TextField
                      label="Company name"
                      size="small"
                      fullWidth
                      value={create.create.companyname ?? ''}
                      onChange={(e) => setNew('companyname', e.target.value)}
                    />
                  </Grid>
                )}
                <Grid item xs={6}>
                  <TextField
                    label="NPI"
                    size="small"
                    fullWidth
                    value={create.create.npi ?? ''}
                    error={!!fieldError('insured.npi')}
                    helperText={fieldError('insured.npi')}
                    onChange={(e) => setNew('npi', e.target.value)}
                  />
                </Grid>
                <Grid item xs={6}>
                  <TextField
                    label="License number"
                    size="small"
                    fullWidth
                    value={create.create.licenseNumber ?? ''}
                    onChange={(e) => setNew('licenseNumber', e.target.value)}
                  />
                </Grid>
                <Grid item xs={12}>
                  <TextField
                    label="Email"
                    size="small"
                    fullWidth
                    value={create.create.email ?? ''}
                    onChange={(e) => setNew('email', e.target.value)}
                  />
                </Grid>
              </Grid>
            )}
          </Panel>
        </Grid>
        <Grid item xs={12} md={4}>
          <Stack spacing={1.5}>
            {/* Location and contact go with an existing insured too: they help the IMS 2 user. */}
            <Panel
              title="Practice location"
              toggle={
                <Switch
                  size="small"
                  checked={!!form.location}
                  inputProps={{ 'aria-label': 'Send practice location' }}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      location: e.target.checked ? (defaults.form.location ?? BLANK_LOCATION) : null,
                    }))
                  }
                />
              }
            >
              {form.location && (
                <Grid container spacing={1}>
                  {(['address1', 'address2', 'city', 'state', 'zipcode'] as const).map((k) => {
                    const err = fieldError(`location.${k}`);
                    return (
                      <Grid
                        item
                        key={k}
                        xs={{ address1: 12, address2: 12, city: 12, state: 4, zipcode: 8 }[k]}
                        sm={{ address1: 8, address2: 4, city: 5, state: 3, zipcode: 4 }[k]}
                        md={{ address1: 12, address2: 12, city: 12, state: 4, zipcode: 8 }[k]}
                      >
                        <TextField
                          label={
                            {
                              address1: 'Address',
                              address2: 'Address 2',
                              city: 'City',
                              state: 'State',
                              zipcode: 'ZIP',
                            }[k]
                          }
                          size="small"
                          fullWidth
                          value={form.location![k] ?? ''}
                          error={!!err}
                          helperText={err}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, location: { ...f.location!, [k]: e.target.value || null } }))
                          }
                        />
                      </Grid>
                    );
                  })}
                </Grid>
              )}
            </Panel>
            <Panel
              title="Contact"
              toggle={
                <Switch
                  size="small"
                  checked={!!form.contact}
                  inputProps={{ 'aria-label': 'Send contact' }}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      contact: e.target.checked ? (defaults.form.contact ?? BLANK_CONTACT) : null,
                    }))
                  }
                />
              }
            >
              {form.contact && (
                <Grid container spacing={1}>
                  {(['name', 'email', 'phone'] as const).map((k) => {
                    const err = fieldError(`contact.${k}`);
                    return (
                      <Grid item key={k} xs={12} sm={{ name: 12, email: 7, phone: 5 }[k]}>
                        <TextField
                          label={{ name: 'Name', email: 'Email', phone: 'Phone' }[k]}
                          size="small"
                          fullWidth
                          value={form.contact![k] ?? ''}
                          error={!!err}
                          helperText={err}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, contact: { ...f.contact!, [k]: e.target.value || null } }))
                          }
                        />
                      </Grid>
                    );
                  })}
                </Grid>
              )}
            </Panel>
          </Stack>
        </Grid>
      </Grid>

      <Panel title="Policy">
        <Grid container spacing={1.25} sx={{ pt: 0.5 }}>
          <Grid item xs={12} sm={4} md={3}>
            {policyField('effectiveDate', 'Effective date', {
              type: 'date',
              required: true,
              InputLabelProps: { shrink: true },
            })}
          </Grid>
          <Grid item xs={12} sm={4} md={3}>
            {policyField('expiredDate', 'Expiration date', { type: 'date', InputLabelProps: { shrink: true } })}
          </Grid>
          <Grid item xs={12} sm={4} md={3}>
            {policyField('dateReceived', 'Date received', { type: 'date', InputLabelProps: { shrink: true } })}
          </Grid>
          <Grid item xs={6} sm={4} md={3}>
            {policyField('businessType', 'New or renewal', {
              select: true,
              required: true,
              children: [
                <MenuItem key="new" value="new">
                  New
                </MenuItem>,
                <MenuItem key="renewal" value="renewal">
                  Renewal
                </MenuItem>,
              ],
            })}
          </Grid>
          <Grid item xs={6} sm={4} md={3}>
            {policyField('recordType', 'Record type', {
              select: true,
              required: true,
              children: [
                <MenuItem key="POL" value="POL">
                  POL
                </MenuItem>,
                <MenuItem key="POL-TL" value="POL-TL">
                  POL-TL
                </MenuItem>,
                <MenuItem key="POL-SL" value="POL-SL">
                  POL-SL
                </MenuItem>,
              ],
            })}
          </Grid>
          <Grid item xs={12} sm={4} md={3}>
            {policyField('premium', 'Premium', { type: 'number' })}
          </Grid>
          <Grid item xs={4} sm={2} md={2}>
            {policyField('state', 'State')}
          </Grid>
          <Grid item xs={8} sm={4} md={4}>
            {policyField('city', 'City')}
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            {policyField('specialty', 'Specialty')}
          </Grid>
          <Grid item xs={6} sm={6} md={4}>
            {policyField('agent', 'Agent')}
          </Grid>
          <Grid item xs={6} sm={6} md={4}>
            {policyField('underwriter', 'Underwriter')}
          </Grid>
        </Grid>
      </Panel>

      {(defaults.ratingIndication || defaults.setupProposal) && (
        <Panel
          title={primaryQuote ? `Suggested terms · primary quote v${primaryQuote.version}` : 'Suggested terms'}
          toggle={
            <Typography variant="caption" color="text.secondary">
              For reference only. The IMS 2 user decides whether to use them.
            </Typography>
          }
        >
          {primaryQuote ? (
            <QuoteBreakdown
              status={primaryQuote.status}
              total={primaryQuote.total}
              premium={primaryQuote.premium}
              factors={primaryQuote.factors}
              pricing={primaryQuote.pricing}
              flags={primaryQuote.flags}
              missing={primaryQuote.missing}
            />
          ) : (
            <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxWidth: { md: 640 } }}>
              <Table size="small">
                <TableBody>
                  {/* Money lines (premium, total) are bold and go last, like a receipt. */}
                  {Object.entries({ ...defaults.ratingIndication, ...defaults.setupProposal })
                    .sort(
                      ([a], [b]) =>
                        Number(MONEY_KEYS.has(a)) - Number(MONEY_KEYS.has(b)) ||
                        (a === 'total' ? 1 : b === 'total' ? -1 : 0),
                    )
                    .map(([k, v]) => {
                      const bold = MONEY_KEYS.has(k);
                      return (
                        <TableRow key={k}>
                          <TableCell
                            sx={{ color: bold ? 'text.primary' : 'text.secondary', fontWeight: bold ? 700 : 400 }}
                          >
                            {keyLabel(k)}
                          </TableCell>
                          <TableCell
                            align="right"
                            sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: bold ? 700 : 400 }}
                          >
                            {v === null || v === undefined || v === '' ? '—' : bold ? money(v) : String(v)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Panel>
      )}

      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ pt: 1.5, borderTop: 1, borderColor: 'divider' }}
      >
        <Button
          variant="contained"
          onClick={() => send.mutate()}
          disabled={!info.canSend || blockedByLegacy || send.isPending || missing.length > 0}
        >
          {send.isPending ? 'Sending…' : sendLabel}
        </Button>
        {!info.canSend && (
          <Typography variant="caption" color="text.secondary">
            Needs an Accept decision first
          </Typography>
        )}
        {missing.length > 0 && (
          <Typography variant="caption" color="warning.dark">
            Still needed: {missing.join(', ')}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}

/** Small colored dot after a field label; hovering it says where the value came from. */
function SourceTag({ source, from }: { source: Ims2FieldSource; from?: string }) {
  const where = from
    ? from === 'quote'
      ? ' from the primary quote'
      : from === 'email'
        ? ' from the email'
        : ` from ${from.replace(/_/g, ' ')}`
    : '';
  return (
    <Tooltip title={`${SOURCE_TEXT[source]}${where}`} arrow>
      <Box
        component="span"
        aria-label={`${SOURCE_TEXT[source]}${where}`}
        sx={{
          display: 'inline-block',
          width: 7,
          height: 7,
          ml: 0.75,
          mb: '1px',
          borderRadius: '50%',
          verticalAlign: 'middle',
          pointerEvents: 'auto',
          bgcolor: SOURCE_COLOR[source] === 'default' ? 'text.disabled' : `${SOURCE_COLOR[source]}.main`,
        }}
      />
    </Tooltip>
  );
}

/** Outlined group with a heading, an optional result count or on/off switch, and a one-line hint. */
function Panel({
  title,
  count,
  toggle,
  hint,
  children,
}: {
  title: string;
  count?: number;
  toggle?: ReactNode;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: children ? 1 : 0 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        {count !== undefined && (
          <Typography variant="caption" color="text.secondary">
            {count} found
          </Typography>
        )}
        {toggle}
      </Stack>
      {hint && (
        <Typography variant="caption" color="warning.dark" component="p" sx={{ mb: 1 }}>
          {hint}
        </Typography>
      )}
      {children}
    </Box>
  );
}

/** A full-width radio row; the chosen one is tinted so it stands out in a long list. */
function Option({ value, selected, children }: { value: string | number; selected: boolean; children: ReactNode }) {
  return (
    <FormControlLabel
      value={value}
      control={<Radio size="small" sx={{ p: 0.5, mr: 0.5 }} />}
      label={children}
      sx={{
        mx: 0,
        px: 0.75,
        py: 0.25,
        width: '100%',
        borderRadius: 1,
        alignItems: 'flex-start',
        bgcolor: selected ? 'action.selected' : 'transparent',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
      }}
    />
  );
}

function Candidate({ title, detail, matchedOn }: { title: string; detail: string; matchedOn: string[] }) {
  const strong = exact(matchedOn);
  return (
    <Box sx={{ pt: 0.25 }}>
      <Typography variant="body2">{title}</Typography>
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
        {detail && (
          <Typography variant="caption" color="text.secondary">
            {detail}
          </Typography>
        )}
        {matchedOn.map((m) => (
          <Chip
            key={m}
            size="small"
            label={`${MATCH_LABEL[m] ?? m} match`}
            color={strong ? 'success' : 'warning'}
            variant="outlined"
            sx={{ height: 18, fontSize: 11 }}
          />
        ))}
      </Stack>
    </Box>
  );
}
