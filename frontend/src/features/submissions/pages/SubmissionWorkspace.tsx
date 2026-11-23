import DraftIcon from '@mui/icons-material/DraftsOutlined';
import ChatIcon from '@mui/icons-material/ForumOutlined';
import MailIcon from '@mui/icons-material/MailOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Alert,
  AlertTitle,
  Box,
  Breadcrumbs,
  Button,
  Chip,
  Drawer,
  Link,
  Paper,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, EnumChip, ErrorState, SectionBands } from '../../../components/common';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { useNotifications } from '../../../components/notifications/NotificationProvider';
import { POLL_MS } from '../../../constants';
import { useDocumentTitle } from '../../../hooks/useDocumentTitle';
import { gmailMessageUrl } from '../../../lib/links';
import { friendlyProcessingError, pipelineStepLabel } from '../../../lib/pipeline';
import { progressActive } from '../../../lib/processingProgress';
import {
  classificationColor,
  formatDateTime,
  humanize,
  nameTypeLabel,
  submissionStatusColor,
} from '../../../lib/status';
import { api, apiWith } from '../../../services/api';
import type { SubmissionDetail, SubmissionStatus } from '../../../types';
import { SubmissionAuditList } from '../../audit';
import { AnalysisView } from '../components/AnalysisView';
import { AssessmentView } from '../components/AssessmentView';
import { ClaudeChat } from '../components/ClaudeChat';
import { CompareView } from '../components/CompareView';
import { CoverageTab } from '../components/CoverageTab';
import { DuplicateBanners } from '../components/DuplicateBanners';
import { EmailDraftDialog } from '../components/EmailDraftDialog';
import { ImportHoldBanner } from '../components/ImportHoldBanner';
import { InjectionBanner } from '../components/InjectionBanner';
import { NpiHeaderChip } from '../components/NpiHeaderChip';
import { OverrideDialog } from '../components/OverrideDialog';
import { ProcessingFailedBanner, ProcessingProgressBar, showFailedBanner } from '../components/ProcessingProgress';
import { SubmissionSkeleton } from '../components/SubmissionSkeleton';
import { SynthesisView } from '../components/SynthesisView';
import { VersionTimeline } from '../components/VersionTimeline';
import { quoteKeys, reportKeys, submissionKeys } from '../queryKeys';
import { DocumentsTab } from '../workspace/DocumentsTab';
import { NpiTab } from '../workspace/NpiTab';
import { OverviewTab } from '../workspace/OverviewTab';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'documents', label: 'Documents & Evidence' },
  { key: 'npi', label: 'NPI Verification' },
  { key: 'synthesis', label: 'Synthesis' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'coverage', label: 'Coverage & Rating' },
  { key: 'compare', label: 'Compare' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'versions', label: 'Versions' },
  { key: 'audit', label: 'Audit' },
] as const;

export type TabKey = (typeof TABS)[number]['key'];

// Ignored and duplicate emails are never processed, so they have no reports, assessment or chat.
const PROCESSED_ONLY: TabKey[] = ['synthesis', 'analysis', 'compare', 'assessment'];

export const isHeldBack = (s: { status: SubmissionStatus }) =>
  s.status === 'DUPLICATE' || s.status === 'NOT_SUBMISSION';

const CHAT_WIDTH = 420;

