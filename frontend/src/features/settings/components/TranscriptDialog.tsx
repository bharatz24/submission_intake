// Monitoring > Token usage > a request's "View transcript": what one Claude call sent and returned
// (GET /monitoring/llm-calls/:id/transcript, monitoring:manage; the server audits every view).
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';

import { ErrorState, KeyValue, Loading } from '../../../components/common';
import { formatDateTime, humanize } from '../../../lib/status';
import { ApiError, apiWith } from '../../../services/api';
import { monitoringKeys } from '../queryKeys';

const MONO = 'ui-monospace, Consolas, monospace';
const NOT_STORED = 'Not stored for this call (hash only)';
/** A 404: the call predates transcripts, or its transcript was purged by retention. Retrying cannot help. */
const NOT_RECORDED = 'No transcript was recorded for this call.';

/**
 * Prompt or output text: monospace, wrapped, scrollable within a fixed height. A named, focusable region, so keyboard
 * users can scroll it and screen readers announce which text it is.
 */
function TextBlock({ label, text }: { label: string; text: string | null }) {
  return (
    <Box>
      <Typography variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>
        {label}
      </Typography>
      {text === null ? (
        <Typography variant="body2" color="text.secondary">
          {NOT_STORED}
        </Typography>
      ) : (
        <Box
          component="pre"
          role="region"
          aria-label={label}
          tabIndex={0}
          sx={{
            m: 0,
            p: 1.5,
            maxHeight: 320,
            overflow: 'auto',
            fontFamily: MONO,
            fontSize: '0.75rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            bgcolor: 'action.hover',
            borderRadius: 1,
            '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineStyle: 'solid' },
          }}
        >
          {text}
        </Box>
      )}
    </Box>
  );
}

function Hash({ value }: { value: string }) {
  return (
    <Typography component="span" sx={{ fontFamily: MONO, fontSize: '0.75rem', wordBreak: 'break-all' }}>
      {value}
    </Typography>
  );
}

/** Opens for `callId`; closed when it is null. */
export function TranscriptDialog({ callId, onClose }: { callId: string | null; onClose: () => void }) {
  const transcript = useQuery({
    queryKey: monitoringKeys.transcript(callId ?? ''),
    queryFn: ({ signal }) => apiWith(signal).llmTranscript(callId ?? ''),
    enabled: callId !== null,
    // Every fetch is an audited view: keep what was loaded instead of refetching on focus.
    staleTime: Infinity,
  });
  const t = transcript.data;
  const notRecorded = transcript.error instanceof ApiError && transcript.error.status === 404;
  return (
    <Dialog open={callId !== null} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="transcript-title">
      <DialogTitle id="transcript-title">Claude request transcript</DialogTitle>
      <DialogContent dividers>
        {transcript.isLoading && <Loading label="Loading transcript…" />}
        {notRecorded && (
          <Alert severity="info" variant="outlined">
            {NOT_RECORDED}
          </Alert>
        )}
        {transcript.isError && !notRecorded && (
          <ErrorState
            error={transcript.error}
            onRetry={() => transcript.refetch()}
            title="Could not load the transcript"
          />
        )}
        {t && (
          <Stack spacing={2}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
              <KeyValue label="Task" value={humanize(t.task)} />
              <KeyValue label="Model" value={t.model} />
              <KeyValue label="Time" value={formatDateTime(t.createdAt)} />
            </Box>
            <KeyValue label="System prompt SHA-256" value={<Hash value={t.systemSha256} />} />
            <KeyValue label="Prompt SHA-256" value={<Hash value={t.promptSha256} />} />
            <Typography variant="caption" color="text.secondary">
              The prompt is what Claude received, with personal data already redacted. Full text is kept only for the
              requests the server is set to store; the hashes identify every request.
            </Typography>
            <TextBlock label="Prompt sent" text={t.prompt} />
            <TextBlock label="Output received" text={t.output} />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
