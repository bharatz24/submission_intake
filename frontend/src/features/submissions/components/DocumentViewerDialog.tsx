// In-app viewer for stored documents: PDFs and raster images render inline (SVG is download-only), text shows as text,
// anything else shows a "preview not supported" notice with a download button.
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import PreviewOffIcon from '@mui/icons-material/VisibilityOffOutlined';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';

import { Loading } from '../../../components/common';
import { formatBytes } from '../../../lib/status';
import { ApiError, downloadDocument, errorMessage, fetchDocumentForView } from '../../../services/api';
import type { DocumentInfo } from '../../../types';

// Raster formats only. SVG is XML that can carry scripts and links: rendering it from a same-origin blob URL
// (or someone opening that URL in a tab) would run it with the app's origin, so SVG is download-only.
const PREVIEWABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

// A PDF's header must appear in its first 1024 bytes (PDF 32000-1, 7.5.2).
const PDF_HEADER = '%PDF-';
const PDF_HEADER_WINDOW = 1024;

/** True when the bytes really start like a PDF, whatever type the server labelled them with. */
export async function looksLikePdf(blob: Blob): Promise<boolean> {
  return (await blob.slice(0, PDF_HEADER_WINDOW).text()).includes(PDF_HEADER);
}

/** How a fetched document can be shown inline, or null when it can only be downloaded. */
export function previewKind(mimeType: string): 'pdf' | 'image' | null {
  const type = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  return PREVIEWABLE_IMAGES.has(type) ? 'image' : null;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'pdf' | 'image'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string; retryable: boolean };

export function DocumentViewerDialog({ doc, onClose }: { doc: DocumentInfo | null; onClose: () => void }) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Bumped by "Retry" to fetch the document again after a storage outage.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!doc) return;
    let url: string | null = null;
    let cancelled = false;
    setState({ kind: 'loading' });
    setDownloadError(null);
    fetchDocumentForView(doc.id)
      .then(async (blob) => {
        if (cancelled) return;
        if (blob.type.startsWith('text/')) {
          const text = await blob.text();
          if (!cancelled) setState({ kind: 'text', text });
          return;
        }
        const kind = previewKind(blob.type);
        // A file labelled PDF that isn't one is only offered for download, never handed to the frame.
        if (!kind || (kind === 'pdf' && !(await looksLikePdf(blob)))) {
          if (!cancelled) setState({ kind: 'unsupported' });
          return;
        }
        if (cancelled) return;
        // Re-typed to the bare checked type, so the blob URL can only ever render as a PDF or an image.
        const type = kind === 'pdf' ? 'application/pdf' : (blob.type.split(';')[0] ?? '').trim().toLowerCase();
        // slice() re-types without copying the bytes.
        url = URL.createObjectURL(blob.slice(0, blob.size, type));
        setState({ kind, url });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'PREVIEW_UNSUPPORTED') {
          setState({ kind: 'unsupported' });
          return;
        }
        const storageDown = err instanceof ApiError && err.code === 'STORAGE_UNAVAILABLE';
        setState({ kind: 'error', retryable: storageDown, message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc, attempt]);

  const download = async () => {
    if (!doc) return;
    setDownloadError(null);
    try {
      await downloadDocument(doc.id, doc.filename);
    } catch (err) {
      setDownloadError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={!!doc}
      onClose={onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="lg"
      PaperProps={{ sx: { height: fullScreen ? '100%' : '90vh' } }}
    >
      {doc && (
        <>
          <DialogTitle sx={{ pr: 6 }}>
            <Typography variant="subtitle1" fontWeight={600} noWrap title={doc.filename}>
              {doc.filename}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {doc.mimeType} · {formatBytes(doc.sizeBytes)}
              {doc.pageCount ? ` · ${doc.pageCount} pages` : ''}
            </Typography>
            <IconButton onClick={onClose} aria-label="Close viewer" sx={{ position: 'absolute', right: 8, top: 8 }}>
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent dividers sx={{ p: 0, display: 'flex', flexDirection: 'column', bgcolor: 'surface.canvas' }}>
            {downloadError && (
              <Alert severity="error" sx={{ m: 1.5 }} onClose={() => setDownloadError(null)}>
                {downloadError}
              </Alert>
            )}
            <ViewerBody state={state} doc={doc} onDownload={download} onRetry={() => setAttempt((n) => n + 1)} />
          </DialogContent>
          <DialogActions>
            <Button startIcon={<DownloadIcon />} onClick={download}>
              Download original
            </Button>
            <Button variant="contained" onClick={onClose}>
              Close
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

function ViewerBody({
  state,
  doc,
  onDownload,
  onRetry,
}: {
  state: ViewState;
  doc: DocumentInfo;
  onDownload: () => void;
  onRetry: () => void;
}) {
  switch (state.kind) {
    case 'loading':
      return (
        <Box sx={{ m: 'auto' }}>
          <Loading label="Loading document…" shape="document" />
        </Box>
      );
    case 'pdf':
      // No `sandbox` attribute: Chrome refuses to show a PDF in a sandboxed frame. The frame is safe without it
      // because the blob was checked to be a PDF and re-typed application/pdf, so the browser's PDF viewer renders
      // it and it can never load as an HTML page in the app's origin.
      return (
        <Box
          component="iframe"
          src={state.url}
          title={doc.filename}
          referrerPolicy="no-referrer"
          sx={{ flex: 1, width: '100%', border: 0 }}
        />
      );
    case 'image':
      return (
        <Box
          sx={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', p: 2 }}
        >
          <Box
            component="img"
            src={state.url}
            alt={doc.filename}
            sx={{ maxWidth: '100%', boxShadow: 1, bgcolor: 'background.paper' }}
          />
        </Box>
      );
    case 'text':
      return <TextPane text={state.text} />;
    case 'error':
      return (
        <Alert
          severity="error"
          sx={{ m: 2 }}
          action={
            state.retryable ? (
              <Button color="inherit" size="small" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {state.message}
        </Alert>
      );
    case 'unsupported':
      return (
        <Stack alignItems="center" spacing={1.5} sx={{ m: 'auto', p: 3, maxWidth: 440, textAlign: 'center' }}>
          <PreviewOffIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
          <Typography variant="h6">Preview not supported</Typography>
          <Typography variant="body2" color="text.secondary">
            {fileTypeLabel(doc.filename)} files can't be viewed in the browser. The document is stored safely; download
            it to open it in its own application.
          </Typography>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={onDownload}>
            Download {doc.filename}
          </Button>
        </Stack>
      );
  }
}

function fileTypeLabel(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? `.${filename.slice(dot + 1).toLowerCase()}` : 'These';
}

function TextPane({ text }: { text: string }) {
  return (
    <Box
      component="pre"
      sx={{
        flex: 1,
        m: 0,
        p: 2,
        overflow: 'auto',
        bgcolor: 'background.paper',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: '0.8rem',
      }}
    >
      {text}
    </Box>
  );
}
