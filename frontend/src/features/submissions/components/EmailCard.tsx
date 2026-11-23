// Overview "Email" card: mail-client style header, readable body with quoted history folded away.
// Attachments are listed in their own card (AttachmentsCard).
import AttachIcon from '@mui/icons-material/AttachFileOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ForwardIcon from '@mui/icons-material/Forward';
import ReplyIcon from '@mui/icons-material/Reply';
import ReplyAllIcon from '@mui/icons-material/ReplyAll';
import {
  Avatar,
  Box,
  Button,
  ButtonGroup,
  Collapse,
  Divider,
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
import { alpha } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { ExternalAnchor, GmailButton, Linkify, SectionCard } from '../../../components/common';
import { LONG_EMAIL_BLOCKS, LONG_EMAIL_CHARS } from '../../../constants';
import type { EmailBlock } from '../../../lib/email';
import { blocksLength, initials, parseAddress, parseInline, splitEmailBody, splitLabel } from '../../../lib/email';
import { formatDateTime, formatRelative } from '../../../lib/status';
import { theme } from '../../../theme';
import type { OutboundMode, SubmissionDetail } from '../../../types';
import { ATTACHMENTS_ANCHOR } from './AttachmentsCard';

const COLLAPSED_HEIGHT = 340;

const COMPOSE_ACTIONS: { mode: OutboundMode; label: string; icon: ReactNode }[] = [
  { mode: 'REPLY', label: 'Reply', icon: <ReplyIcon /> },
  { mode: 'REPLY_ALL', label: 'Reply all', icon: <ReplyAllIcon /> },
  { mode: 'FORWARD', label: 'Forward', icon: <ForwardIcon /> },
];

/** `onCompose` shows Reply / Reply all / Forward (omitted for users who cannot send). */
export function EmailCard({ s, onCompose }: { s: SubmissionDetail; onCompose?: (mode: OutboundMode) => void }) {
  const e = s.email;
  const [expanded, setExpanded] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);

  const from = parseAddress(e.fromAddress);
  const { blocks, quoted } = splitEmailBody(e.bodyText || e.snippet || '');
  const long = blocksLength(blocks) > LONG_EMAIL_CHARS || blocks.length > LONG_EMAIL_BLOCKS;
  const attachments = s.documents.filter((d) => d.source === 'EMAIL').length;

  return (
    <SectionCard
      title="Email"
      subtitle={e.gmailMessageId ? 'Received via Gmail' : 'Manual intake'}
      actions={
        <>
          {onCompose && (
            // Icons only on phones, where the card header has no room for the labels.
            <ButtonGroup
              size="small"
              variant="outlined"
              aria-label="Respond to this email"
              sx={{
                '& .label': { display: { xs: 'none', sm: 'inline' } },
                '& .MuiButton-startIcon': { mr: { xs: 0, sm: 1 }, ml: { xs: 0, sm: -0.5 } },
              }}
            >
              {COMPOSE_ACTIONS.map(({ mode, label, icon }) => (
                <Tooltip key={mode} title={label}>
                  <Button startIcon={icon} onClick={() => onCompose(mode)} aria-label={label}>
                    <span className="label">{label}</span>
                  </Button>
                </Tooltip>
              ))}
            </ButtonGroup>
          )}
          <GmailButton messageId={e.gmailMessageId} />
        </>
      }
    >
      <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600, mb: 1.25, wordBreak: 'break-word' }}>
        {e.subject || '(no subject)'}
      </Typography>

      <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 1.5 }}>
        <Avatar sx={{ width: 38, height: 38, bgcolor: 'primary.main', fontSize: '0.9rem' }}>
          {initials(from.name ?? from.address)}
        </Avatar>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap" useFlexGap>
            {from.name && (
              <Typography variant="body2" fontWeight={600}>
                {from.name}
              </Typography>
            )}
            <Link
              href={`mailto:${from.address}`}
              underline="hover"
              variant="body2"
              sx={{
                fontWeight: from.name ? 400 : 600,
                color: from.name ? 'text.secondary' : 'text.primary',
                wordBreak: 'break-all',
              }}
            >
              {from.name ? `<${from.address}>` : from.address}
            </Link>
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ wordBreak: 'break-word' }}>
            to {e.toAddress || '—'}
            {attachments > 0 && (
              <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                <Box component="span" sx={{ mx: 0.75, color: 'text.disabled' }}>
                  ·
                </Box>
                <Link
                  component="button"
                  type="button"
                  variant="caption"
                  underline="hover"
                  color="inherit"
                  onClick={scrollToAttachments}
                  title="Go to Attachments"
                  sx={{ verticalAlign: 'baseline', '&:hover': { color: 'primary.main' } }}
                >
                  <AttachIcon sx={{ fontSize: '0.85rem', verticalAlign: '-0.15em', transform: 'rotate(45deg)' }} />{' '}
                  {attachments} attachment{attachments === 1 ? '' : 's'}
                </Link>
              </Box>
            )}
          </Typography>
        </Box>
        <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
          <Typography variant="caption" component="div">
            {formatDateTime(e.receivedAt)}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            {formatRelative(e.receivedAt)}
          </Typography>
        </Box>
      </Stack>

      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'surface.raised', px: 2, py: 1.75 }}>
        {blocks.length === 0 ? (
          <Typography variant="body2" color="text.secondary" fontStyle="italic">
            (empty body)
          </Typography>
        ) : (
          <Box
            sx={{
              position: 'relative',
              maxHeight: long && !expanded ? COLLAPSED_HEIGHT : 'none',
              overflow: 'hidden',
              '& > :last-child': { mb: 0 },
            }}
          >
            {blocks.map((b, i) => (
              <BodyBlock key={i} b={b} />
            ))}
            {long && !expanded && (
              <Box
                sx={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 72,
                  background: (t) =>
                    `linear-gradient(${alpha(t.palette.surface.raised, 0)}, ${t.palette.surface.raised})`,
                }}
              />
            )}
          </Box>
        )}

        {quoted && (
          <Box sx={{ mt: 1.25 }}>
            <Button
              size="small"
              color="inherit"
              onClick={() => setShowQuoted((q) => !q)}
              sx={{ minWidth: 0, px: 0.75, color: 'text.secondary', fontSize: '0.75rem' }}
              startIcon={showQuoted ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            >
              {showQuoted ? 'Hide earlier messages' : 'Show earlier messages'}
            </Button>
            <Collapse in={showQuoted}>
              <Box
                sx={{
                  mt: 0.75,
                  pl: 1.5,
                  borderLeft: 3,
                  borderColor: 'divider',
                  color: 'text.secondary',
                  fontSize: '0.8rem',
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <Linkify>{quoted}</Linkify>
              </Box>
            </Collapse>
          </Box>
        )}
      </Box>

      {long && (
        <Button
          size="small"
          onClick={() => setExpanded((x) => !x)}
          startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          sx={{ mt: 1 }}
        >
          {expanded ? 'Collapse' : 'Show full email'}
        </Button>
      )}
    </SectionCard>
  );
}

/** Scrolls the Overview's Attachments card into view and briefly outlines it so the eye lands on it. */
function scrollToAttachments() {
  const el = document.getElementById(ATTACHMENTS_ANCHOR);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.animate?.(
    [
      { boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.55)}` },
      { boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0)}` },
    ],
    { duration: 1400, delay: 350, easing: 'ease-out' },
  );
}

