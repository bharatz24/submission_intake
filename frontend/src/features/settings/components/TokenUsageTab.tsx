// Monitoring > Token usage tab: Claude token usage per task and per request (GET /monitoring/llm-usage).
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InputIcon from '@mui/icons-material/Input';
import OutputIcon from '@mui/icons-material/Output';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLongOutlined';
import SavingsOutlinedIcon from '@mui/icons-material/SavingsOutlined';
import SendIcon from '@mui/icons-material/SendOutlined';
import TollIcon from '@mui/icons-material/Toll';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Grid,
  IconButton,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { EnumChip, ErrorState, Loading, SortCell } from '../../../components/common';
import { TOKEN_KIND, TokenHeader, Tokens } from '../../../components/TokenCount';
import { CACHE_SHARE_GOOD, PAGE_SIZE, POLL_MS, TABLE_ROWS_PER_PAGE_OPTIONS } from '../../../constants';
import { sortRows, type SortState } from '../../../lib/sort';
import { formatDateTime, formatRelative, formatTokens, humanize, llmCallStatusColor } from '../../../lib/status';
import { paths } from '../../../paths';
import { apiWith } from '../../../services/api';
import type { LlmModelUsage, LlmUsageRange, LlmUsageSort } from '../../../types';
import { monitoringKeys } from '../queryKeys';
import { SpendPanel } from './SpendPanel';
import { TranscriptDialog } from './TranscriptDialog';

function UsageStat({
  label,
  value,
  exact,
  hint,
  icon,
}: {
  label: string;
  value: string | number;
  exact?: number;
  hint: string;
  icon: ReactNode;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1.5, height: '100%' }}>
      {icon}
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="overline" sx={{ fontSize: '0.65rem', lineHeight: 1.4 }}>
          {label}
        </Typography>
        <Tooltip title={exact !== undefined ? `${exact.toLocaleString()} tokens` : ''}>
          <Typography
            variant="h5"
            component="div"
            sx={{ lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', width: 'fit-content' }}
          >
            {value}
          </Typography>
        </Tooltip>
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      </Box>
    </Paper>
  );
}

const totalTokens = (r: { inputTokens: number; outputTokens: number }) => r.inputTokens + r.outputTokens;

/** Share of input tokens read from the prompt cache. */
const cacheShare = (r: { inputTokens: number; cacheReadTokens: number }) =>
  r.inputTokens ? r.cacheReadTokens / r.inputTokens : 0;

