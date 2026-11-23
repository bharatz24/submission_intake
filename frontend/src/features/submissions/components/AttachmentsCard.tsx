// Overview "Attachments" card: one row per document with a file-type badge, extraction status, and view/download actions,
// followed by a warning row for each attachment that could not be stored.
import type { SvgIconComponent } from '@mui/icons-material';
import WordIcon from '@mui/icons-material/ArticleOutlined';
import AttachIcon from '@mui/icons-material/AttachFileOutlined';
import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import MailIcon from '@mui/icons-material/EmailOutlined';
import ArchiveIcon from '@mui/icons-material/FolderZipOutlined';
import ImageIcon from '@mui/icons-material/ImageOutlined';
import FileIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PdfIcon from '@mui/icons-material/PictureAsPdfOutlined';
import SlidesIcon from '@mui/icons-material/SlideshowOutlined';
import SheetIcon from '@mui/icons-material/TableChartOutlined';
import TextIcon from '@mui/icons-material/TextSnippetOutlined';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import WarningIcon from '@mui/icons-material/WarningAmberOutlined';
import { Alert, Box, Chip, IconButton, Link, Stack, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useState } from 'react';

import { SectionCard } from '../../../components/common';
import { extractionStatusColor, formatBytes, humanize } from '../../../lib/status';
import { downloadDocument, errorMessage } from '../../../services/api';
import { tokens } from '../../../theme';
import type { AttachmentGap, DocumentInfo } from '../../../types';
import { DocumentViewerDialog } from './DocumentViewerDialog';