const TEXT_SX = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 } as const;
const CODE_SX = {
  fontFamily: 'ui-monospace, Consolas, monospace',
  fontSize: '0.8rem',
  bgcolor: 'action.hover',
  px: 0.5,
  py: 0.1,
  borderRadius: 0.5,
} as const;

/** Renders literal Markdown (**bold**, *italic*, `code`, [links](…)) as styled text, keeping bare links clickable. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((r, i) => {
        if (r.href) {
          // Same as the shared Markdown: the real destination is shown when the label differs from it.
          return (
            <ExternalAnchor key={i} href={r.href}>
              {r.text}
            </ExternalAnchor>
          );
        }
        if (r.code)
          return (
            <Box key={i} component="code" sx={CODE_SX}>
              {r.text}
            </Box>
          );
        if (r.bold || r.italic) {
          return (
            <Box key={i} component={r.bold ? 'strong' : 'em'} sx={{ fontWeight: r.bold ? 600 : undefined }}>
              <Linkify>{r.text}</Linkify>
            </Box>
          );
        }
        return <Linkify key={i}>{r.text}</Linkify>;
      })}
    </>
  );
}

/** Bolds a leading "Label:" so key/value lines in application emails scan like a form. */
function LabeledText({ text }: { text: string }) {
  const lv = splitLabel(text);
  if (!lv) return <Rich text={text} />;
  return (
    <>
      <Box component="span" sx={{ fontWeight: 600 }}>
        {lv.label}:
      </Box>{' '}
      <Rich text={lv.value} />
    </>
  );
}

