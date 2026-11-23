import DocIcon from '@mui/icons-material/DescriptionOutlined';
import EditIcon from '@mui/icons-material/EditOutlined';
import FieldsIcon from '@mui/icons-material/FactCheckOutlined';
import ReplayIcon from '@mui/icons-material/Replay';
import VerifiedIcon from '@mui/icons-material/VerifiedUserOutlined';
import { Box, Button, Divider, Grid, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EnumChip, SectionBands, SectionCard } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { STALE_MS, TOAST_MESSAGES } from '../../../constants';
import { useReprocess } from '../../../lib/automation';
import {
  classificationColor,
  decisionColor,
  formatDateTime,
  formatPercent,
  humanize,
  reportStatusColor,
  riskColor,
  submissionStatusColor,
} from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { OutboundMode, SubmissionDetail, SubmissionStatus } from '../../../types';
import { userKeys } from '../../settings';
import { AttachmentsCard } from '../components/AttachmentsCard';
import { EmailCard } from '../components/EmailCard';
import { EmailComposeDialog } from '../components/EmailComposeDialog';
import { SentEmailsCard } from '../components/SentEmailsCard';
import { STATUSES } from '../inbox/inboxOptions';
import { isHeldBack, type TabKey } from '../pages/SubmissionWorkspace';
import { submissionKeys } from '../queryKeys';

export function OverviewTab({
  s,
  onOpenTab,
  onChangeClassification,
}: {
  s: SubmissionDetail;
  onOpenTab: (t: TabKey) => void;
  onChangeClassification: () => void;
}) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const qc = useQueryClient();
  const [compose, setCompose] = useState<OutboundMode | null>(null);
  const duplicate = s.status === 'DUPLICATE';
  const npiIssues = s.npiVerifications.filter((n) => n.status !== 'MATCH').length;

  const users = useQuery({
    queryKey: userKeys.all(),
    queryFn: ({ signal }) => apiWith(signal).users(),
    enabled: writable,
    staleTime: STALE_MS.users,
    retry: false,
  });
  const toast = useToast();
  const patch = useMutation({
    mutationFn: (body: { status?: SubmissionStatus; assignedToId?: string | null }) => api.updateSubmission(s.id, body),
    onSuccess: async (d, body) => {
      // Drop any in-flight poll first so an older response can't overwrite the patched detail.
      await qc.cancelQueries({ queryKey: submissionKeys.detail(s.id), exact: true });
      qc.setQueryData(submissionKeys.detail(s.id), d);
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      toast.success(
        body.status !== undefined
          ? TOAST_MESSAGES.statusChanged(humanize(d.status))
          : TOAST_MESSAGES.assigned(d.assignedTo?.name ?? null),
      );
    },
    onError: (err) => toast.error(err),
  });
  const reprocess = useReprocess(s.id);

  return (
    <SectionBands>
      <Grid container spacing={2}>
        <Grid item xs={12} lg={7}>
          <Stack spacing={2}>
            <EmailCard s={s} onCompose={writable ? setCompose : undefined} />
            <SentEmailsCard s={s} />
          </Stack>
          <EmailComposeDialog s={s} mode={compose} onClose={() => setCompose(null)} />
        </Grid>
        <Grid item xs={12} lg={5}>
          <Stack spacing={2}>
            <SectionCard
              title="Classification"
              tone="info"
              actions={
                writable && (
                  <Button size="small" startIcon={<EditIcon />} onClick={onChangeClassification}>
                    Change
                  </Button>
                )
              }
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                {duplicate ? (
                  <EnumChip value="DUPLICATE" color="default" size="medium" />
                ) : (
                  <EnumChip value={s.classification} color={classificationColor(s.classification)} size="medium" />
                )}
                {s.classificationConfidence !== null && (
                  <Typography variant="body2" color="text.secondary">
                    confidence {formatPercent(s.classificationConfidence)}
                  </Typography>
                )}
              </Stack>
              {s.classificationReasons.length > 0 ? (
                <Box component="ul" sx={{ m: 0, pl: 2.5, '& li': { fontSize: '0.85rem', mb: 0.25 } }}>
                  {s.classificationReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {duplicate
                    ? (s.duplicateBasis?.explanation ?? 'Held back as a duplicate before classification.')
                    : 'No classification reasons recorded.'}
                </Typography>
              )}
            </SectionCard>

            <SectionCard title="Workflow" tone="secondary" subtitle={`Last updated ${formatDateTime(s.updatedAt)}`}>
              <Stack spacing={1.5}>
                <TextField
                  select
                  label="Status"
                  value={s.status}
                  disabled={!writable || patch.isPending || duplicate}
                  helperText={
                    duplicate ? 'Use "Change" under Classification to move this email out of Duplicates.' : undefined
                  }
                  onChange={(e) => patch.mutate({ status: e.target.value as SubmissionStatus })}
                >
                  {(duplicate ? [...STATUSES, s.status] : STATUSES).map((st) => (
                    <MenuItem key={st} value={st}>
                      <EnumChip value={st} color={submissionStatusColor(st)} />
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  select
                  label="Assigned underwriter"
                  value={s.assignedTo?.id ?? ''}
                  disabled={!writable || patch.isPending || !users.data}
                  onChange={(e) => patch.mutate({ assignedToId: e.target.value || null })}
                  helperText={users.isError ? `Could not load users: ${errorMessage(users.error)}` : undefined}
                >
                  <MenuItem value="">
                    <em>Unassigned</em>
                  </MenuItem>
                  {s.assignedTo && !users.data?.some((u) => u.id === s.assignedTo?.id) && (
                    <MenuItem value={s.assignedTo.id}>{s.assignedTo.name}</MenuItem>
                  )}
                  {/* Non-admins get only id, name and role; admins also see email and disabled accounts (hidden here). */}
                  {users.data
                    ?.filter(
                      (u) => hasPermission(u, 'submission:write') && !(u as { disabledAt?: string | null }).disabledAt,
                    )
                    .map((u) => (
                      <MenuItem key={u.id} value={u.id}>
                        {u.name}
                        {u.email ? ` (${u.email})` : ''}
                      </MenuItem>
                    ))}
                </TextField>
                {writable && (
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    {!isHeldBack(s) && (
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<ReplayIcon />}
                        disabled={reprocess.isPending || !!s.processingQueued}
                        onClick={() => reprocess.mutate()}
                      >
                        {reprocess.isPending ? 'Queuing…' : 'Re-run extraction + NPI'}
                      </Button>
                    )}
                  </Stack>
                )}
              </Stack>
            </SectionCard>

            <SectionCard title="Review status">
              <Stack spacing={1}>
                <ReviewRow label="Synthesis" report={s.latestSynthesis} />
                <ReviewRow label="Analysis" report={s.latestAnalysis} />
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" fontWeight={600}>
                    Assessment
                  </Typography>
                  {s.latestAssessment ? (
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <Typography variant="caption" color="text.secondary">
                        v{s.latestAssessment.version}
                      </Typography>
                      <EnumChip
                        value={s.latestAssessment.decision}
                        color={decisionColor(s.latestAssessment.decision)}
                      />
                      <EnumChip
                        value={s.latestAssessment.riskRating}
                        color={riskColor(s.latestAssessment.riskRating)}
                        variant="outlined"
                      />
                    </Stack>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      Not yet recorded
                    </Typography>
                  )}
                </Stack>
                <Divider />
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 0.75 }}>
                  <StatTile
                    icon={<DocIcon />}
                    label="Documents"
                    value={s.documents.length}
                    onClick={() => onOpenTab('documents')}
                  />
                  <StatTile
                    icon={<FieldsIcon />}
                    label="Extracted fields"
                    value={s.extractedFields.length}
                    onClick={() => onOpenTab('documents')}
                  />
                  <StatTile
                    icon={<VerifiedIcon />}
                    label="NPI checks"
                    value={s.npiVerifications.length}
                    onClick={() => onOpenTab('npi')}
                    tone={npiIssues ? 'warning' : s.npiVerifications.length ? 'success' : undefined}
                    hint={npiIssues ? `${npiIssues} to review` : s.npiVerifications.length ? 'all matched' : undefined}
                  />
                </Box>
              </Stack>
            </SectionCard>

            <AttachmentsCard documents={s.documents} gaps={s.attachmentGaps ?? []} />
          </Stack>
        </Grid>
      </Grid>
    </SectionBands>
  );
}

