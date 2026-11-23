// Reply, Reply all and Forward from a submission, sent from the monitored Gmail mailbox.
// Starting fields come from composeDefaults (lib/email.ts); the server repeats every check.
import SendIcon from '@mui/icons-material/SendOutlined';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useToast } from '../../../components/feedback/FeedbackProvider';
import { STALE_MS, TOAST_MESSAGES } from '../../../constants';
import { UnsavedChangesGuard, useDiscardGuard } from '../../../hooks/useUnsavedChanges';
import {
  composeDefaults,
  type ComposeDraft,
  isValidEmail,
  parseAddress,
  splitAddressList,
  validateCompose,
} from '../../../lib/email';
import { outboundAttachmentLimit, useLimits } from '../../../lib/limits';
import { formatBytes, formatDateTime } from '../../../lib/status';
import { api, ApiError, apiWith, errorMessage } from '../../../services/api';
import type { OutboundMode, SubmissionDetail } from '../../../types';
import { auditKeys } from '../../audit';
import { gmailKeys } from '../../settings';
import { outboundKeys } from '../queryKeys';

const TITLES: Record<OutboundMode, string> = { REPLY: 'Reply', REPLY_ALL: 'Reply all', FORWARD: 'Forward' };

export function EmailComposeDialog({
  s,
  mode,
  onClose,
}: {
  s: SubmissionDetail;
  mode: OutboundMode | null;
  onClose: () => void;
}) {
  return mode ? <Compose key={mode} s={s} mode={mode} onClose={onClose} /> : null;
}

function Compose({ s, mode, onClose }: { s: SubmissionDetail; mode: OutboundMode; onClose: () => void }) {
  const qc = useQueryClient();
  const gmail = useQuery({
    queryKey: gmailKeys.status(),
    queryFn: ({ signal }) => apiWith(signal).gmailStatus(),
    staleTime: STALE_MS.gmailStatusCompose,
  });
  const viaMcp = gmail.data?.source === 'MCP';
  const [draft, setDraft] = useState<ComposeDraft>(() =>
    composeDefaults(mode, s.email, {
      mailbox: gmail.data?.email ?? null,
      documentIds: s.documents.map((d) => d.id),
      formatDate: formatDateTime,
    }),
  );
  const [showBcc, setShowBcc] = useState(false);
  // Changed by the user (not just the automatic Cc/attachment tidy-ups below): closing then asks first.
  const [edited, setEdited] = useState(false);

  // The mailbox address may load after the dialog opens; drop it from Cc once known.
  useEffect(() => {
    const mailbox = gmail.data?.email?.toLowerCase();
    if (mailbox) setDraft((d) => ({ ...d, cc: d.cc.filter((a) => parseAddress(a).address.toLowerCase() !== mailbox) }));
  }, [gmail.data?.email]);
  // Gmail over MCP sends no attachments.
  useEffect(() => {
    if (viaMcp) setDraft((d) => (d.documentIds.length ? { ...d, documentIds: [] } : d));
  }, [viaMcp]);

  const attachmentBytes = useMemo(
    () => s.documents.filter((d) => draft.documentIds.includes(d.id)).reduce((n, d) => n + d.sizeBytes, 0),
    [s.documents, draft.documentIds],
  );
  const maxAttachmentBytes = outboundAttachmentLimit(useLimits().data);
  const overLimit = maxAttachmentBytes != null && attachmentBytes > maxAttachmentBytes;
  const check = validateCompose(draft, attachmentBytes, gmail.data?.connected ?? false, maxAttachmentBytes);

  // One key per opened dialog: a retry after a timeout or network error returns the email already sent instead of
  // sending it twice (the server stores the key with the email).
  const [idempotencyKey] = useState(newIdempotencyKey);
  const toast = useToast();
  const send = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.sendEmail(s.id, { mode, ...draft, idempotencyKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: outboundKeys.list(s.id) });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
      toast.success(TOAST_MESSAGES.emailSent(draft.to));
      onClose();
    },
  });

  const set = <K extends keyof ComposeDraft>(k: K, v: ComposeDraft[K]) => {
    setEdited(true);
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const dirty = edited && !send.isPending && !send.isSuccess;
  const discard = useDiscardGuard(dirty);
  const toggleDoc = (id: string) =>
    set(
      'documentIds',
      draft.documentIds.includes(id) ? draft.documentIds.filter((x) => x !== id) : [...draft.documentIds, id],
    );
  const noThread = mode !== 'FORWARD' && !s.email.gmailMessageId;

  return (
    <Dialog open onClose={() => !send.isPending && discard(onClose)} fullWidth maxWidth="md">
      <UnsavedChangesGuard when={dirty} />
      <DialogTitle>
        {TITLES[mode]}:{' '}
        <Typography component="span" color="text.secondary">
          {s.subject || '(no subject)'}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.75}>
          {gmail.data && !gmail.data.connected && (
            <Alert severity="error">
              Gmail is not connected, so mail cannot be sent. An admin can connect it in Settings.
            </Alert>
          )}
          {gmail.isError && (
            <Alert severity="error">Could not check the Gmail connection: {errorMessage(gmail.error)}</Alert>
          )}
          {noThread && (
            <Alert severity="info">
              This submission was not received through Gmail, so the reply starts a new email thread.
            </Alert>
          )}
          {send.isError && <SendError error={send.error} />}
          <Typography variant="caption" color="text.secondary">
            From {gmail.data?.email ?? 'the monitored Gmail mailbox'}
          </Typography>
          <AddressField
            label="To"
            value={draft.to}
            onChange={(v) => set('to', v)}
            autoFocus={mode === 'FORWARD'}
            action={
              !showBcc && (
                <Link component="button" type="button" variant="caption" onClick={() => setShowBcc(true)}>
                  Bcc
                </Link>
              )
            }
          />
          <AddressField label="Cc" value={draft.cc} onChange={(v) => set('cc', v)} />
          {showBcc && <AddressField label="Bcc" value={draft.bcc} onChange={(v) => set('bcc', v)} />}
          <TextField
            label="Subject"
            value={draft.subject}
            onChange={(e) => set('subject', e.target.value)}
            fullWidth
            error={!draft.subject.trim()}
            helperText={!draft.subject.trim() ? 'A subject is required' : undefined}
          />
          <TextField
            label="Message"
            value={draft.body}
            onChange={(e) => set('body', e.target.value)}
            fullWidth
            multiline
            minRows={8}
            maxRows={20}
            autoFocus={mode !== 'FORWARD'}
            inputProps={{ sx: { fontSize: '0.85rem' } }}
            onFocus={(e) => {
              if (mode !== 'FORWARD' && e.target.selectionStart === e.target.value.length)
                e.target.setSelectionRange(0, 0);
            }}
          />

          {s.documents.length > 0 && (
            <Box>
              <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                <Typography variant="subtitle2">Attachments</Typography>
                <Typography variant="caption" color={overLimit ? 'error' : 'text.secondary'}>
                  {formatBytes(attachmentBytes)}
                  {maxAttachmentBytes != null && ` of ${formatBytes(maxAttachmentBytes)}`}
                </Typography>
              </Stack>
              {viaMcp ? (
                <Typography variant="caption" color="text.secondary">
                  Gmail is connected through MCP, which cannot send attachments.
                </Typography>
              ) : (
                <Stack>
                  {s.documents.map((d) => (
                    <FormControlLabel
                      key={d.id}
                      sx={{ mr: 0 }}
                      control={
                        <Checkbox
                          size="small"
                          checked={draft.documentIds.includes(d.id)}
                          onChange={() => toggleDoc(d.id)}
                        />
                      }
                      label={
                        <Typography variant="body2">
                          {d.filename}{' '}
                          <Typography component="span" variant="caption" color="text.secondary">
                            ({formatBytes(d.sizeBytes)})
                          </Typography>
                        </Typography>
                      }
                    />
                  ))}
                </Stack>
              )}
              {overLimit && (
                <Typography variant="caption" color="error">
                  Attachments are over Gmail&apos;s limit. Remove some to send.
                </Typography>
              )}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3 }}>
        <Typography variant="caption" color="error">
          {!send.isPending && check.errors.filter((e) => !e.startsWith('Gmail')).join(' ')}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button onClick={() => discard(onClose)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            disabled={!check.ok || send.isPending}
            onClick={() => send.mutate()}
          >
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** The server's reason, with the allowed domains spelled out when recipients fall outside OUTBOUND_ALLOWED_DOMAINS. */
function SendError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'RECIPIENT_NOT_ALLOWED') {
    const d = (error.details ?? {}) as { rejected?: string[]; allowedDomains?: string[] };
    return (
      <Alert severity="error">
        These recipients are outside the domains this mailbox may send to: <b>{d.rejected?.join(', ')}</b>.
        {d.allowedDomains?.length ? <> Allowed domains: {d.allowedDomains.join(', ')}.</> : null} Remove them, or ask an
        admin to allow the domain.
      </Alert>
    );
  }
  if (error instanceof ApiError && error.code === 'SEND_IN_PROGRESS') {
    return <Alert severity="warning">{error.message}</Alert>;
  }
  return <Alert severity="error">{errorMessage(error)}</Alert>;
}

