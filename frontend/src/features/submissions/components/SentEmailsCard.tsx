// Replies and forwards sent from this submission, newest first.
import { Box, Chip, Collapse, Link, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ErrorState, SectionCard } from '../../../components/common';
import { friendlyMessage } from '../../../lib/friendlyError';
import { formatDateTime } from '../../../lib/status';
import { apiWith } from '../../../services/api';
import type { OutboundMode, SubmissionDetail } from '../../../types';
import { outboundKeys } from '../queryKeys';

const MODE_LABEL: Record<OutboundMode, string> = { REPLY: 'Reply', REPLY_ALL: 'Reply all', FORWARD: 'Forward' };

export function SentEmailsCard({ s }: { s: SubmissionDetail }) {
  const sent = useQuery({
    queryKey: outboundKeys.list(s.id),
    queryFn: ({ signal }) => apiWith(signal).outboundEmails(s.id),
  });
  const [open, setOpen] = useState<string | null>(null);
  if (!sent.data?.length && !sent.isError) return null;
  const docName = (id: string) => s.documents.find((d) => d.id === id)?.filename ?? 'document';

  return (
    <SectionCard
      title="Sent from this submission"
      tone="secondary"
      subtitle="Replies and forwards sent from the monitored mailbox."
      dense
    >
      {sent.isError && (
        <ErrorState error={sent.error} onRetry={() => sent.refetch()} title="Could not load sent emails" />
      )}
      <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
        {sent.data?.map((m) => (
          <Box key={m.id} sx={{ py: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip
                size="small"
                variant="outlined"
                color={m.mode === 'FORWARD' ? 'secondary' : 'primary'}
                label={MODE_LABEL[m.mode]}
              />
              {m.status === 'FAILED' && (
                <Chip
                  size="small"
                  color="error"
                  label="Not sent"
                  title={m.error ? friendlyMessage(m.error) : undefined}
                />
              )}
              {m.status === 'PENDING' && (
                <Chip
                  size="small"
                  color="warning"
                  label="Sending / unconfirmed"
                  title="Handed to Gmail, but the result was not recorded. Check the mailbox's Sent folder before sending again."
                />
              )}
              <Link
                component="button"
                type="button"
                variant="body2"
                fontWeight={600}
                underline="hover"
                onClick={() => setOpen((o) => (o === m.id ? null : m.id))}
                sx={{ textAlign: 'left' }}
              >
                {m.subject}
              </Link>
              <Typography variant="caption" color="text.secondary">
                to {m.to.join(', ')}
                {m.cc.length ? ` · cc ${m.cc.join(', ')}` : ''} · {m.sentBy.name} · {formatDateTime(m.sentAt)}
              </Typography>
            </Stack>
            {m.status === 'FAILED' && m.error && (
              <Typography variant="caption" color="error" component="div" sx={{ mt: 0.25 }}>
                {friendlyMessage(m.error)}
              </Typography>
            )}
            {m.documentIds.length > 0 && (
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
                Attached: {m.documentIds.map(docName).join(', ')}
              </Typography>
            )}
            <Collapse in={open === m.id} unmountOnExit>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  mt: 1,
                  p: 1.25,
                  bgcolor: 'surface.subtle',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'inherit',
                  fontSize: '0.8rem',
                  maxHeight: 260,
                  overflow: 'auto',
                }}
              >
                {m.body || '(no message)'}
              </Box>
            </Collapse>
          </Box>
        ))}
      </Stack>
    </SectionCard>
  );
}
