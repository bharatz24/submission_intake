import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import UploadIcon from '@mui/icons-material/UploadFileOutlined';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  IconButton,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EmptyState, EnumChip, SectionCard } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { documentUploadLimit, uploadCaption, uploadProblem, useLimits } from '../../../lib/limits';
import { extractionStatusColor, formatBytes, formatDateTime } from '../../../lib/status';
import { api, downloadDocument, errorMessage } from '../../../services/api';
import type { DocumentInfo, SubmissionDetail } from '../../../types';
import { auditKeys } from '../../audit';
import { DocumentViewerDialog } from '../components/DocumentViewerDialog';
import { FieldsCard } from '../components/FieldsCard';
import { RequiredInfoCard } from '../components/RequiredInfoCard';
import { isHeldBack } from '../pages/SubmissionWorkspace';
import { submissionKeys } from '../queryKeys';

export function DocumentsTab({ s }: { s: SubmissionDetail }) {
  const [openPreview, setOpenPreview] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [viewing, setViewing] = useState<DocumentInfo | null>(null);
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const qc = useQueryClient();
  // Checked before uploading for a clear message; the server enforces the same limits. Unknown limits block nothing.
  const uploadLimit = documentUploadLimit(useLimits().data);
  const [uploadRejected, setUploadRejected] = useState<string | null>(null);
  const toast = useToast();
  const upload = useMutation({
    mutationFn: (files: File[]) => api.uploadDocuments(s.id, files),
    onSuccess: (r) => {
      qc.setQueryData(submissionKeys.detail(s.id), r.submission);
      toast.success(TOAST_MESSAGES.documentsUploaded(r.documentIds.length));
      // The detail polls while the new documents are PENDING, so their extraction status updates by itself.
      qc.invalidateQueries({ queryKey: submissionKeys.detail(s.id) });
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
    },
    onError: (err) => toast.error(err),
  });

  const doDownload = async (docId: string, filename: string) => {
    setDownloadError(null);
    setDownloading(docId);
    try {
      await downloadDocument(docId, filename);
    } catch (e) {
      setDownloadError(errorMessage(e));
    } finally {
      setDownloading(null);
    }
  };

  const uploadButton = writable && (
    <Button size="small" variant="outlined" component="label" startIcon={<UploadIcon />} disabled={upload.isPending}>
      {upload.isPending ? 'Uploading…' : 'Upload documents'}
      <input
        hidden
        type="file"
        multiple
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = ''; // the same file can be chosen again
          if (!files.length) return;
          upload.reset();
          const problem = uploadProblem(files, uploadLimit);
          setUploadRejected(problem);
          if (!problem) upload.mutate(files);
        }}
      />
    </Button>
  );

  return (
    <Stack spacing={2}>
      {!isHeldBack(s) && <RequiredInfoCard s={s} />}
      <SectionCard
        title="Documents"
        subtitle={`Email attachments and documents uploaded by hand, with extraction status.${writable && uploadLimit ? ` ${uploadCaption(uploadLimit)}.` : ''}`}
        actions={uploadButton}
      >
        {uploadRejected && (
          <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setUploadRejected(null)}>
            {uploadRejected} Nothing was uploaded.
          </Alert>
        )}
        {downloadError && (
          <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setDownloadError(null)}>
            {downloadError}
          </Alert>
        )}
        {s.documents.length === 0 ? (
          <EmptyState
            title="No documents"
            description={writable ? 'No documents yet. Use Upload documents to add them.' : 'No documents yet.'}
          />
        ) : (
          <TableContainer>
            <Table size="small" sx={{ minWidth: 760 }}>
              <TableHead>
                <TableRow>
                  <TableCell>File</TableCell>
                  <TableCell>Source</TableCell>
                  <TableCell>Extraction</TableCell>
                  <TableCell align="right">Pages</TableCell>
                  <TableCell align="right">Size</TableCell>
                  <TableCell>Added</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {s.documents.map((d) => (
                  <DocRow
                    key={d.id}
                    doc={d}
                    open={openPreview === d.id}
                    onToggle={() => setOpenPreview((p) => (p === d.id ? null : d.id))}
                    downloading={downloading === d.id}
                    onView={() => setViewing(d)}
                    onDownload={() => doDownload(d.id, d.filename)}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        <DocumentViewerDialog doc={viewing} onClose={() => setViewing(null)} />
      </SectionCard>

      <FieldsCard s={s} />
    </Stack>
  );
}

function DocRow({
  doc,
  open,
  onToggle,
  onView,
  onDownload,
  downloading,
}: {
  doc: DocumentInfo;
  open: boolean;
  onToggle: () => void;
  onView: () => void;
  onDownload: () => void;
  downloading: boolean;
}) {
  return (
    <>
      <TableRow hover sx={{ '& > td': { borderBottom: open ? 0 : undefined } }}>
        <TableCell sx={{ maxWidth: 300 }}>
          <Link
            component="button"
            variant="body2"
            fontWeight={600}
            underline="hover"
            onClick={onView}
            title={`View ${doc.filename}`}
            sx={{
              display: 'block',
              maxWidth: '100%',
              textAlign: 'left',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {doc.filename}
          </Link>
          <Typography variant="caption" color="text.secondary" noWrap display="block" title={`SHA-256 ${doc.sha256}`}>
            {doc.mimeType} · sha256 {doc.sha256.slice(0, 12)}…
          </Typography>
        </TableCell>
        <TableCell>
          <Chip size="small" variant="outlined" label={doc.source === 'EMAIL' ? 'Email' : 'Upload'} />
        </TableCell>
        <TableCell>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <EnumChip value={doc.extractionStatus} color={extractionStatusColor(doc.extractionStatus)} />
            {doc.ocrUsed && <Chip size="small" label="OCR" variant="outlined" color="info" />}
          </Stack>
        </TableCell>
        <TableCell align="right">{doc.pageCount ?? '—'}</TableCell>
        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
          {formatBytes(doc.sizeBytes)}
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(doc.createdAt)}</TableCell>
        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
          <Tooltip title={open ? 'Hide text preview' : 'Show text preview'}>
            <IconButton size="small" onClick={onToggle} aria-label="Toggle text preview">
              {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Tooltip title="View document">
            <IconButton size="small" onClick={onView} aria-label={`View ${doc.filename}`}>
              <VisibilityIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Download original">
            <span>
              <IconButton
                size="small"
                onClick={onDownload}
                disabled={downloading}
                aria-label={`Download ${doc.filename}`}
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={7} sx={{ py: 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box sx={{ my: 1.5 }}>
              {doc.textPreview ? (
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.5,
                    bgcolor: 'surface.subtle',
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                    maxHeight: 280,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'ui-monospace, Consolas, monospace',
                    fontSize: '0.75rem',
                  }}
                >
                  {doc.textPreview}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {doc.extractionStatus === 'PENDING'
                    ? 'Extraction in progress…'
                    : 'No text could be extracted from this document.'}
                </Typography>
              )}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

// ---------------------------------------------------------------- NPI