// Icon and colour per file family, so a PDF application and a spreadsheet loss run tell apart at a glance.
const FILE_KINDS: { exts: string[]; mime: RegExp; color: string; Icon: SvgIconComponent }[] = [
  { exts: ['pdf'], mime: /pdf/, color: tokens.fileType.pdf, Icon: PdfIcon },
  {
    exts: ['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'bmp', 'heic', 'webp', 'svg'],
    mime: /^image\//,
    color: tokens.fileType.image,
    Icon: ImageIcon,
  },
  {
    exts: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods'],
    mime: /spreadsheet|excel|csv/,
    color: tokens.fileType.sheet,
    Icon: SheetIcon,
  },
  {
    exts: ['doc', 'docx', 'rtf', 'odt'],
    mime: /word|rtf|opendocument\.text/,
    color: tokens.fileType.doc,
    Icon: WordIcon,
  },
  { exts: ['ppt', 'pptx', 'odp'], mime: /presentation|powerpoint/, color: tokens.fileType.slides, Icon: SlidesIcon },
  { exts: ['eml', 'msg'], mime: /message\/|outlook/, color: tokens.fileType.neutral, Icon: MailIcon },
  {
    exts: ['txt', 'md', 'html', 'htm', 'json', 'xml'],
    mime: /^text\//,
    color: tokens.fileType.neutral,
    Icon: TextIcon,
  },
  {
    exts: ['zip', '7z', 'rar', 'gz'],
    mime: /zip|compressed|archive/,
    color: tokens.fileType.archive,
    Icon: ArchiveIcon,
  },
];
const OTHER = { color: tokens.fileType.neutral, Icon: FileIcon };

function fileKind(d: DocumentInfo): { ext: string; color: string; Icon: SvgIconComponent } {
  const ext = d.filename.includes('.') ? d.filename.split('.').pop()!.toLowerCase() : '';
  const kind = FILE_KINDS.find((k) => k.exts.includes(ext)) ?? FILE_KINDS.find((k) => k.mime.test(d.mimeType)) ?? OTHER;
  return { ext: ext.slice(0, 4).toUpperCase(), color: kind.color, Icon: kind.Icon };
}

/** DOM id of the card, so the email header's attachment count can scroll to it. */
export const ATTACHMENTS_ANCHOR = 'submission-attachments';

const GAP_REASONS: Record<AttachmentGap['reason'], string> = {
  TOO_LARGE: 'too large to store',
  LINKED_FILE: 'shared as a Google Drive link in the email',
  NO_CONTENT: 'the mail server did not provide its content',
};

/** An attachment that was not stored, shown so it is never missed silently. */
function GapRow({ gap }: { gap: AttachmentGap }) {
  const link =
    gap.reason === 'LINKED_FILE' && gap.detail && /^https:\/\/(drive|docs)\.google\.com\//i.test(gap.detail)
      ? gap.detail
      : null;
  return (
    <Alert
      severity="warning"
      icon={<WarningIcon fontSize="small" />}
      sx={{ py: 0.25, '& .MuiAlert-message': { minWidth: 0 } }}
    >
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        <strong>{gap.filename}</strong> was not stored: {GAP_REASONS[gap.reason]}
        {gap.sizeBytes ? ` (${formatBytes(gap.sizeBytes)})` : ''}.
      </Typography>
      {link ? (
        <Link href={link} target="_blank" rel="noopener noreferrer" variant="caption" sx={{ wordBreak: 'break-all' }}>
          {link}
        </Link>
      ) : gap.detail && gap.reason !== 'LINKED_FILE' ? (
        <Typography variant="caption" color="text.secondary">
          {gap.detail}
        </Typography>
      ) : null}
    </Alert>
  );
}

export function AttachmentsCard({ documents, gaps = [] }: { documents: DocumentInfo[]; gaps?: AttachmentGap[] }) {
  const [viewing, setViewing] = useState<DocumentInfo | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (d: DocumentInfo) => {
    setError(null);
    setDownloading(d.id);
    try {
      await downloadDocument(d.id, d.filename);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDownloading(null);
    }
  };

  const total = documents.reduce((n, d) => n + d.sizeBytes, 0);

  return (
    // scrollMarginTop keeps the card clear of the sticky app bar when scrolled to.
    <Box id={ATTACHMENTS_ANCHOR} sx={{ scrollMarginTop: 80, borderRadius: 1 }}>
      <SectionCard
        title="Attachments"
        tone="success"
        subtitle={
          [
            documents.length
              ? `${documents.length} file${documents.length === 1 ? '' : 's'} · ${formatBytes(total)}`
              : null,
            gaps.length ? `${gaps.length} not stored` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
      >
        {error && (
          <Alert severity="error" sx={{ mb: 1.25 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {documents.length === 0 && gaps.length > 0 ? null : documents.length === 0 ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary', py: 0.5 }}>
            <AttachIcon fontSize="small" />
            <Typography variant="body2">No attachments on this submission.</Typography>
          </Stack>
        ) : (
          <Stack spacing={1}>
            {documents.map((d) => {
              const kind = fileKind(d);
              const meta = [
                d.pageCount ? `${d.pageCount} page${d.pageCount === 1 ? '' : 's'}` : null,
                formatBytes(d.sizeBytes),
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <Box
                  key={d.id}
                  role="button"
                  tabIndex={0}
                  title={`View ${d.filename}`}
                  onClick={() => setViewing(d)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setViewing(d);
                    }
                  }}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    p: 1,
                    pr: 0.5,
                    cursor: 'pointer',
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    transition: 'border-color .15s, background-color .15s',
                    '&:hover, &:focus-visible': {
                      borderColor: 'primary.main',
                      bgcolor: (t) => alpha(t.palette.primary.main, 0.04),
                      outline: 'none',
                    },
                  }}
                >
                  <Box
                    title={kind.ext ? `${kind.ext} file` : d.mimeType}
                    sx={{
                      width: 38,
                      height: 42,
                      flexShrink: 0,
                      borderRadius: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: alpha(kind.color, 0.1),
                      border: 1,
                      borderColor: alpha(kind.color, 0.3),
                      color: kind.color,
                    }}
                  >
                    <kind.Icon sx={{ fontSize: kind.ext ? '1.2rem' : '1.4rem' }} />
                    {kind.ext && (
                      <Box
                        component="span"
                        sx={{ fontSize: '0.55rem', fontWeight: 700, letterSpacing: 0.3, lineHeight: 1.1 }}
                      >
                        {kind.ext}
                      </Box>
                    )}
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" fontWeight={600} noWrap title={d.filename}>
                      {d.filename}
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={0.75}
                      alignItems="center"
                      sx={{ mt: 0.25 }}
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Typography variant="caption" color="text.secondary">
                        {meta}
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={extractionStatusColor(d.extractionStatus)}
                        label={humanize(d.extractionStatus)}
                        sx={{ height: 18, fontSize: '0.65rem' }}
                      />
                      {d.ocrUsed && (
                        <Chip
                          size="small"
                          variant="outlined"
                          color="info"
                          label="OCR"
                          sx={{ height: 18, fontSize: '0.65rem' }}
                        />
                      )}
                      {d.source === 'UPLOAD' && (
                        <Chip
                          size="small"
                          variant="outlined"
                          label="Uploaded"
                          sx={{ height: 18, fontSize: '0.65rem' }}
                        />
                      )}
                    </Stack>
                  </Box>
                  <Stack direction="row" flexShrink={0} onClick={(e) => e.stopPropagation()}>
                    <Tooltip title="View">
                      <IconButton size="small" onClick={() => setViewing(d)} aria-label={`View ${d.filename}`}>
                        <VisibilityIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Download original">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => download(d)}
                          disabled={downloading === d.id}
                          aria-label={`Download ${d.filename}`}
                        >
                          <DownloadIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        )}
        {gaps.length > 0 && (
          <Stack spacing={1} sx={{ mt: documents.length ? 1 : 0 }}>
            {gaps.map((g) => (
              <GapRow key={g.id} gap={g} />
            ))}
          </Stack>
        )}
        <DocumentViewerDialog doc={viewing} onClose={() => setViewing(null)} />
      </SectionCard>
    </Box>
  );
}