const LIST_SX = {
  m: 0,
  mb: 1.25,
  pl: 2.75,
  '& li': { fontSize: '0.875rem', ...TEXT_SX, mb: 0.25 },
  '& li::marker': { color: 'text.secondary', fontWeight: 600 },
} as const;

function BodyBlock({ b }: { b: EmailBlock }) {
  switch (b.type) {
    case 'heading':
      return (
        <Typography
          variant="subtitle2"
          sx={{ mt: 2, mb: 0.75, color: 'primary.main', fontWeight: 600, '&:first-of-type': { mt: 0 } }}
        >
          <Rich text={b.text} />
        </Typography>
      );
    case 'rule':
      return <Divider sx={{ my: 1.75 }} />;
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={i}>
          <LabeledText text={it} />
        </li>
      ));
      return b.start === undefined ? (
        <Box component="ul" sx={LIST_SX}>
          {items}
        </Box>
      ) : (
        <Box sx={{ '& ol': LIST_SX }}>
          <ol start={b.start}>{items}</ol>
        </Box>
      );
    }
    case 'fields':
      return (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, max-content) 1fr' },
            columnGap: 2.5,
            rowGap: { xs: 0.25, sm: 0.6 },
            mb: 1.5,
            fontSize: '0.875rem',
            lineHeight: 1.55,
          }}
        >
          {b.items.map((f, i) => (
            <Box key={i} sx={{ display: 'contents' }}>
              <Box sx={{ color: 'text.secondary', fontWeight: 600, mt: { xs: i ? 0.75 : 0, sm: 0 } }}>{f.label}</Box>
              <Box sx={{ wordBreak: 'break-word' }}>
                <Rich text={f.value} />
              </Box>
            </Box>
          ))}
        </Box>
      );
    case 'table':
      return (
        <TableContainer
          sx={{ mb: 1.5, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper' }}
        >
          <Table
            size="small"
            sx={{ '& td, & th': { fontSize: '0.8125rem', verticalAlign: 'top', wordBreak: 'break-word' } }}
          >
            {b.header.length > 0 && (
              <TableHead>
                <TableRow>
                  {b.header.map((h, i) => (
                    <TableCell key={i} sx={{ fontWeight: 600, bgcolor: 'action.hover' }}>
                      <Rich text={h} />
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
            )}
            <TableBody>
              {b.rows.map((r, i) => (
                <TableRow key={i} sx={{ '&:last-child td': { borderBottom: 0 } }}>
                  {r.map((c, j) => (
                    <TableCell key={j} sx={j === 0 ? { fontWeight: 500, whiteSpace: 'nowrap' } : undefined}>
                      <Rich text={c} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      );
    default:
      return (
        <Typography variant="body2" sx={{ ...TEXT_SX, mb: 1.25 }}>
          <LabeledText text={b.text} />
        </Typography>
      );
  }
}
