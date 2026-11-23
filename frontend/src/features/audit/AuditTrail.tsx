import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import {
  Avatar,
  Box,
  Collapse,
  IconButton,
  InputAdornment,
  LinearProgress,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';

import { EmptyState, ErrorState, Loading, PageHeader, SectionCard } from '../../components/common';
import { Section } from '../../components/ReportSection';
import { DEBOUNCE_MS, PAGE_SIZE, TABLE_ROWS_PER_PAGE_OPTIONS } from '../../constants';
import { initials } from '../../lib/email';
import { formatDateTime, formatRelative } from '../../lib/status';
import { paths } from '../../paths';
import { apiWith } from '../../services/api';
import type { AuditEvent } from '../../types';
import { auditKeys } from './queryKeys';

function AuditRows({ events, showSubmission }: { events: AuditEvent[]; showSubmission: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const cols = showSubmission ? 7 : 6;
  return (
    <TableContainer>
      <Table size="small" sx={{ minWidth: 900 }}>
        <TableHead>
          <TableRow>
            <TableCell width={150}>When</TableCell>
            <TableCell width={210}>Actor</TableCell>
            <TableCell width={230}>Action</TableCell>
            <TableCell width={150}>Entity</TableCell>
            {showSubmission && <TableCell width={110}>Submission</TableCell>}
            <TableCell>Details</TableCell>
            <TableCell width={48} />
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((e) => {
            const hasDetails = e.details && Object.keys(e.details).length > 0;
            const isOpen = open === e.id;
            return (
              <AuditRow
                key={e.id}
                e={e}
                isOpen={isOpen}
                hasDetails={!!hasDetails}
                cols={cols}
                showSubmission={showSubmission}
                onToggle={() => setOpen(isOpen ? null : e.id)}
              />
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function AuditRow({
  e,
  isOpen,
  hasDetails,
  cols,
  showSubmission,
  onToggle,
}: {
  e: AuditEvent;
  isOpen: boolean;
  hasDetails: boolean;
  cols: number;
  showSubmission: boolean;
  onToggle: () => void;
}) {
  const isUser = e.actorType === 'USER';
  const actorName = e.actor?.name ?? (isUser ? '—' : 'System');
  const pairs = hasDetails ? detailPairs(e.details) : [];
  return (
    <>
      <TableRow hover sx={{ '& > td': { py: 1.25, verticalAlign: 'middle', borderBottom: isOpen ? 0 : undefined } }}>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          <Typography variant="body2" fontWeight={500} noWrap>
            {formatRelative(e.createdAt)}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap display="block">
            {formatDateTime(e.createdAt)}
          </Typography>
        </TableCell>
        <TableCell>
          <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
            <Avatar
              sx={(t) => ({
                width: 32,
                height: 32,
                fontSize: '0.75rem',
                fontWeight: 600,
                bgcolor: alpha(isUser ? t.palette.primary.main : t.palette.text.secondary, 0.12),
                color: isUser ? 'primary.main' : 'text.secondary',
              })}
            >
              {isUser ? initials(actorName) : <SmartToyOutlinedIcon sx={{ fontSize: 18 }} />}
            </Avatar>
            <Typography variant="body2" fontWeight={500} noWrap title={actorName}>
              {actorName}
            </Typography>
          </Stack>
        </TableCell>
        <TableCell>
          <Box
            component="span"
            sx={(t) => ({
              display: 'inline-block',
              px: 1,
              py: 0.25,
              borderRadius: 1,
              bgcolor: alpha(t.palette.primary.main, 0.08),
              color: 'text.primary',
              fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: '0.75rem',
              fontWeight: 500,
              wordBreak: 'break-all',
            })}
          >
            {e.action}
          </Box>
        </TableCell>
        <TableCell>
          <Typography variant="body2">{e.entityType}</Typography>
          {e.entityId && (
            <Typography
              variant="caption"
              color="text.secondary"
              title={e.entityId}
              sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}
            >
              {e.entityId.slice(0, 10)}…
            </Typography>
          )}
        </TableCell>
        {showSubmission && (
          <TableCell>
            {e.submissionId ? (
              <Link component={RouterLink} to={paths.submission(e.submissionId, 'audit')} variant="body2">
                Open
              </Link>
            ) : (
              '—'
            )}
          </TableCell>
        )}
        <TableCell>
          {pairs.length ? (
            <Box
              title={pairs.map(([k, v]) => `${k}: ${v}`).join(' · ')}
              sx={{
                fontSize: '0.78rem',
                lineHeight: 1.5,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {pairs.map(([k, v], i) => (
                <Box component="span" key={k}>
                  {i > 0 && (
                    <Box component="span" sx={{ color: 'text.disabled', mx: 0.75 }}>
                      ·
                    </Box>
                  )}
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {k}:
                  </Box>{' '}
                  <Box component="span" sx={{ color: 'text.primary' }}>
                    {v}
                  </Box>
                </Box>
              ))}
            </Box>
          ) : (
            <Typography variant="caption" color="text.secondary">
              —
            </Typography>
          )}
        </TableCell>
        <TableCell>
          {hasDetails && (
            <IconButton size="small" onClick={onToggle} aria-label="Toggle details">
              {isOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
            </IconButton>
          )}
        </TableCell>
      </TableRow>
      {hasDetails && (
        <TableRow>
          {/* Collapsed: zero height and no border, so it adds no gap or double line under the main row. */}
          <TableCell colSpan={cols} sx={{ py: 0, borderBottom: isOpen ? undefined : 0 }}>
            <Collapse in={isOpen} unmountOnExit>
              <Box
                component="pre"
                sx={{
                  my: 1,
                  p: 1.5,
                  bgcolor: 'surface.subtle',
                  borderRadius: 1,
                  fontSize: '0.75rem',
                  // Wrap long values: an unwrapped <pre> widens the auto-layout table and scrolls it sideways.
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  maxHeight: 300,
                  fontFamily: 'ui-monospace, Consolas, monospace',
                }}
              >
                {JSON.stringify(e.details, null, 2)}
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function detailPairs(details: Record<string, unknown>): [string, string][] {
  return Object.entries(details)
    .slice(0, 4)
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}

/** Reusable per-submission audit list (GET /submissions/:id/audit). */
export function SubmissionAuditList({ submissionId }: { submissionId: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE.audit);
  const q = useQuery({
    queryKey: auditKeys.submission(submissionId, { page, pageSize }),
    queryFn: ({ signal }) => apiWith(signal).submissionAudit(submissionId, { page, pageSize }),
    placeholderData: keepPreviousData,
  });
  return (
    <SectionCard title="Audit trail" subtitle="Every system and user action on this submission, newest first.">
      {q.isLoading ? (
        <Loading label="Loading audit trail…" shape="table" />
      ) : q.isError ? (
        <Box sx={{ p: 2 }}>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Box>
      ) : !q.data?.items.length ? (
        <EmptyState title="No audit events" />
      ) : (
        <>
          <AuditRows events={q.data.items} showSubmission={false} />
          {q.data.total > q.data.pageSize && (
            <TablePagination
              component="div"
              count={q.data.total}
              page={page - 1}
              rowsPerPage={pageSize}
              rowsPerPageOptions={TABLE_ROWS_PER_PAGE_OPTIONS}
              onPageChange={(_, p) => setPage(p + 1)}
              onRowsPerPageChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            />
          )}
        </>
      )}
    </SectionCard>
  );
}

/** Global audit page (/audit), paged. */
export function AuditTrail() {
  const [params, setParams] = useSearchParams();
  const action = params.get('action') ?? '';
  const submissionId = params.get('submissionId') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const pageSize = Number(params.get('pageSize') ?? String(PAGE_SIZE.audit)) || PAGE_SIZE.audit;
  const [actionInput, setActionInput] = useState(action);
  const [subInput, setSubInput] = useState(submissionId);

  // Latest params (FE-09), so the debounced filter below doesn't revert a page-size change made while it waited.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const update = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(paramsRef.current);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (actionInput === action && subInput === submissionId) return;
    const t = setTimeout(
      () => update({ action: actionInput.trim(), submissionId: subInput.trim(), page: null }),
      DEBOUNCE_MS.auditFilter,
    );
    return () => clearTimeout(t);
    // Runs on typing only: `update` reads the latest URL through paramsRef, and a URL change (Back) must not re-fire
    // the debounce with the old text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionInput, subInput]);

  const q = useQuery({
    queryKey: auditKeys.global({ action, submissionId, page, pageSize }),
    queryFn: ({ signal }) =>
      apiWith(signal).audit({ action: action || undefined, submissionId: submissionId || undefined, page, pageSize }),
    placeholderData: keepPreviousData,
  });

  return (
    <Box>
      <PageHeader
        title="Audit Trail"
        subtitle="Immutable log of classification, extraction, NPI checks, report generation, assessments and user actions."
      />
      <Section title="Audit events" subtitle="Filter by action or submission ID.">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ pb: 1.5 }}>
          <TextField
            label="Action"
            placeholder="e.g. REPORT_GENERATED"
            value={actionInput}
            onChange={(e) => setActionInput(e.target.value)}
            sx={{ minWidth: 240 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <TextField
            label="Submission ID"
            value={subInput}
            onChange={(e) => setSubInput(e.target.value)}
            sx={{ minWidth: 280 }}
          />
        </Stack>
        {q.isFetching && <LinearProgress sx={{ height: 2 }} />}
        {q.isLoading ? (
          <Loading label="Loading audit trail…" shape="table" />
        ) : q.isError ? (
          <Box sx={{ p: 2 }}>
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          </Box>
        ) : !q.data?.items.length ? (
          <EmptyState
            title="No audit events"
            description={action || submissionId ? 'No events match these filters.' : undefined}
          />
        ) : (
          <>
            <AuditRows events={q.data.items} showSubmission />
            <TablePagination
              component="div"
              count={q.data.total}
              page={page - 1}
              rowsPerPage={pageSize}
              rowsPerPageOptions={TABLE_ROWS_PER_PAGE_OPTIONS}
              onPageChange={(_, p) => update({ page: p + 1 })}
              onRowsPerPageChange={(e) => update({ pageSize: e.target.value, page: null })}
            />
          </>
        )}
      </Section>
    </Box>
  );
}
