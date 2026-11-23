import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import {
  Alert,
  Avatar,
  Box,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { ErrorState, Loading, Markdown } from '../../../components/common';
import { POLL_MS, TRUNCATION_MARKER } from '../../../constants';
import { formatDateTime } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import type { ChatMessage } from '../../../types';
import { chatKeys } from '../queryKeys';
import { GroundingFootnote } from './GroundingSummary';

const SUGGESTIONS = [
  'Summarize the key risk factors for this applicant.',
  'What information is still missing before we can quote?',
  'Do the NPI registry results match the application?',
];

export function ClaudeChat({ submissionId, onClose }: { submissionId: string; onClose?: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = chatKeys.thread(submissionId);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Answers are written by a background job: the conversation is re-read while one is PENDING.
  const history = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiWith(signal).chat(submissionId),
    refetchInterval: (q) => (q.state.data?.some((m) => m.status === 'PENDING') ? POLL_MS.chatAnswerPending : false),
  });
  const send = useMutation({
    mutationFn: (message: string) => api.sendChat(submissionId, message),
    onMutate: (message) => {
      setPending(message);
      setDraft('');
    },
    onError: (_e, message) => {
      setDraft(message);
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: key });
      setPending(null);
    },
  });

  const messages: ChatMessage[] = history.data ?? [];
  // One question at a time: the next waits until Claude has answered (or failed to answer) the last.
  const waiting = send.isPending || messages.some((m) => m.status === 'PENDING');

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending]);

  const submit = (text?: string) => {
    const m = (text ?? draft).trim();
    if (!m || waiting) return;
    send.mutate(m);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2, py: 1.25, bgcolor: 'primary.main', color: 'primary.contrastText' }}
      >
        <AutoAwesomeIcon fontSize="small" />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="subtitle2">Ask Claude</Typography>
          <Typography variant="caption" sx={{ opacity: 0.8 }}>
            Grounded on the latest reports and evidence
          </Typography>
        </Box>
        {onClose && (
          <IconButton size="small" onClick={onClose} sx={{ color: 'primary.contrastText' }} aria-label="Close chat">
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>
      <Divider />
      <Box ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', p: 1.5, bgcolor: 'background.default' }}>
        {history.isLoading ? (
          <Loading label="Loading conversation…" shape="chat" />
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => history.refetch()} title="Could not load chat" />
        ) : (
          <Stack spacing={1.25}>
            {messages.length === 0 && !pending && (
              <Box sx={{ textAlign: 'center', py: 3, color: 'text.secondary' }}>
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  Ask about this submission. Answers cite the synthesis, analysis and documents.
                </Typography>
                <Stack spacing={0.75}>
                  {SUGGESTIONS.map((s) => (
                    <Paper
                      key={s}
                      variant="outlined"
                      onClick={() => submit(s)}
                      sx={{
                        p: 1,
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                        textAlign: 'left',
                        '&:hover': { borderColor: 'primary.main' },
                      }}
                    >
                      {s}
                    </Paper>
                  ))}
                </Stack>
              </Box>
            )}
            {messages.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
            {pending && (
              <>
                <Bubble
                  m={{
                    id: 'pending',
                    role: 'user',
                    content: pending,
                    createdAt: new Date().toISOString(),
                    userName: user?.name ?? null,
                    status: 'COMPLETED',
                    error: null,
                  }}
                />
                <Thinking />
              </>
            )}
          </Stack>
        )}
      </Box>
      <Divider />
      <Box sx={{ p: 1.5 }}>
        {send.isError && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {errorMessage(send.error)}
          </Alert>
        )}
        <Stack direction="row" spacing={1} alignItems="flex-end">
          <TextField
            fullWidth
            multiline
            maxRows={6}
            placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={waiting}
          />
          <Tooltip title="Send">
            <span>
              <IconButton
                color="primary"
                onClick={() => submit()}
                disabled={!draft.trim() || waiting}
                aria-label="Send message"
              >
                {waiting ? <CircularProgress size={20} /> : <SendIcon />}
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Box>
    </Box>
  );
}

function Thinking() {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary', pl: 0.5 }} role="status">
      <CircularProgress size={14} />
      <Typography variant="caption">Claude is thinking…</Typography>
    </Stack>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const mine = m.role === 'user';
  if (!mine && m.status === 'PENDING') return <Thinking />;
  if (!mine && m.status === 'FAILED') {
    return (
      <Alert severity="error" sx={{ fontSize: '0.8rem' }}>
        Claude could not answer: {m.error ?? 'unknown error'}
      </Alert>
    );
  }
  // The stored answer ends with the server's notice; it is shown as a warning instead of as part of the answer.
  const cut = mine ? -1 : m.content.indexOf(TRUNCATION_MARKER);
  const answer = cut < 0 ? m.content : m.content.slice(0, Math.max(0, m.content.lastIndexOf('---', cut))).trimEnd();
  return (
    <Stack direction={mine ? 'row-reverse' : 'row'} spacing={1} alignItems="flex-start">
      <Avatar sx={{ width: 26, height: 26, fontSize: '0.7rem', bgcolor: mine ? 'secondary.main' : 'primary.main' }}>
        {mine ? (m.userName?.[0]?.toUpperCase() ?? 'U') : <AutoAwesomeIcon sx={{ fontSize: 14 }} />}
      </Avatar>
      <Box sx={{ maxWidth: '85%', minWidth: 0 }}>
        <Paper
          variant="outlined"
          sx={{
            px: 1.5,
            py: 1,
            bgcolor: (t) => (mine ? alpha(t.palette.primary.main, 0.07) : t.palette.background.paper),
            borderColor: mine ? 'transparent' : 'divider',
          }}
        >
          {mine ? (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {m.content}
            </Typography>
          ) : (
            <Markdown>{answer}</Markdown>
          )}
          {cut >= 0 && (
            <Alert severity="warning" sx={{ mt: 1, py: 0, fontSize: '0.75rem' }}>
              This answer was cut off at the maximum length. Ask a narrower follow-up question to see the rest.
            </Alert>
          )}
          {!mine && <GroundingFootnote grounding={m.grounding} />}
        </Paper>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', textAlign: mine ? 'right' : 'left', mt: 0.25, fontSize: '0.65rem' }}
        >
          {mine ? (m.userName ?? 'You') : 'Claude'} · {formatDateTime(m.createdAt)}
        </Typography>
      </Box>
    </Stack>
  );
}
