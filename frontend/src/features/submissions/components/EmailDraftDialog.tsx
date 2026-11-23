// Draft Email: pick Broker, Insured or Quote and click Generate; only then is the API (Claude, Haiku) called, from the
// latest completed analysis (backend services/emailDraft.ts). Opening the dialog or changing the dropdown only reads the
// last saved draft for that audience; it never generates one. Generating runs as a background job: the dialog polls
// until the run finishes (or fails, with the reason shown).
// Drafts are only for editing and copying: nothing here sends email.
import CloseIcon from '@mui/icons-material/Close';
import CopyIcon from '@mui/icons-material/ContentCopyOutlined';
import BoldIcon from '@mui/icons-material/FormatBold';
import BulletIcon from '@mui/icons-material/FormatListBulleted';
import NumberIcon from '@mui/icons-material/FormatListNumbered';
import HighlightIcon from '@mui/icons-material/HighlightOutlined';
import ReplayIcon from '@mui/icons-material/Replay';
import TableIcon from '@mui/icons-material/TableChartOutlined';
import HeadingIcon from '@mui/icons-material/TitleOutlined';
import PreviewOffIcon from '@mui/icons-material/VisibilityOffOutlined';
import PreviewIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { Markdown } from '../../../components/common';
import { DEBOUNCE_MS, POLL_MS } from '../../../constants';
import type { FormatKind } from '../../../lib/emailFormat';
import { applyFormat, emailHtml, remarkHighlight, toMarkdown } from '../../../lib/emailFormat';
import { formatDateTime, humanize } from '../../../lib/status';
import { api, apiWith, errorMessage } from '../../../services/api';
import { tokens } from '../../../theme';
import type { EmailAudience, EmailDraft, EmailDraftState } from '../../../types';
import { emailDraftKeys, quoteKeys } from '../queryKeys';

const AUDIENCES: { key: EmailAudience; label: string }[] = [
  { key: 'broker', label: 'Broker' },
  { key: 'insured', label: 'Insured' },
  { key: 'quote', label: 'Quote' },
];
// Grouped like a mail compose toolbar: structure | emphasis | lists | table. A divider sits between groups.
const TOOL_GROUPS: { kind: FormatKind; title: string; icon: ReactNode }[][] = [
  [{ kind: 'heading', title: 'Heading', icon: <HeadingIcon fontSize="small" /> }],
  [
    { kind: 'bold', title: 'Bold', icon: <BoldIcon fontSize="small" /> },
    { kind: 'highlight', title: 'Highlight', icon: <HighlightIcon fontSize="small" /> },
  ],
  [
    { kind: 'bullet', title: 'Bullet list', icon: <BulletIcon fontSize="small" /> },
    { kind: 'number', title: 'Numbered list', icon: <NumberIcon fontSize="small" /> },
  ],
  [{ kind: 'table', title: 'Insert table', icon: <TableIcon fontSize="small" /> }],
];
const labelOf = (a: EmailAudience) => AUDIENCES.find((x) => x.key === a)!.label;

export function EmailDraftDialog({
  submissionId,
  open,
  onClose,
}: {
  submissionId: string;
  open: boolean;
  onClose: () => void;
}) {
  return open ? <Drafts submissionId={submissionId} onClose={onClose} /> : null;
}

