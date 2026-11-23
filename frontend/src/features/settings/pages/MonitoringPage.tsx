import AnalyticsIcon from '@mui/icons-material/AnalyticsOutlined';
import ErrorIcon from '@mui/icons-material/ErrorOutline';
import HourglassIcon from '@mui/icons-material/HourglassEmptyOutlined';
import MailIcon from '@mui/icons-material/MailOutline';
import ReportProblemIcon from '@mui/icons-material/ReportProblemOutlined';
import SummarizeIcon from '@mui/icons-material/SummarizeOutlined';
import SyncIcon from '@mui/icons-material/Sync';
import TollIcon from '@mui/icons-material/Toll';
import { Box, Chip, Grid, LinearProgress, Stack, Tab, Tabs, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useSearchParams } from 'react-router';

import { ErrorState, Loading, PageHeader, SectionBands } from '../../../components/common';
import { Section } from '../../../components/ReportSection';
import { LAST_POLL_STALE_MS, POLL_MS, QUEUE_DEPTH_WARNING } from '../../../constants';
import { formatDateTime, formatRelative } from '../../../lib/status';
import { paths } from '../../../paths';
import { apiWith } from '../../../services/api';
import type { LlmUsageRange } from '../../../types';
import { ErrorsTab } from '../components/ErrorsTab';
import { HealthSummary } from '../components/HealthSummary';
import { IngestQueueAlert } from '../components/IngestQueueAlert';
import { StatCard, SubmissionsOverview } from '../components/SubmissionsOverview';
import { RANGE_LABEL, TokenUsageTab } from '../components/TokenUsageTab';
import { monitoringKeys } from '../queryKeys';

type MonitoringTab = 'tokens' | 'errors';

