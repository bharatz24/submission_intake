import StepFailedIcon from '@mui/icons-material/Cancel';
import StepDoneIcon from '@mui/icons-material/CheckCircle';
import StepPendingIcon from '@mui/icons-material/RadioButtonUnchecked';
import StepSkippedIcon from '@mui/icons-material/RemoveCircleOutline';
import ReplayIcon from '@mui/icons-material/Replay';
import { Alert, AlertTitle, Box, Button, CircularProgress, Collapse, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { useReprocess, useRetrySubmission } from '../../../lib/automation';
import { friendlyProcessingError, pipelineStepLabel } from '../../../lib/pipeline';
import type { StepProgress } from '../../../lib/processingProgress';
import { processingProgress } from '../../../lib/processingProgress';
import type { SubmissionDetail } from '../../../types';

/** One segment per step, filling as the run goes, with the percent and what is running now. */
export function ProcessingProgressBar({ s }: { s: SubmissionDetail }) {
  const { percent, label, steps, reviewable } = processingProgress(s);
  // Counted over the steps that run, so a Manual one does not make the count jump.
  const running = steps.filter((x) => x.state !== 'skipped');
  const active = running.findIndex((x) => x.state === 'active');
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1 }}>
        <Typography variant="h6" component="span" sx={{ fontWeight: 700, lineHeight: 1, minWidth: 48 }}>
          {percent}%
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
          {label}
        </Typography>
        {active >= 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            Step {active + 1} of {running.length}
          </Typography>
        )}
      </Stack>
      <Box
        role="progressbar"
        aria-label="Processing progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%, ${label}`}
        sx={{ display: 'flex', gap: 0.5 }}
      >
        {steps.map((x) => (
          <StepSegment key={x.step} step={x} />
        ))}
      </Box>
      <Box sx={{ display: { xs: 'none', sm: 'flex' }, gap: 0.5, mt: 0.75 }}>
        {steps.map((x) => (
          <StepCaption key={x.step} step={x} />
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
        {reviewable
          ? 'Processing is done: you can review the submission while the reports and quote finish. This page refreshes automatically.'
          : 'This page refreshes automatically.'}
      </Typography>
    </Box>
  );
}

/** A step's track: full when done, filling with a moving shine while running, hatched when the run passed it over. */
function StepSegment({ step }: { step: StepProgress }) {
  return (
    <Box
      sx={(t) => ({
        flex: 1,
        height: 8,
        borderRadius: 4,
        overflow: 'hidden',
        position: 'relative',
        // A wider gap between processing and the automatic reports.
        ml: step.step === 'synthesis' ? 1 : 0,
        bgcolor: step.state === 'failed' ? t.palette.error.main : alpha(t.palette.text.primary, 0.1),
        ...(step.state === 'skipped' && {
          backgroundImage: `repeating-linear-gradient(45deg, ${alpha(t.palette.text.primary, 0.18)} 0 4px, transparent 4px 8px)`,
        }),
      })}
    >
      {(step.state === 'done' || step.state === 'active') && (
        <Box
          sx={(t) => ({
            position: 'absolute',
            inset: 0,
            borderRadius: 4,
            transformOrigin: 'left',
            transform: `scaleX(${step.state === 'done' ? 1 : Math.max(step.fraction, 0.04)})`,
            transition: 'transform 0.6s ease, background-color 0.3s',
            bgcolor: step.state === 'done' ? t.palette.success.main : t.palette.primary.main,
          })}
        />
      )}
      {step.state === 'active' && (
        <Box
          sx={(t) => ({
            position: 'absolute',
            inset: 0,
            background: `linear-gradient(90deg, transparent, ${alpha(t.palette.primary.main, 0.45)}, transparent)`,
            '@keyframes processingShine': {
              from: { transform: 'translateX(-100%)' },
              to: { transform: 'translateX(100%)' },
            },
            animation: 'processingShine 1.6s ease-in-out infinite',
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          })}
        />
      )}
    </Box>
  );
}

/** Steps after processing; when one does not run by itself it is started from its tab. */
const AUTO_STEPS: StepProgress['step'][] = ['synthesis', 'analysis', 'quote'];

function StepCaption({ step }: { step: StepProgress }) {
  const automatic = AUTO_STEPS.includes(step.step);
  const icon = {
    done: <StepDoneIcon sx={{ fontSize: 14 }} color="success" />,
    active: <CircularProgress size={11} thickness={6} />,
    pending: <StepPendingIcon sx={{ fontSize: 14 }} color="disabled" />,
    skipped: <StepSkippedIcon sx={{ fontSize: 14 }} color="disabled" />,
    failed: <StepFailedIcon sx={{ fontSize: 14 }} color="error" />,
  }[step.state];
  const note =
    step.state === 'skipped' ? (automatic ? 'manual' : 'skipped') : step.state === 'failed' ? 'failed' : step.detail;
  const title =
    step.state === 'skipped'
      ? automatic
        ? 'Not run automatically (Manual in Settings → Automation, no Claude API key, or no rate tables). Start it from its tab.'
        : 'Set to Manual in Settings → Automation, so this run passed over it'
      : step.state === 'failed'
        ? 'This step failed: open its tab to see why and run it again.'
        : undefined;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{ flex: 1, minWidth: 0, ml: step.step === 'synthesis' ? 1 : 0 }}
      title={title}
    >
      {icon}
      <Typography
        variant="caption"
        noWrap
        sx={{
          fontWeight: step.state === 'active' ? 600 : 400,
          color:
            step.state === 'failed'
              ? 'error.main'
              : step.state === 'pending' || step.state === 'skipped'
                ? 'text.secondary'
                : 'text.primary',
        }}
      >
        {step.name}
        {note && (
          <Box component="span" sx={{ color: 'text.secondary' }}>
            {' '}
            · {note}
          </Box>
        )}
      </Typography>
    </Stack>
  );
}