function Drafts({ submissionId, onClose }: { submissionId: string; onClose: () => void }) {
  const [audience, setAudience] = useState<EmailAudience>('broker');
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const qc = useQueryClient();
  // The last saved draft per audience comes from the server, so closing and reopening the dialog shows it again.
  // Edits are kept per draft id while the dialog is open; generating again makes a new draft and so drops them.
  const [edits, setEdits] = useState<Record<string, EmailDraft>>({});
  const key = (a: EmailAudience) => emailDraftKeys.latest(submissionId, a);

  // The Quote tab is usable only once a quote exists (same data as the quotes card in the Analysis tab).
  const quotes = useQuery({
    queryKey: quoteKeys.list(submissionId),
    queryFn: ({ signal }) => apiWith(signal).quotes(submissionId),
  });
  // Same quote the email is written from: the primary rating, else the first. An INCOMPLETE quote is not ready to present.
  const quote = quotes.data?.find((x) => x.isPrimary) ?? quotes.data?.[0];
  const quoteReady = !!quote && quote.status !== 'INCOMPLETE';
  const tabDisabled = (a: EmailAudience) => (busy && a !== audience) || (a === 'quote' && !quoteReady);

  const saved = useQuery({
    queryKey: key(audience),
    queryFn: ({ signal }) => apiWith(signal).latestEmailDraft(submissionId, audience),
    refetchInterval: (q) => (q.state.data?.run?.status === 'PENDING' ? POLL_MS.emailDraftRunning : false),
  });
  const generate = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (a: EmailAudience) => api.draftEmail(submissionId, a),
    onSuccess: (r, a) => qc.setQueryData(key(a), r),
  });
  const run = saved.data?.run ?? null;
  const busy = generate.isPending || run?.status === 'PENDING';
  const loading = saved.isPending;
  const latest = saved.data?.draft ?? null;
  const shown = busy ? null : latest;
  // The newest generation failed: its reason is shown above the last completed draft (if any).
  const runError = !busy && run?.status === 'FAILED' ? (run.error ?? 'The draft could not be generated') : null;
  const edit = shown ? (edits[shown.id] ?? shown.draft) : null;

  // Manual edits are saved onto the draft shortly after typing stops (and on close), so they survive reopening.
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (v: { id: string; audience: EmailAudience; subject: string; body: string }) =>
      api.saveEmailDraft(submissionId, v.id, { subject: v.subject, body: v.body }),
    onSuccess: (r, v) =>
      qc.setQueryData(key(v.audience), (s: EmailDraftState | undefined) => (s ? { ...s, draft: r } : s)),
  });
  const dirty = !!shown && !!edit && (edit.subject !== shown.draft.subject || edit.body !== shown.draft.body);
  const pending =
    shown && edit && dirty ? { id: shown.id, audience: shown.audience, subject: edit.subject, body: edit.body } : null;
  const saveMutate = save.mutate;
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => saveMutate(pending), DEBOUNCE_MS.draftAutosave);
    return () => clearTimeout(t);
    // `pending` is a new object every render; its id, subject and body are what it holds (the audience follows the
    // id), so the autosave restarts only when the text changes. saveMutate is TanStack's stable mutate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id, pending?.subject, pending?.body]);
  const close = () => {
    if (pending) saveMutate(pending);
    onClose();
  };

  const set = (k: 'subject' | 'body', v: string) => {
    if (!shown || !edit) return;
    setCopied(false);
    setEdits((e) => ({ ...e, [shown.id]: { ...edit, [k]: v } }));
  };
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Toolbar buttons edit the Markdown around the cursor/selection, then put the selection back on the result.
  const format = (kind: FormatKind) => {
    const ta = bodyRef.current;
    if (!ta || !edit) return;
    const r = applyFormat(edit.body, ta.selectionStart, ta.selectionEnd, kind);
    set('body', r.value);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.start, r.end);
    });
  };
  const copy = async () => {
    if (!edit) return;
    const plain = `Subject: ${edit.subject}\n\n${edit.body}`;
    try {
      // Rich copy (HTML + plain text) so tables, bullets and highlights paste into Gmail/Outlook as formatted text.
      if (previewRef.current && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([emailHtml(previewRef.current, edit.subject)], { type: 'text/html' }),
            'text/plain': new Blob([plain], { type: 'text/plain' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      setCopied(true);
    } catch {
      /* clipboard blocked: the text can still be selected by hand */
    }
  };

  return (
    <Dialog open onClose={close} fullWidth maxWidth="lg">
      <DialogTitle sx={{ pb: 1, pr: 7 }}>
        <IconButton aria-label="Close" onClick={close} size="small" sx={{ position: 'absolute', right: 12, top: 12 }}>
          <CloseIcon />
        </IconButton>
        Draft email
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {shown
            ? `${labelOf(shown.audience)} draft generated ${formatDateTime(shown.createdAt)}${shown.createdBy ? ` by ${shown.createdBy.name}` : ''} · Based on Analysis v${shown.analysisVersion} (Synthesis v${shown.synthesisVersion}) · ${humanize(shown.purpose)} · ${shown.model}`
            : 'Choose who the email is for, then click Generate. Based on the latest completed analysis'}
          {' · '}Review and edit before using. Nothing is sent from here.
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: 360 }}>
        {/* Hero band: audience tabs across the top, with the draft actions on the same row. */}
        <Box
          sx={{
            mx: -3,
            mt: -2,
            mb: 2,
            px: 3,
            pt: 1.5,
            bgcolor: (t) => alpha(t.palette.primary.main, 0.05),
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.5 }}>
            Email for
          </Typography>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
            <Tabs
              value={audience}
              onChange={(_, v: EmailAudience) => {
                if (busy) return;
                setAudience(v);
                setCopied(false);
                generate.reset();
              }}
              aria-label="Email audience"
            >
              {AUDIENCES.map((a) => (
                <Tab key={a.key} value={a.key} label={a.label} disabled={tabDisabled(a.key)} />
              ))}
            </Tabs>
            <Box sx={{ flexGrow: 1 }} />
            {/* One button: Generate while this audience has no saved draft, Regenerate once it has one. */}
            <Button
              size="small"
              variant={latest ? 'outlined' : 'contained'}
              startIcon={latest ? <ReplayIcon /> : undefined}
              onClick={() => {
                setCopied(false);
                generate.mutate(audience);
              }}
              disabled={busy || loading}
            >
              {latest ? 'Regenerate' : 'Generate'}
            </Button>
            <Button size="small" startIcon={<CopyIcon />} onClick={copy} disabled={!shown}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </Stack>
        </Box>
        {busy && (
          <Stack alignItems="center" spacing={1.5} sx={{ py: 8, color: 'text.secondary' }}>
            <CircularProgress size={28} />
            <Typography variant="body2">Claude is drafting the {labelOf(audience).toLowerCase()} email…</Typography>
          </Stack>
        )}
        {!busy && !loading && saved.error && !generate.error && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {errorMessage(saved.error)}
          </Alert>
        )}
        {!busy && generate.error && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {errorMessage(generate.error)}
          </Alert>
        )}
        {!generate.error && runError && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            Could not draft the email: {runError}
          </Alert>
        )}
        {!busy && !loading && !saved.error && !generate.error && !runError && !shown && (
          <Stack alignItems="center" sx={{ py: 8, color: 'text.secondary' }}>
            <Typography variant="body2">
              No {labelOf(audience).toLowerCase()} email drafted yet. Click Generate to create one.
            </Typography>
          </Stack>
        )}
        {shown && edit && (
          <>
            {shown.newerAnalysisVersion && (
              <Alert severity="info" sx={{ mb: 1.5 }}>
                Analysis v{shown.newerAnalysisVersion} is newer than the one this draft was written from. Generate again
                to update it.
              </Alert>
            )}
            {!shown.newerAnalysisVersion && shown.stale && (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                The submission changed after this analysis ran. Re-run the analysis for a draft that reflects the latest
                evidence.
              </Alert>
            )}
            <Stack spacing={1.5}>
              <TextField
                label="Subject"
                size="small"
                value={edit.subject}
                onChange={(e) => set('subject', e.target.value)}
              />
              {/* Formatting bar: soft rounded strip with grouped icon buttons, like a mail compose window. */}
              <Stack
                direction="row"
                alignItems="center"
                flexWrap="wrap"
                role="toolbar"
                aria-label="Formatting"
                sx={{
                  gap: 0.25,
                  px: 0.75,
                  py: 0.5,
                  minHeight: 40,
                  borderRadius: 5,
                  bgcolor: 'surface.tint',
                  border: 1,
                  borderColor: 'transparent',
                }}
              >
                {TOOL_GROUPS.map((group, gi) => (
                  <Stack key={gi} direction="row" alignItems="center" sx={{ gap: 0.25 }}>
                    {gi > 0 && (
                      <Box aria-hidden sx={{ width: '1px', height: 20, mx: 0.75, bgcolor: alpha(tokens.ink, 0.25) }} />
                    )}
                    {group.map((t) => (
                      <Tooltip key={t.kind} title={t.title} arrow>
                        <IconButton
                          size="small"
                          aria-label={t.title}
                          onClick={() => format(t.kind)}
                          sx={{
                            width: 32,
                            height: 32,
                            borderRadius: 1.5,
                            color: 'ink.main',
                            '&:hover': { bgcolor: alpha(tokens.ink, 0.12) },
                            '&:active, &:focus-visible': { bgcolor: alpha(tokens.ink, 0.2) },
                            '& svg': { fontSize: '1.3rem' },
                          }}
                        >
                          {t.icon}
                        </IconButton>
                      </Tooltip>
                    ))}
                  </Stack>
                ))}
                <Box sx={{ flexGrow: 1 }} />
                {/* Preview is off by default; the rendered copy stays in the page (hidden) so Copy can still paste rich text. */}
                <Button
                  size="small"
                  aria-pressed={showPreview}
                  onClick={() => setShowPreview((v) => !v)}
                  startIcon={showPreview ? <PreviewOffIcon /> : <PreviewIcon />}
                  sx={{
                    borderRadius: 4,
                    px: 1.5,
                    textTransform: 'none',
                    color: 'ink.main',
                    fontWeight: 600,
                    bgcolor: showPreview ? alpha(tokens.ink, 0.12) : 'transparent',
                    '&:hover': { bgcolor: alpha(tokens.ink, 0.16) },
                  }}
                >
                  {showPreview ? 'Hide preview' : 'Preview'}
                </Button>
              </Stack>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: showPreview ? '1fr 1fr' : '1fr' },
                  gap: 1.5,
                }}
              >
                <TextField
                  label="Body"
                  multiline
                  minRows={14}
                  value={edit.body}
                  inputRef={bodyRef}
                  onChange={(e) => set('body', e.target.value)}
                  sx={{
                    '& textarea': {
                      fontFamily: 'ui-monospace, Consolas, monospace',
                      fontSize: '0.8125rem',
                      lineHeight: 1.6,
                    },
                  }}
                />
                <Box sx={{ display: showPreview ? 'block' : 'none' }}>
                  <Typography variant="caption" color="text.secondary">
                    Preview
                  </Typography>
                  <Box
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                      p: 2,
                      minHeight: 330,
                      bgcolor: 'background.paper',
                      overflow: 'auto',
                      '& p': { my: 1 },
                    }}
                  >
                    <Markdown plugins={[remarkHighlight]} innerRef={previewRef}>
                      {toMarkdown(edit.body)}
                    </Markdown>
                  </Box>
                </Box>
              </Box>
              <Typography
                variant="caption"
                color={save.isError ? 'error' : 'text.secondary'}
                role="status"
                sx={{ alignSelf: 'flex-end' }}
              >
                {save.isError
                  ? `Could not save changes: ${errorMessage(save.error)}`
                  : dirty || save.isPending
                    ? 'Saving changes…'
                    : save.isSuccess
                      ? 'Changes saved'
                      : ''}
              </Typography>
            </Stack>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
