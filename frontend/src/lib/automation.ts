// Settings → Automation modes, shared by the Settings card and the "Manual" hints on a submission's tabs.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../components/feedback/FeedbackProvider';
import { STALE_MS, TOAST_MESSAGES } from '../constants';
import { settingsKeys } from '../features/settings';
import { submissionKeys } from '../features/submissions';
import { api, apiWith } from '../services/api';
import type { AutomationStep, SubmissionStatus } from '../types';

/** The current Auto / Manual mode of each pipeline step (readable by any signed-in user). */
export function useAutomation() {
  return useQuery({
    queryKey: settingsKeys.automation(),
    queryFn: ({ signal }) => apiWith(signal).automationSettings(),
    staleTime: STALE_MS.automation,
  });
}

/**
 * True when `step` is set to Manual, so its output only appears once someone runs it. False while the modes load
 * or fail (the usual empty state shows), and when `hidden` (e.g. a submission held for classification: its banner
 * explains it).
 */
export function useManualStep(step: AutomationStep, hidden = false): boolean {
  const automation = useAutomation();
  return !hidden && automation.data?.[step] === 'MANUAL';
}

/**
 * Whether a submission's extraction / NPI hints stay hidden: held for classification or for Process (their banners
 * explain it), a run already underway, or an email that is not processed at all (duplicate or ignored).
 */
export const pipelineHintHidden = (s: {
  heldForClassification: boolean;
  heldForImport: boolean;
  status: SubmissionStatus;
  processingQueued?: boolean;
}) =>
  s.heldForClassification ||
  s.heldForImport ||
  s.status === 'PROCESSING' ||
  !!s.processingQueued ||
  s.status === 'DUPLICATE' ||
  s.status === 'NOT_SUBMISSION';

/** Re-runs extraction + NPI for a submission (Overview's Workflow card and the Fields tab's Manual hint). */
export function useReprocess(submissionId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.reprocess(submissionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: submissionKeys.detail(submissionId) });
      toast.success(TOAST_MESSAGES.reprocessQueued);
    },
    onError: (err) => toast.error(err),
  });
}

/** Runs the pipeline on an imported email, which was only classified on arrival (the submission's import banner). */
export function useProcessImported(submissionId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.processImported(submissionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: submissionKeys.detail(submissionId) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      toast.success(TOAST_MESSAGES.importProcessQueued);
    },
    onError: (err) => toast.error(err),
  });
}

/** Continues a failed run from its failed step (the submission's error banner). */
export function useRetrySubmission(submissionId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.retrySubmission(submissionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: submissionKeys.detail(submissionId) });
      toast.success(TOAST_MESSAGES.retryQueued);
    },
    onError: (err) => toast.error(err),
  });
}