/** Address chips: type and press Enter, comma or Tab, or paste a list. Invalid addresses show as red chips. */
function AddressField({
  label,
  value,
  onChange,
  autoFocus,
  action,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
  action?: ReactNode;
}) {
  const [input, setInput] = useState('');
  const commit = (raw: string) => {
    const added = splitAddressList(raw).filter((a) => !value.some((v) => v.toLowerCase() === a.toLowerCase()));
    if (added.length) onChange([...value, ...added]);
    setInput('');
  };
  const invalid = value.filter((a) => !isValidEmail(a));
  return (
    <Autocomplete
      multiple
      freeSolo
      options={[]}
      value={value}
      inputValue={input}
      onChange={(_, v) => onChange((v as string[]).flatMap(splitAddressList))}
      onInputChange={(_, v, reason) => {
        if (reason === 'reset') return;
        if (/[,;]\s*$/.test(v)) commit(v);
        else setInput(v);
      }}
      renderTags={(tags, getTagProps) =>
        tags.map((t, i) => {
          const { key, ...props } = getTagProps({ index: i });
          return (
            <Chip
              key={key}
              {...props}
              size="small"
              label={t}
              color={isValidEmail(t) ? 'default' : 'error'}
              variant={isValidEmail(t) ? 'filled' : 'outlined'}
            />
          );
        })
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          autoFocus={autoFocus}
          placeholder={value.length ? '' : 'name@example.com'}
          onBlur={() => input.trim() && commit(input)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[,;\n]/.test(text)) {
              e.preventDefault();
              commit(`${input}${text.replace(/\n/g, ',')}`);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && input.trim()) commit(input);
          }}
          error={invalid.length > 0}
          helperText={invalid.length ? `Not a valid address: ${invalid.join(', ')}` : undefined}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {action}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
}