// Submission ids are UUIDs; anything else in the route is never sent to the API.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SubmissionWorkspace() {
  const { id: rawId = '' } = useParams();
  const id = UUID_RE.test(rawId) ? rawId : '';
  const [params, setParams] = useSearchParams();
  const requestedTab = (TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'overview') as TabKey;
  const [chatOpen, setChatOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const { user } = useAuth();
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('xl'));
  const notifications = useNotifications();

  const detail = useQuery({
    queryKey: submissionKeys.detail(id),
    queryFn: ({ signal }) => apiWith(signal).getSubmission(id),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      const pendingDocs = q.state.data?.documents.some((d) => d.extractionStatus === 'PENDING');
      const autoRetrying = q.state.data?.pipeline?.autoRetrying;
      // Also while the automatic Synthesis, Analysis and quote are still to come, for the progress tracker.
      const tracking = q.state.data ? progressActive(q.state.data) : false;
      const queued = q.state.data?.processingQueued;
      return s === 'NEW' || s === 'PROCESSING' || pendingDocs || autoRetrying || queued || tracking
        ? POLL_MS.submissionProcessing
        : false;
    },
  });

  const qc = useQueryClient();
  // As an automatic report or quote finishes, its tab and the Quotes card show it without a reload.
  const autoRunKey = JSON.stringify(detail.data?.autoRun ?? null);
  useEffect(() => {
    if (!id) return;
    qc.invalidateQueries({ queryKey: reportKeys.all(id) });
    qc.invalidateQueries({ queryKey: quoteKeys.list(id) });
  }, [id, autoRunKey, qc]);

  // Opening a submission marks it read: the inbox badge takes the new count and the row loses its unread style.
  useEffect(() => {
    if (!id) return;
    api
      .markRead(id)
      .then((r) => {
        qc.setQueryData(submissionKeys.unreadCount(), r);
        qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      })
      .catch(() => {
        /* badge catches up on its next poll */
      });
  }, [id, qc]);
  // ...and clears its bell notification. markRead reads the latest list, so a stale reference is fine.
  const markNotificationRead = notifications.markRead;

  useEffect(() => {
    if (id) markNotificationRead(id);
  }, [id]);

  // Before the early returns below: hooks run on every render.
  useDocumentTitle(detail.data ? (detail.data.applicantName ?? detail.data.subject ?? 'Submission') : 'Submission');
  if (!id)
    return <EmptyState title="Submission not found" description="The link does not point to a valid submission." />;
  if (detail.isLoading) return <SubmissionSkeleton />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => detail.refetch()} title="Could not load submission" />;
  const s = detail.data;
  if (!s) return null;
  const heldBack = isHeldBack(s);
  const tabs = heldBack ? TABS.filter((t) => !PROCESSED_ONLY.includes(t.key)) : TABS;
  const tab = tabs.some((t) => t.key === requestedTab) ? requestedTab : 'overview';

  const setTab = (t: TabKey) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    // The Compare tab's selection only lives while it is open.
    if (t !== 'compare') ['kind', 'base', 'target'].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
  };

  const chat = <ClaudeChat key={id} submissionId={id} onClose={() => setChatOpen(false)} />;

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
      <EmailDraftDialog key={id} submissionId={id} open={draftsOpen} onClose={() => setDraftsOpen(false)} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Breadcrumbs sx={{ mb: 1, fontSize: '0.8rem' }}>
          <Link component={RouterLink} to="/" underline="hover" color="inherit">
            Inbox
          </Link>
          <Typography variant="body2" color="text.primary" noWrap sx={{ maxWidth: 420 }}>
            {s.subject || '(no subject)'}
          </Typography>
        </Breadcrumbs>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ md: 'center' }}
          sx={{ mb: 1.5 }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="h5"
              component="h1"
              tabIndex={-1}
              data-page-title
              sx={{ '&:focus': { outline: 'none' } }}
              noWrap
              title={s.subject}
            >
              {s.applicantName ?? s.subject ?? '(no subject)'}
            </Typography>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              <EnumChip value={s.status} color={submissionStatusColor(s.status)} />
              {/* Ignored and duplicate emails carry the same value as status and classification: show it once. */}
              {humanize(s.classification) !== humanize(s.status) && (
                <EnumChip value={s.classification} color={classificationColor(s.classification)} />
              )}
              {s.applicantType && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={nameTypeLabel(s.applicantType)}
                  title="Applicant type, read from the applicant name"
                />
              )}
              <Chip
                size="small"
                variant="outlined"
                label={`Context v${s.contextVersion}`}
                title="Context version: increments whenever the evidence set changes"
              />
              {s.npiStatus && <NpiHeaderChip status={s.npiStatus} verifications={s.npiVerifications} />}
              {s.email.gmailMessageId && (
                <Chip
                  size="small"
                  variant="outlined"
                  color="primary"
                  clickable
                  component="a"
                  href={gmailMessageUrl(s.email.gmailMessageId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the original email in Gmail (new tab)"
                  icon={<MailIcon sx={{ fontSize: '0.9rem !important' }} />}
                  label={
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      Email
                      <OpenInNewIcon sx={{ fontSize: '0.85rem' }} />
                    </Box>
                  }
                />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
              from{' '}
              <Link href={`mailto:${s.fromAddress}`} underline="hover">
                {s.fromAddress}
              </Link>{' '}
              · {formatDateTime(s.receivedAt)}
            </Typography>
          </Box>
          {!heldBack && (
            <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
              {hasPermission(user, 'submission:write') && (
                // Drafts come from the latest completed analysis (latestAnalysisVersion counts completed ones only).
                <Tooltip
                  title={
                    s.latestAnalysisVersion
                      ? 'Draft an email to the broker, the insured or about the quote'
                      : 'Run the analysis first'
                  }
                >
                  <span>
                    <Button
                      variant="outlined"
                      startIcon={<DraftIcon />}
                      onClick={() => setDraftsOpen(true)}
                      disabled={!s.latestAnalysisVersion}
                    >
                      Draft Email
                    </Button>
                  </span>
                </Tooltip>
              )}
              <Button
                variant={chatOpen ? 'outlined' : 'contained'}
                startIcon={<ChatIcon />}
                onClick={() => setChatOpen((o) => !o)}
              >
                {chatOpen ? 'Hide Claude chat' : 'Ask Claude'}
              </Button>
            </Stack>
          )}
        </Stack>
        <DuplicateBanners s={s} />
        <InjectionBanner flags={s.injectionFlags} />
        {s.heldForClassification && (
          <Alert
            severity="warning"
            sx={{ mb: 1.5 }}
            action={
              hasPermission(user, 'submission:write') && (
                <Button
                  color="inherit"
                  size="small"
                  variant="outlined"
                  onClick={() => setOverrideOpen(true)}
                  sx={{ whiteSpace: 'nowrap' }}
                >
                  Change classification
                </Button>
              )
            }
          >
            <AlertTitle>Held for classification</AlertTitle>
            Classification is set to Manual in Settings → Automation, so this email waits for an underwriter. Confirm
            whether it is a submission to continue processing — extraction, NPI checks and reports then run as set in
            Automation.
          </Alert>
        )}
        {s.heldForImport && !s.heldForClassification && <ImportHoldBanner id={id} />}
        {progressActive(s) && !s.heldForClassification && (
          <Alert severity="info" icon={false} sx={{ mb: 1.5 }}>
            <ProcessingProgressBar s={s} />
            {s.pipeline?.autoRetrying && s.pipeline.failedStep && (
              <Typography variant="body2" sx={{ mt: 0.75 }}>
                A temporary problem with {pipelineStepLabel(s.pipeline.failedStep)} — retrying automatically.
              </Typography>
            )}
          </Alert>
        )}
        {showFailedBanner(s) ? (
          <ProcessingFailedBanner s={s} />
        ) : (
          s.processingError && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              <b>Processing error:</b> {friendlyProcessingError(s.processingError).message}
            </Alert>
          )
        )}

        <Paper variant="outlined" sx={{ mb: 2 }}>
          <Tabs
            value={tab}
            onChange={(_, v: TabKey) => setTab(v)}
            variant="scrollable"
            scrollButtons="auto"
            // Keep both arrows in place while the tabs overflow; the one at the end of travel is shown disabled, not hidden.
            sx={{ px: 1, '& .MuiTabs-scrollButtons.Mui-disabled': { opacity: 0.3 } }}
          >
            {tabs.map((t) => (
              <Tab key={t.key} value={t.key} label={tabLabel(t.key, t.label, s)} />
            ))}
          </Tabs>
        </Paper>

        {/* Every tab's cards share the Synthesis/Analysis band header. */}
        <SectionBands>
          {/* One tab that fails to render shows a recoverable message here; the header, tabs and chat stay usable.
              Switching tab (or submission) clears it. */}
          <ErrorBoundary variant="section" resetKey={`${id}:${tab}`}>
            {tab === 'overview' && (
              <OverviewTab s={s} onOpenTab={setTab} onChangeClassification={() => setOverrideOpen(true)} />
            )}
            {tab === 'coverage' && <CoverageTab s={s} />}
            {tab === 'documents' && <DocumentsTab s={s} />}
            {tab === 'npi' && <NpiTab s={s} />}
            {tab === 'synthesis' && (
              <SynthesisView submissionId={id} applicant={s} held={s.heldForClassification || s.heldForImport} />
            )}
            {tab === 'analysis' && (
              <AnalysisView submissionId={id} applicant={s} held={s.heldForClassification || s.heldForImport} />
            )}
            {tab === 'compare' && <CompareView submissionId={id} />}
            {tab === 'assessment' && <AssessmentView submissionId={id} />}
            {tab === 'versions' && <VersionTimeline submissionId={id} />}
            {tab === 'audit' && <SubmissionAuditList submissionId={id} />}
          </ErrorBoundary>
        </SectionBands>
        <OverrideDialog s={s} open={overrideOpen} onClose={() => setOverrideOpen(false)} />
      </Box>

      {heldBack ? null : wide ? (
        chatOpen && (
          <Paper
            variant="outlined"
            sx={{
              width: CHAT_WIDTH,
              flexShrink: 0,
              position: 'sticky',
              top: 72,
              height: 'calc(100vh - 92px)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {chat}
          </Paper>
        )
      ) : (
        <Drawer
          anchor="right"
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          PaperProps={{ sx: { width: { xs: '100%', sm: CHAT_WIDTH } } }}
        >
          <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>{chat}</Box>
        </Drawer>
      )}
    </Box>
  );
}

function tabLabel(key: TabKey, label: string, s: SubmissionDetail): ReactNode {
  const badge = (content: ReactNode, color: 'primary' | 'error' | 'warning' | 'default' = 'default') => (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <span>{label}</span>
      <Chip
        size="small"
        label={content}
        color={color === 'default' ? undefined : color}
        variant={color === 'default' ? 'outlined' : 'filled'}
        sx={{ height: 18, fontSize: '0.65rem' }}
      />
    </Stack>
  );
  switch (key) {
    case 'documents':
      return badge(s.documents.length);
    case 'npi': {
      const bad = s.npiVerifications.filter((n) => n.status !== 'MATCH').length;
      return s.npiVerifications.length ? badge(s.npiVerifications.length, bad ? 'warning' : 'default') : label;
    }
    case 'synthesis':
      return s.latestSynthesis ? badge(`v${s.latestSynthesis.version}`) : label;
    case 'analysis':
      return s.latestAnalysis ? badge(`v${s.latestAnalysis.version}`) : label;
    case 'assessment':
      return s.latestAssessment ? badge(`v${s.latestAssessment.version}`) : label;
    default:
      return label;
  }
}

// ---------------------------------------------------------------- Processing failed banner