/** A failed run, not one underway (queued by a re-run or retry included) or waiting for its automatic retry. */
export const showFailedBanner = (s: SubmissionDetail) =>
  !s.processingQueued &&
  (s.status === 'ERROR' ||
    (!!s.pipeline?.failedStep && !s.pipeline.autoRetrying && s.status !== 'PROCESSING' && s.status !== 'NEW'));

/** Which step failed and why, with a retry that continues from it or a full re-run (writers only). */
export function ProcessingFailedBanner({ s }: { s: SubmissionDetail }) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const retry = useRetrySubmission(s.id);
  const rerun = useReprocess(s.id);
  const failedStep = s.pipeline?.failedStep ?? null;
  // Reviewers see plain words; admins can open the raw error (the server's detail when it sends one).
  const { message, technical } = friendlyProcessingError(s.pipeline?.error ?? s.processingError);
  const detail = s.processingErrorDetail ?? technical;
  const [showDetail, setShowDetail] = useState(false);
  const done = (s.pipeline?.completedSteps ?? []).map(pipelineStepLabel);
  const busy = retry.isPending || rerun.isPending;
  return (
    <Alert
      severity="error"
      sx={{ mb: 1.5 }}
      action={
        writable && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button
              color="inherit"
              size="small"
              variant="outlined"
              startIcon={<ReplayIcon />}
              disabled={busy}
              onClick={() => {
                rerun.reset();
                retry.mutate();
              }}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {retry.isPending ? 'Retrying…' : 'Retry from failed step'}
            </Button>
            <Button
              color="inherit"
              size="small"
              disabled={busy}
              onClick={() => {
                retry.reset();
                rerun.mutate();
              }}
              sx={{ whiteSpace: 'nowrap' }}
            >
              {rerun.isPending ? 'Queuing…' : 'Re-run everything'}
            </Button>
          </Stack>
        )
      }
    >
      <AlertTitle>
        {failedStep ? `Processing failed at ${pipelineStepLabel(failedStep)}` : 'Processing failed'}
      </AlertTitle>
      <Typography variant="body2">{message}</Typography>
      {detail && hasPermission(user, 'submission:view-error-detail') && (
        <>
          <Button
            color="inherit"
            size="small"
            onClick={() => setShowDetail((v) => !v)}
            sx={{ mt: 0.5, px: 0.5, minWidth: 0 }}
          >
            {showDetail ? 'Hide technical details' : 'Technical details'}
          </Button>
          <Collapse in={showDetail}>
            <Box
              component="pre"
              sx={{
                m: 0,
                mt: 0.5,
                maxHeight: 160,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, Consolas, monospace',
                fontSize: '0.75rem',
              }}
            >
              {detail}
            </Box>
          </Collapse>
        </>
      )}
      {done.length > 0 && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          Already done: {done.join(', ')}
        </Typography>
      )}
    </Alert>
  );
}

// ---------------------------------------------------------------- Duplicate / ignored banners
