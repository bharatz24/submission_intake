import { Alert, Box, Button, Link } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { duplicateBasisLabel, formatDateTime, mainClassificationReason } from '../../../lib/status';
import { paths } from '../../../paths';
import { api } from '../../../services/api';
import type { SubmissionDetail } from '../../../types';
import { auditKeys } from '../../audit';
import { submissionKeys } from '../queryKeys';

/** Why this email was not processed, with a one-click release; on an original, the copies held back as duplicates. */
export function DuplicateBanners({ s }: { s: SubmissionDetail }) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const qc = useQueryClient();
  const toast = useToast();
  const release = useMutation({
    mutationFn: () =>
      s.status === 'DUPLICATE'
        ? api.setDuplicate(s.id, null, 'Not a duplicate: released from the submission page')
        : api.overrideClassification(s.id, 'SUBMISSION', 'Processed as a submission from the submission page'),
    onSuccess: (d) => {
      toast.success(s.status === 'DUPLICATE' ? TOAST_MESSAGES.duplicateReleased : TOAST_MESSAGES.ignoredReleased);
      qc.setQueryData(submissionKeys.detail(s.id), d);
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
    },
    onError: (err) => toast.error(err),
  });
  const action = (label: string) =>
    writable && (
      <Button
        color="inherit"
        size="small"
        variant="outlined"
        disabled={release.isPending}
        onClick={() => release.mutate()}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {release.isPending ? 'Queuing…' : label}
      </Button>
    );

  return (
    <>
      {s.status === 'DUPLICATE' && s.duplicateOf && (
        <Alert severity="warning" sx={{ mb: 1.5 }} action={action('Not a duplicate, process it')}>
          <b>{s.duplicateBasis?.strength === 'POSSIBLE' ? 'Possible duplicate, please check' : 'Duplicate'}</b> of{' '}
          <Link component={RouterLink} to={paths.submission(s.duplicateOf.id)} color="inherit" fontWeight={600}>
            {s.duplicateOf.subject || '(no subject)'}
          </Link>
          . Not processed.
          <Box sx={{ mt: 0.5 }}>{s.duplicateBasis?.explanation ?? duplicateBasisLabel(s.duplicateBasis)}</Box>
        </Alert>
      )}
      {s.status === 'NOT_SUBMISSION' && (
        <Alert severity="info" sx={{ mb: 1.5 }} action={action('Process as submission')}>
          <b>Ignored</b>: not related to a submission. Not processed.
          {mainClassificationReason(s.classificationReasons) && (
            <Box sx={{ mt: 0.5 }}>Why: {mainClassificationReason(s.classificationReasons)}</Box>
          )}
        </Alert>
      )}
      {s.duplicates.length > 0 && (
        <Alert severity="info" icon={false} sx={{ mb: 1.5 }}>
          Also received {s.duplicates.length === 1 ? 'once more' : `${s.duplicates.length} more times`} (held back as
          duplicates):{' '}
          {s.duplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <Link component={RouterLink} to={paths.submission(d.id)} color="inherit">
                {formatDateTime(d.receivedAt)}
              </Link>
            </span>
          ))}
        </Alert>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Overview
