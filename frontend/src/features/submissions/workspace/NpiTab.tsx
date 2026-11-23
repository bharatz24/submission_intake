import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import WarningIcon from '@mui/icons-material/WarningAmberOutlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ConfirmDialog, EmptyState, EnumChip, SectionCard } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { pipelineHintHidden, useManualStep } from '../../../lib/automation';
import { npiRegistryUrl } from '../../../lib/links';
import { formatDateTime, humanize, nameTypeLabel, npiStatusColor } from '../../../lib/status';
import { api } from '../../../services/api';
import type { NpiVerification, SubmissionDetail } from '../../../types';
import { auditKeys } from '../../audit';
import { NpiDetailsDialog } from '../components/NpiDetailsDialog';
import { NpiEntryBar } from '../components/NpiEntryBar';
import { npiRank } from '../components/NpiHeaderChip';
import { NpiMatchReview } from '../components/NpiMatchReview';
import { submissionKeys } from '../queryKeys';

export function NpiTab({ s }: { s: SubmissionDetail }) {
  const [details, setDetails] = useState<NpiVerification | null>(null);
  const [pendingRemove, setPendingRemove] = useState<NpiVerification | null>(null);
  const { user } = useAuth();
  const qc = useQueryClient();
  const manual = useManualStep('npiVerification', pipelineHintHidden(s));
  const toast = useToast();
  const verify = useMutation({
    // Empty body: the backend re-verifies every NPI found in the submission.
    mutationFn: () => api.verifyNpi(s.id, {}),
    onSuccess: (list) => {
      qc.setQueryData<SubmissionDetail>(submissionKeys.detail(s.id), (old) =>
        old ? { ...old, npiVerifications: list } : old,
      );
      qc.invalidateQueries({ queryKey: submissionKeys.detail(s.id) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      toast.success(TOAST_MESSAGES.npiVerified);
    },
    onError: (err) => toast.error(err),
  });
  const remove = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (verificationId: string) => api.removeNpi(s.id, verificationId),
    onSuccess: (list) => {
      qc.setQueryData<SubmissionDetail>(submissionKeys.detail(s.id), (old) =>
        old ? { ...old, npiVerifications: list } : old,
      );
      qc.invalidateQueries({ queryKey: submissionKeys.detail(s.id) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
      toast.success(TOAST_MESSAGES.npiRemoved);
    },
  });

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <NpiEntryBar s={s} onReverify={() => verify.mutate()} reverifying={verify.isPending} />
        <SectionCard
          title="Verification results"
          subtitle="Checked against the CMS NPI Registry (NPPES)."
          actions={
            hasPermission(user, 'submission:write') && (
              <Button variant="contained" size="small" onClick={() => verify.mutate()} disabled={verify.isPending}>
                {verify.isPending ? 'Verifying…' : 'Re-verify'}
              </Button>
            )
          }
        >
          {s.npiVerifications.length === 0 ? (
            manual ? (
              <EmptyState
                title="No NPI verifications"
                description="NPI verification is Manual in Settings → Automation. Run it when you're ready."
                action={
                  hasPermission(user, 'submission:write') && (
                    <Button variant="outlined" size="small" onClick={() => verify.mutate()} disabled={verify.isPending}>
                      {verify.isPending ? 'Verifying…' : 'Verify NPIs'}
                    </Button>
                  )
                }
              />
            ) : (
              <EmptyState
                title="No NPI verifications"
                description="No verification has run yet. NPIs on the submission are checked by number; otherwise the registry is searched by name + ZIP."
              />
            )
          ) : (
            <Stack spacing={1.5}>
              {/* Matching NPIs first: one match verifies the submission, the rest are listed below it. */}
              {[...s.npiVerifications]
                .sort((a, b) => npiRank(a.status) - npiRank(b.status))
                .map((v) => (
                  <Paper
                    key={v.id}
                    variant="outlined"
                    sx={{
                      p: 1.5,
                      borderLeft: 4,
                      borderLeftColor: `${npiStatusColor(v.status) === 'default' ? 'grey.400' : `${npiStatusColor(v.status)}.main`}`,
                    }}
                  >
                    <Stack
                      direction="row"
                      justifyContent="space-between"
                      alignItems="center"
                      sx={{ mb: 1 }}
                      flexWrap="wrap"
                      useFlexGap
                      spacing={1}
                    >
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Link
                          component="button"
                          type="button"
                          variant="subtitle1"
                          underline="hover"
                          onClick={() => setDetails(v)}
                          sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}
                        >
                          {v.npi ? `NPI ${v.npi}` : 'NPI not on file'}
                        </Link>
                        <EnumChip value={v.status} color={npiStatusColor(v.status)} />
                        {v.source === 'MANUAL' && (
                          <Chip
                            size="small"
                            color="primary"
                            label="Manual"
                            title={`Entered by ${v.addedBy?.name ?? 'an underwriter'}${v.note ? `: ${v.note}` : ''}`}
                          />
                        )}
                        {v.autoStatus && (
                          <Chip
                            size="small"
                            color="primary"
                            variant="outlined"
                            label="Underwriter decision"
                            title={`Registry check: ${humanize(v.autoStatus)}. ${v.overrideNote ?? ''}`}
                          />
                        )}
                        {v.registryStatus && (
                          <Chip
                            size="small"
                            variant="outlined"
                            color={v.registryStatus === 'A' ? 'success' : 'error'}
                            label={
                              v.registryStatus === 'A'
                                ? 'Active'
                                : v.registryStatus === 'D'
                                  ? 'Deactivated'
                                  : `Registry: ${v.registryStatus}`
                            }
                          />
                        )}
                      </Stack>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="caption" color="text.secondary">
                          Verified {formatDateTime(v.verifiedAt)}
                        </Typography>
                        <Button size="small" variant="outlined" onClick={() => setDetails(v)}>
                          View details
                        </Button>
                        {v.npi && (v.status === 'MATCH' || v.status === 'PARTIAL_MATCH') && (
                          <Button
                            size="small"
                            variant="outlined"
                            component="a"
                            href={npiRegistryUrl(v.npi)}
                            target="_blank"
                            rel="noopener noreferrer"
                            endIcon={<OpenInNewIcon sx={{ fontSize: '0.9rem' }} />}
                            title="Open this NPI in the CMS NPPES NPI Registry"
                          >
                            Open on CMS
                          </Button>
                        )}
                        {v.source === 'MANUAL' && hasPermission(user, 'submission:write') && (
                          <Button
                            size="small"
                            color="error"
                            disabled={remove.isPending}
                            onClick={() => {
                              remove.reset();
                              setPendingRemove(v);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </Stack>
                    </Stack>
                    {v.source === 'MANUAL' && (v.addedBy || v.note) && (
                      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.75 }}>
                        Entered by {v.addedBy?.name ?? 'an underwriter'}
                        {v.note ? ` · ${v.note}` : ''}
                      </Typography>
                    )}
                    <Table size="small" sx={{ '& td': { py: 0.5 } }}>
                      <TableHead>
                        <TableRow>
                          <TableCell />
                          <TableCell>Claimed (submission)</TableCell>
                          <TableCell>CMS registry</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <CompareRow label="Name" claimed={v.claimedName} registry={v.registryName} />
                        <CompareRow
                          label="Type"
                          claimed={nameTypeLabel(v.claimedType)}
                          registry={nameTypeLabel(v.registryType)}
                        />
                        {(v.claimedType === 'INDIVIDUAL' || v.registryType === 'INDIVIDUAL') && (
                          <>
                            <CompareRow
                              label="First name"
                              claimed={v.claimedFirstName}
                              registry={v.registryFirstName}
                            />
                            <CompareRow label="Last name" claimed={v.claimedLastName} registry={v.registryLastName} />
                          </>
                        )}
                        {(v.claimedType === 'ORGANIZATION' || v.registryType === 'ORGANIZATION') && (
                          <CompareRow
                            label="Entity name"
                            claimed={v.claimedEntityName}
                            registry={v.registryEntityName}
                          />
                        )}
                        <CompareRow label="State" claimed={v.claimedState} registry={v.registryState} />
                        <CompareRow
                          label="Specialty / taxonomy"
                          claimed={v.claimedSpecialty}
                          registry={v.registryTaxonomy}
                        />
                      </TableBody>
                    </Table>
                    {v.mismatches.length > 0 && (
                      <Alert
                        severity={
                          v.status === 'MATCH'
                            ? 'info'
                            : v.status === 'PARTIAL_MATCH' || v.status === 'NOT_VERIFIED'
                              ? 'warning'
                              : 'error'
                        }
                        icon={<WarningIcon fontSize="small" />}
                        sx={{ mt: 1 }}
                      >
                        <Box component="ul" sx={{ m: 0, pl: 2 }}>
                          {v.mismatches.map((m, i) => (
                            <li key={i}>{m}</li>
                          ))}
                        </Box>
                      </Alert>
                    )}
                    <NpiMatchReview s={s} v={v} />
                  </Paper>
                ))}
            </Stack>
          )}
          {details && <NpiDetailsDialog v={details} open onClose={() => setDetails(null)} />}
          <ConfirmDialog
            open={!!pendingRemove}
            title="Remove NPI verification?"
            message={
              <>
                The manual verification for{' '}
                <strong>{pendingRemove?.npi ? `NPI ${pendingRemove.npi}` : 'this NPI'}</strong> will be removed from
                this submission. The registry check itself is not affected.
              </>
            }
            confirmLabel="Remove"
            busy={remove.isPending}
            error={pendingRemove ? remove.error : null}
            onConfirm={() =>
              pendingRemove && remove.mutate(pendingRemove.id, { onSuccess: () => setPendingRemove(null) })
            }
            onCancel={() => {
              remove.reset();
              setPendingRemove(null);
            }}
          />
        </SectionCard>
      </Grid>
    </Grid>
  );
}

function CompareRow({ label, claimed, registry }: { label: string; claimed: string | null; registry: string | null }) {
  const differs = !!claimed && !!registry && claimed.trim().toLowerCase() !== registry.trim().toLowerCase();
  return (
    <TableRow>
      <TableCell sx={{ color: 'text.secondary', width: 160 }}>{label}</TableCell>
      <TableCell>
        {claimed ?? (
          <Box component="span" color="text.disabled">
            —
          </Box>
        )}
      </TableCell>
      <TableCell sx={{ color: differs ? 'warning.dark' : undefined, fontWeight: differs ? 600 : undefined }}>
        {registry ?? (
          <Box component="span" color="text.disabled">
            —
          </Box>
        )}
      </TableCell>
    </TableRow>
  );
}