/** Count tile in Review status; clicking it opens the tab that lists those items. */
function StatTile({
  icon,
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  hint?: string;
  tone?: 'success' | 'warning';
  onClick: () => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      title={`${hint ? `${hint} · ` : ''}Open ${label.toLowerCase()}`}
      sx={{
        all: 'unset',
        boxSizing: 'border-box',
        cursor: 'pointer',
        minWidth: 0,
        px: 1,
        py: 0.5,
        borderRadius: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        border: 1,
        borderColor: tone ? (t) => alpha(t.palette[tone].main, 0.4) : 'divider',
        bgcolor: (t) => alpha(tone ? t.palette[tone].main : t.palette.primary.main, 0.05),
        transition: 'border-color .15s, background-color .15s',
        '&:hover, &:focus-visible': {
          borderColor: tone ? `${tone}.main` : 'primary.main',
          bgcolor: (t) => alpha(tone ? t.palette[tone].main : t.palette.primary.main, 0.09),
        },
      }}
    >
      <Box sx={{ display: 'flex', color: tone ? `${tone}.main` : 'primary.main', '& svg': { fontSize: '1.05rem' } }}>
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography component="div" noWrap sx={{ fontSize: '0.95rem', fontWeight: 700, lineHeight: 1.25 }}>
          {value}
          {hint && (
            <Box
              component="span"
              sx={{ ml: 0.5, fontSize: '0.65rem', fontWeight: 600, color: tone ? `${tone}.main` : 'text.secondary' }}
            >
              {hint}
            </Box>
          )}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          component="div"
          sx={{ fontSize: '0.68rem', lineHeight: 1.3 }}
        >
          {label}
        </Typography>
      </Box>
    </Box>
  );
}

function ReviewRow({ label, report }: { label: string; report: SubmissionDetail['latestSynthesis'] }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center">
      <Typography variant="body2" fontWeight={600}>
        {label}
      </Typography>
      {report ? (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="caption" color="text.secondary">
            v{report.version} · ctx v{report.contextVersion}
          </Typography>
          <EnumChip value={report.status} color={reportStatusColor(report.status)} />
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary">
          Not generated
        </Typography>
      )}
    </Stack>
  );
}