export function MonitoringPage() {
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get('range');
  const range: LlmUsageRange = rangeParam && rangeParam in RANGE_LABEL ? (rangeParam as LlmUsageRange) : 'today';
  const period = RANGE_LABEL[range].toLowerCase();
  const stats = useQuery({
    queryKey: monitoringKeys.stats(range),
    queryFn: ({ signal }) => apiWith(signal).monitoringStats(range),
    refetchInterval: POLL_MS.monitoringStats,
    placeholderData: keepPreviousData,
  });
  const tab: MonitoringTab = params.get('tab') === 'errors' ? 'errors' : 'tokens';
  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const s = stats.data;
  const usageRef = useRef<HTMLDivElement>(null);
  const showErrors = () => {
    setParam('tab', 'errors', 'tokens');
    usageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const pollStale = !!s?.lastPollAt && Date.now() - new Date(s.lastPollAt).getTime() > LAST_POLL_STALE_MS;
  return (
    <Box>
      <PageHeader
        title="Monitoring"
        subtitle={`How the system is doing ${period === 'today' ? 'today' : period === 'all time' ? 'over all time' : `over the ${period}`} · updates automatically${stats.dataUpdatedAt ? ` · last updated ${formatRelative(new Date(stats.dataUpdatedAt).toISOString())}` : ''}`}
        actions={
          <ToggleButtonGroup
            size="small"
            exclusive
            value={range}
            onChange={(_, v: LlmUsageRange | null) => v && setParam('range', v, 'today')}
          >
            {(Object.keys(RANGE_LABEL) as LlmUsageRange[]).map((r) => (
              <ToggleButton key={r} value={r} sx={{ px: 1.5 }}>
                {RANGE_LABEL[r]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        }
      />
      {stats.isFetching && stats.isPlaceholderData && <LinearProgress sx={{ mb: 1 }} />}
      {stats.isLoading ? (
        <Loading label="Loading monitoring stats…" shape="cards" />
      ) : stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => stats.refetch()} title="Could not load monitoring stats" />
      ) : s ? (
        // One grid for the whole page: a Grid nested in a Stack loses its negative margins and shifts out of line.
        <SectionBands>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <HealthSummary stats={s} period={period} onShowErrors={showErrors} />
            </Grid>
            <Grid item xs={6} md={4} lg={2}>
              <StatCard
                icon={<MailIcon />}
                label="Emails received"
                value={s.emails}
                hint={`${s.duplicates ?? 0} held back as duplicates`}
                info="Every email that arrived in the connected Gmail inbox during this period. Click to open the inbox."
                to={`${paths.inbox}?view=submissions`}
              />
            </Grid>
            <Grid item xs={6} md={4} lg={2}>
              <StatCard
                icon={<SummarizeIcon />}
                label="Syntheses"
                value={s.reports?.SYNTHESIS ?? 0}
                hint={RANGE_LABEL[range]}
                info="Synthesis reports Claude generated for submissions in this period."
              />
            </Grid>
            <Grid item xs={6} md={4} lg={2}>
              <StatCard
                icon={<AnalyticsIcon />}
                label="Analyses"
                value={s.reports?.ANALYSIS ?? 0}
                hint={RANGE_LABEL[range]}
                info="Underwriting Analysis reports Claude generated for submissions in this period."
              />
            </Grid>
            <Grid item xs={6} md={4} lg={2}>
              <StatCard
                icon={<ReportProblemIcon />}
                label="Failed reports"
                value={s.failedReports}
                tone={s.failedReports > 0 ? 'error' : 'success'}
                hint={s.failedReports > 0 ? 'Click to see what went wrong' : 'None failed'}
                info="Synthesis or Analysis reports that could not be generated. Click to see the errors."
                onClick={s.failedReports > 0 ? showErrors : undefined}
              />
            </Grid>
            <Grid item xs={6} md={4} lg={2}>
              <StatCard
                icon={<HourglassIcon />}
                label="In queue"
                value={s.queueDepth}
                tone={s.queueDepth > QUEUE_DEPTH_WARNING ? 'warning' : undefined}
                hint={s.queueDepth ? 'Right now' : 'Nothing waiting'}
                info={`Pipeline jobs not yet finished right now. Above ${QUEUE_DEPTH_WARNING} means processing is running behind.`}
              />
            </Grid>
            <Grid item xs={6} md={4} lg={2}>
              <StatCard
                icon={<SyncIcon />}
                label="Gmail checked"
                value={s.lastPollAt ? formatRelative(s.lastPollAt) : 'Never'}
                tone={pollStale ? 'warning' : undefined}
                hint={s.lastPollAt ? formatDateTime(s.lastPollAt) : 'Connect Gmail in Settings'}
                info="When the app last looked in Gmail for new emails."
              />
            </Grid>
            {s.ingestQueue?.waiting > 0 && (
              <Grid item xs={12}>
                <IngestQueueAlert queue={s.ingestQueue} />
              </Grid>
            )}
            <Grid item xs={12}>
              <SubmissionsOverview byStatus={s.byStatus} byClassification={s.byClassification} period={period} />
            </Grid>
            <Grid item xs={12} ref={usageRef} sx={{ scrollMarginTop: 80 }}>
              <Section title="Usage & errors" tone="info">
                <Tabs
                  value={tab}
                  onChange={(_, v: MonitoringTab) => setParam('tab', v, 'tokens')}
                  variant="scrollable"
                  scrollButtons="auto"
                  sx={{
                    px: 1,
                    borderBottom: 1,
                    borderColor: 'divider',
                    '& .MuiTabs-scrollButtons.Mui-disabled': { opacity: 0.3 },
                  }}
                >
                  <Tab
                    value="tokens"
                    iconPosition="start"
                    icon={<TollIcon fontSize="small" />}
                    label="Token usage"
                    sx={{ minHeight: 48 }}
                  />
                  <Tab
                    value="errors"
                    iconPosition="start"
                    icon={<ErrorIcon fontSize="small" />}
                    sx={{ minHeight: 48 }}
                    label={
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <span>Errors</span>
                        {s.recentErrors.length > 0 && (
                          <Chip
                            size="small"
                            color="error"
                            label={s.recentErrors.length}
                            sx={{ height: 18, fontSize: '0.7rem' }}
                          />
                        )}
                      </Stack>
                    }
                  />
                </Tabs>
                <Box sx={{ p: 2 }}>
                  {tab === 'tokens' ? (
                    <TokenUsageTab key={range} range={range} />
                  ) : (
                    <ErrorsTab errors={s.recentErrors} period={period} />
                  )}
                </Box>
              </Section>
            </Grid>
          </Grid>
        </SectionBands>
      ) : null}
    </Box>
  );
}
