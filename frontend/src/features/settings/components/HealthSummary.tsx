import CheckCircleIcon from '@mui/icons-material/CheckCircleOutline';
import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router';

import { LAST_POLL_STALE_MS, QUEUE_DEPTH_WARNING } from '../../../constants';
import { formatRelative } from '../../../lib/status';
import { paths } from '../../../paths';
import type { MonitoringStats } from '../../../types';

type Issue = {
  severity: 'error' | 'warning';
  text: string;
  action?: { label: string; to?: string; onClick?: () => void };
};

/** One plain-language answer to "is everything OK?", with a shortcut to each problem. */
export function HealthSummary({
  stats,
  period,
  onShowErrors,
}: {
  stats: MonitoringStats;
  period: string;
  onShowErrors: () => void;
}) {
  const issues: Issue[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const inPeriod = period === 'today' ? 'today' : period === 'all time' ? 'on record' : `in the ${period}`;

  if (stats.failedReports > 0) {
    issues.push({
      severity: 'error',
      text: `${plural(stats.failedReports, 'report')} failed to generate ${inPeriod}.`,
      action: { label: 'View errors', onClick: onShowErrors },
    });
  }
  if (stats.recentErrors.length > 0) {
    issues.push({
      severity: 'error',
      text: `${plural(stats.recentErrors.length, 'error')} recorded ${inPeriod}.`,
      action: { label: 'View errors', onClick: onShowErrors },
    });
  }
  if (stats.queueDepth > QUEUE_DEPTH_WARNING) {
    issues.push({
      severity: 'warning',
      text: `${plural(stats.queueDepth, 'item')} waiting to be processed, so the pipeline is running behind.`,
      action: { label: 'Open inbox', to: `${paths.inbox}?view=submissions` },
    });
  }
  if (!stats.lastPollAt) {
    issues.push({
      severity: 'warning',
      text: 'Gmail has never been checked for new emails.',
      action: { label: 'Open settings', to: paths.settings },
    });
  } else if (Date.now() - new Date(stats.lastPollAt).getTime() > LAST_POLL_STALE_MS) {
    issues.push({
      severity: 'warning',
      text: `Gmail was last checked ${formatRelative(stats.lastPollAt)}. New emails may not be arriving.`,
      action: { label: 'Open settings', to: paths.settings },
    });
  }

  if (!issues.length) {
    return (
      <Alert severity="success" icon={<CheckCircleIcon />} variant="outlined">
        <AlertTitle sx={{ mb: 0 }}>Everything is running normally</AlertTitle>
        <Typography variant="body2" color="text.secondary">
          No errors or failed reports {inPeriod}
          {stats.lastPollAt ? ` · Gmail checked ${formatRelative(stats.lastPollAt)}` : ''}.
        </Typography>
      </Alert>
    );
  }

  const worst = issues.some((i) => i.severity === 'error') ? 'error' : 'warning';
  // One "View errors" button is enough even when both errors and failed reports are listed.
  const seen = new Set<string>();
  return (
    <Alert severity={worst} variant="outlined">
      <AlertTitle>
        {issues.length === 1 ? '1 thing needs attention' : `${issues.length} things need attention`}
      </AlertTitle>
      <Stack spacing={0.75}>
        {issues.map((i) => {
          const showAction = i.action && !seen.has(i.action.label);
          if (i.action) seen.add(i.action.label);
          return (
            <Stack key={i.text} direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
              <Typography variant="body2">{i.text}</Typography>
              {showAction &&
                i.action &&
                (i.action.to ? (
                  <Button size="small" component={RouterLink} to={i.action.to} sx={{ py: 0 }}>
                    {i.action.label}
                  </Button>
                ) : (
                  <Button size="small" onClick={i.action.onClick} sx={{ py: 0 }}>
                    {i.action.label}
                  </Button>
                ))}
            </Stack>
          );
        })}
      </Stack>
    </Alert>
  );
}