const usd = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2 })}`;

type ModelSortKey = 'task' | 'model' | 'calls' | 'failed' | 'input' | 'cache' | 'output' | 'total';
const MODEL_SORT_VALUE: Record<ModelSortKey, (m: LlmModelUsage) => string | number> = {
  task: (m) => `${humanize(m.task)} ${m.model}`,
  model: (m) => `${m.model} ${humanize(m.task)}`,
  calls: (m) => m.calls,
  failed: (m) => m.failed,
  input: (m) => m.inputTokens,
  cache: cacheShare,
  output: (m) => m.outputTokens,
  total: totalTokens,
};

/** Cache read share with a tooltip: tokens read and written, and what caching saved on this row. */
function CacheCell({ r }: { r: LlmModelUsage }) {
  const share = cacheShare(r);
  const saved = r.cacheSavingsUsd;
  const title =
    `${r.cacheReadTokens.toLocaleString()} input tokens read from cache, ${r.cacheWriteTokens.toLocaleString()} written to it` +
    (saved === null
      ? ' · no price known for this model'
      : ` · estimated ${saved >= 0 ? 'saving' : 'extra cost'} ${usd(Math.abs(saved))}`);
  return (
    <TableCell align="right">
      <Tooltip title={title}>
        <Box
          component="span"
          sx={{
            ...num,
            color: share >= CACHE_SHARE_GOOD ? 'success.main' : share > 0 ? 'text.primary' : 'text.disabled',
          }}
        >
          {r.inputTokens ? `${Math.round(share * 100)}%` : '—'}
        </Box>
      </Tooltip>
      {saved !== null && saved !== 0 && (
        <Typography
          variant="caption"
          component="div"
          sx={{ ...num, color: saved > 0 ? 'success.main' : 'warning.dark' }}
        >
          {usd(Math.abs(saved))} {saved > 0 ? 'saved' : 'extra'}
        </Typography>
      )}
    </TableCell>
  );
}

// Key order is the button order on Monitoring.
export const RANGE_LABEL: Record<LlmUsageRange, string> = {
  today: 'Today',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};

const num = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } as const;

const maxTotal = (rows: { inputTokens: number; outputTokens: number }[]) => Math.max(0, ...rows.map(totalTokens));

/** Input + output tokens with a horizontal bar: the row's share of the column's largest total. */
function TotalCell({ n, max }: { n: number; max: number }) {
  return (
    <TableCell align="right" sx={{ width: '22%', minWidth: 72 }}>
      <Tooltip title={`${n.toLocaleString()} total tokens (input + output)`}>
        <Box component="span" sx={{ ...num, display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          {formatTokens(n)}
        </Box>
      </Tooltip>
      <Box sx={{ mt: 0.5, height: 4, borderRadius: 2, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box
          sx={{ height: '100%', width: `${max ? (n / max) * 100 : 0}%`, bgcolor: 'primary.main', borderRadius: 2 }}
        />
      </Box>
    </TableCell>
  );
}

const TotalHeader = (
  <Tooltip title="Input + output tokens">
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, whiteSpace: 'nowrap' }}>
      <TollIcon sx={{ fontSize: '0.95rem', color: 'primary.main' }} />
      <span className="TokenHeader-label">Total</span>
    </Box>
  </Tooltip>
);

/**
 * The by-task / by-model tables sit side by side from `lg`, where half the page is too narrow for six columns:
 * tighter padding, sort arrows only on the sorted column, wrapping labels, and icon-only token headers
 * (the tooltip still names them) until `xl`.
 */
const compactTable = {
  '& .MuiTableCell-root': { px: 1 },
  '& .MuiTableSortLabel-root:not(.Mui-active) .MuiTableSortLabel-icon': { display: 'none' },
  '& .TokenHeader-label': { display: { xs: 'inline', lg: 'none', xl: 'inline' } },
} as const;

/** Token usage per Claude request — informational only, loaded separately so it never blocks pipeline stats. */
/** Token usage for the period chosen at the top of Monitoring; the page remounts this per range, resetting paging. */
/** A screen-reader-only header for the transcript action column. Sizes are strings: in sx a bare `1` means 100%. */
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export function TokenUsageTab({ range }: { range: LlmUsageRange }) {
  const { user } = useAuth();
  // Transcripts hold submission content: only monitoring managers see the action (the server enforces it too).
  const canViewTranscripts = hasPermission(user, 'monitoring:manage');
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE.tokenUsage);
  const [reqSort, setReqSort] = useState<SortState<LlmUsageSort>>({ key: 'at', order: 'desc' });
  const [modelSort, setModelSort] = useState<SortState<ModelSortKey>>({ key: 'task', order: 'asc' });
  const onReqSort = (next: SortState<LlmUsageSort>) => {
    setReqSort(next);
    setPage(1);
  };
  const usage = useQuery({
    queryKey: monitoringKeys.llmUsage(range, page, pageSize, reqSort.key, reqSort.order),
    queryFn: ({ signal }) =>
      apiWith(signal).llmUsage({ range, page, pageSize, sort: reqSort.key, order: reqSort.order }),
    refetchInterval: POLL_MS.tokenUsage,
    placeholderData: keepPreviousData,
  });
  const u = usage.data;
  const period = RANGE_LABEL[range].toLowerCase();

  const rangePicker = (
    <Typography variant="body2" color="text.secondary">
      Claude token usage · {period}
    </Typography>
  );
  if (usage.isLoading)
    return (
      <Stack spacing={2}>
        {rangePicker}
        <Loading label="Loading token usage…" shape="cards" />
      </Stack>
    );
  if (usage.isError)
    return (
      <Stack spacing={2}>
        {rangePicker}
        <ErrorState error={usage.error} onRetry={() => usage.refetch()} title="Could not load token usage" />
      </Stack>
    );
  if (!u) return null;
  const t = u.summary;
  const reqs = u.requests;
  const modelMax = maxTotal(t.byModel);
  const cacheSaved = t.cacheSavingsUsd >= 0;
  return (
    // useFlexGap: margin-based spacing would reset the summary Grid's negative margins and misalign it with the tables.
    <Stack spacing={2.5} useFlexGap>
      {rangePicker}
      {usage.isFetching && usage.isPlaceholderData && <LinearProgress sx={{ mt: -1.5 }} />}

      <SpendPanel usage={u} period={period} />

      {/* Tokens, caching and per-request rows matter to whoever tunes the prompts, not to most readers: closed by default. */}
      <Accordion
        disableGutters
        variant="outlined"
        expanded={detailsOpen}
        onChange={(_, open) => setDetailsOpen(open)}
        sx={{ '&::before': { display: 'none' }, borderRadius: 1 }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Box>
            <Typography variant="subtitle2">Technical details</Typography>
            <Typography variant="caption" color="text.secondary">
              {t.calls.toLocaleString()} Claude {t.calls === 1 ? 'request' : 'requests'} ·{' '}
              {formatTokens(totalTokens(t))} tokens · caching, per-model usage and every request
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={2.5} useFlexGap>
            <Grid container spacing={1.5}>
              <Grid item xs={12} sm={6} md={4} lg={2.4}>
                <UsageStat
                  label="Claude requests"
                  value={t.calls.toLocaleString()}
                  hint={RANGE_LABEL[range]}
                  icon={<SendIcon sx={{ fontSize: 28, color: 'primary.main' }} />}
                />
              </Grid>
              <Grid item xs={12} sm={6} md={4} lg={2.4}>
                <UsageStat
                  label="Input tokens"
                  value={formatTokens(t.inputTokens)}
                  exact={t.inputTokens}
                  hint={`Sent to Claude, incl. cache · ${period}`}
                  icon={<InputIcon sx={{ fontSize: 28, color: TOKEN_KIND.input.color }} />}
                />
              </Grid>
              <Grid item xs={12} sm={6} md={4} lg={2.4}>
                <UsageStat
                  label="Output tokens"
                  value={formatTokens(t.outputTokens)}
                  exact={t.outputTokens}
                  hint={`Generated by Claude · ${period}`}
                  icon={<OutputIcon sx={{ fontSize: 28, color: TOKEN_KIND.output.color }} />}
                />
              </Grid>
              <Grid item xs={12} sm={6} md={6} lg={2.4}>
                <UsageStat
                  label="Total tokens"
                  value={formatTokens(totalTokens(t))}
                  exact={totalTokens(t)}
                  hint={`Input + output · ${period}`}
                  icon={<TollIcon sx={{ fontSize: 28, color: 'primary.main' }} />}
                />
              </Grid>
              <Grid item xs={12} sm={12} md={6} lg={2.4}>
                {/* Writing to the cache costs more than a plain read, so with few cache hits the net "saving" is negative. */}
                <UsageStat
                  label={cacheSaved ? 'Saved by caching' : 'Extra cost of caching'}
                  value={usd(Math.abs(t.cacheSavingsUsd))}
                  exact={t.cacheReadTokens}
                  hint={`${Math.round(cacheShare(t) * 100)}% of input read from cache · estimate`}
                  icon={
                    <SavingsOutlinedIcon sx={{ fontSize: 28, color: cacheSaved ? 'success.main' : 'warning.main' }} />
                  }
                />
              </Grid>
            </Grid>

            <Grid container spacing={2.5}>
              <Grid item xs={12}>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  Usage by task and model
                </Typography>
                {t.byModel.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No Claude requests in this period.
                  </Typography>
                ) : (
                  <TableContainer>
                    <Table size="small" sx={compactTable}>
                      <TableHead>
                        <TableRow>
                          <SortCell k="task" sort={modelSort} onSort={setModelSort}>
                            Task
                          </SortCell>
                          <SortCell k="model" sort={modelSort} onSort={setModelSort}>
                            Model
                          </SortCell>
                          <SortCell k="calls" sort={modelSort} onSort={setModelSort} first="desc" align="right">
                            Requests
                          </SortCell>
                          <SortCell k="failed" sort={modelSort} onSort={setModelSort} first="desc" align="right">
                            Failed
                          </SortCell>
                          <SortCell k="input" sort={modelSort} onSort={setModelSort} first="desc" align="right">
                            <TokenHeader kind="input" />
                          </SortCell>
                          <SortCell k="cache" sort={modelSort} onSort={setModelSort} first="desc" align="right">
                            <Tooltip title="Share of input read from the prompt cache, and the estimated saving">
                              <span>Cache</span>
                            </Tooltip>
                          </SortCell>
                          <SortCell k="output" sort={modelSort} onSort={setModelSort} first="desc" align="right">
                            <TokenHeader kind="output" />
                          </SortCell>
                          <SortCell k="total" sort={modelSort} onSort={setModelSort} first="desc" align="right">
                            {TotalHeader}
                          </SortCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {sortRows(t.byModel, MODEL_SORT_VALUE[modelSort.key], modelSort.order).map((r) => (
                          <TableRow key={`${r.task}:${r.model}`}>
                            <TableCell>{humanize(r.task)}</TableCell>
                            <TableCell
                              sx={{
                                fontFamily: 'ui-monospace, Consolas, monospace',
                                fontSize: '0.75rem',
                                overflowWrap: 'anywhere',
                              }}
                            >
                              {r.model}
                            </TableCell>
                            <TableCell align="right" sx={num}>
                              {r.calls}
                            </TableCell>
                            <TableCell align="right" sx={{ ...num, color: r.failed ? 'error.main' : 'text.secondary' }}>
                              {r.failed}
                            </TableCell>
                            <TableCell align="right">
                              <Tokens n={r.inputTokens} kind="input" cached={r.cacheReadTokens} icon={false} />
                            </TableCell>
                            <CacheCell r={r} />
                            <TableCell align="right">
                              <Tokens n={r.outputTokens} kind="output" icon={false} />
                            </TableCell>
                            <TotalCell n={totalTokens(r)} max={modelMax} />
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </Grid>
            </Grid>

            <Box>
              <Typography variant="subtitle2">Individual requests</Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
                Every Claude call with its own token usage · click a column to sort · {reqs.total.toLocaleString()}{' '}
                {reqs.total === 1 ? 'request' : 'requests'}{' '}
                {range === 'all' ? 'in total' : range === 'today' ? 'today' : `in the ${period}`}
              </Typography>
              {reqs.items.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No Claude requests in this period.
                </Typography>
              ) : (
                <>
                  {/* No inner scroll box: the page scrolls and pagination keeps the list short. */}
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <SortCell k="at" sort={reqSort} onSort={onReqSort} first="desc">
                            Time
                          </SortCell>
                          <SortCell k="task" sort={reqSort} onSort={onReqSort}>
                            Task
                          </SortCell>
                          <SortCell k="submission" sort={reqSort} onSort={onReqSort}>
                            Submission
                          </SortCell>
                          <SortCell k="model" sort={reqSort} onSort={onReqSort}>
                            Model
                          </SortCell>
                          <SortCell k="input" sort={reqSort} onSort={onReqSort} first="desc" align="right">
                            <TokenHeader kind="input" />
                          </SortCell>
                          <SortCell k="output" sort={reqSort} onSort={onReqSort} first="desc" align="right">
                            <TokenHeader kind="output" />
                          </SortCell>
                          <SortCell k="duration" sort={reqSort} onSort={onReqSort} first="desc" align="right">
                            Duration
                          </SortCell>
                          <SortCell k="status" sort={reqSort} onSort={onReqSort}>
                            Status
                          </SortCell>
                          {canViewTranscripts && (
                            <TableCell>
                              <Box component="span" sx={visuallyHidden}>
                                Transcript
                              </Box>
                            </TableCell>
                          )}
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {reqs.items.map((c) => (
                          <TableRow key={c.id} hover>
                            <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                              <Tooltip title={formatRelative(c.at)}>
                                <span>{formatDateTime(c.at)}</span>
                              </Tooltip>
                            </TableCell>
                            <TableCell>{humanize(c.task)}</TableCell>
                            <TableCell
                              sx={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            >
                              {c.submissionId ? (
                                <Link component={RouterLink} to={paths.submission(c.submissionId)} variant="body2">
                                  {c.applicantName || 'Open'}
                                </Link>
                              ) : (
                                '—'
                              )}
                            </TableCell>
                            <TableCell
                              sx={{
                                fontFamily: 'ui-monospace, Consolas, monospace',
                                fontSize: '0.75rem',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {c.model}
                            </TableCell>
                            <TableCell align="right">
                              <Tokens n={c.inputTokens} kind="input" cached={c.cacheReadTokens} icon={false} />
                            </TableCell>
                            <TableCell align="right">
                              <Tokens n={c.outputTokens} kind="output" icon={false} />
                            </TableCell>
                            <TableCell align="right" sx={num}>
                              {(c.durationMs / 1000).toFixed(1)}s
                            </TableCell>
                            <TableCell>
                              <EnumChip
                                value={c.status}
                                color={llmCallStatusColor(c.status)}
                                title={c.error ?? undefined}
                              />
                            </TableCell>
                            {canViewTranscripts && (
                              <TableCell padding="none">
                                <Tooltip title="View transcript">
                                  <IconButton
                                    size="small"
                                    aria-label={`View transcript of the ${humanize(c.task)} request at ${formatDateTime(c.at)}`}
                                    onClick={() => setTranscriptId(c.id)}
                                  >
                                    <ReceiptLongIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <TablePagination
                    component="div"
                    count={reqs.total}
                    page={reqs.page - 1}
                    rowsPerPage={reqs.pageSize}
                    rowsPerPageOptions={TABLE_ROWS_PER_PAGE_OPTIONS}
                    onPageChange={(_, p) => setPage(p + 1)}
                    onRowsPerPageChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                  />
                </>
              )}
            </Box>
          </Stack>
        </AccordionDetails>
      </Accordion>
      {canViewTranscripts && <TranscriptDialog callId={transcriptId} onClose={() => setTranscriptId(null)} />}
    </Stack>
  );
}
