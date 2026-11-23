import DownloadIcon from '@mui/icons-material/FileDownloadOutlined';
import SyncIcon from '@mui/icons-material/Sync';
import TableChartIcon from '@mui/icons-material/TableChartOutlined';
import UploadFileIcon from '@mui/icons-material/UploadFileOutlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
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
import { alpha, useTheme } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useRef, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, Loading } from '../../../components/common';
import { uploadCaption, uploadProblem, useLimits, workbookUploadLimit } from '../../../lib/limits';
import { formatDateTime, formatRelative } from '../../../lib/status';
import { api, apiWith, downloadRateWorkbook, errorMessage } from '../../../services/api';
import type { RateWorkbookInfo, RateWorkbookKey } from '../../../types';
import { quoteKeys, rateKeys } from '../../submissions';
import { StableLabel } from './LimitsCard';
import { SettingsPanel } from './SettingsShell';

/** Rate tables quotes are priced from, and the ZIP-to-county data that picks the territory. */
export function RatesCard() {
  const { user } = useAuth();
  const admin = hasPermission(user, 'rate:manage');
  const theme = useTheme();
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: rateKeys.groups(), queryFn: ({ signal }) => apiWith(signal).rateGroups() });
  const onImported = () => {
    qc.invalidateQueries({ queryKey: rateKeys.all() });
    qc.invalidateQueries({ queryKey: rateKeys.allOptions() });
    qc.invalidateQueries({ queryKey: quoteKeys.allRatingInputs() });
  };
  // Their errors show in the card's Alert below, not as a toast.
  const geo = useMutation({ meta: { silentError: true }, mutationFn: api.importGeo, onSuccess: onImported });
  const single = useMutation({
    meta: { silentError: true },
    mutationFn: api.importRateWorkbook,
    onSuccess: onImported,
  });
  const exportBook = useMutation({ meta: { silentError: true }, mutationFn: downloadRateWorkbook });
  const busy = geo.isPending || single.isPending;
  const d = groups.data;
  const active = d?.groups.find((g) => g.isActive);
  const err = geo.error ?? single.error ?? exportBook.error;
  const resetAll = () => {
    geo.reset();
    single.reset();
    exportBook.reset();
    setTooBig(null);
  };
  // One hidden file input serves every workbook row; `target` says which workbook the chosen file is for.
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<RateWorkbookKey | null>(null);
  const limits = useLimits();
  const workbookLimit = workbookUploadLimit(limits.data);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const pickFile = (workbook: RateWorkbookKey) => {
    setTarget(workbook);
    fileInput.current?.click();
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !target) return;
    resetAll();
    // Checked here first for a clear message; the server enforces the same limit.
    const problem = uploadProblem([file], workbookLimit);
    setTooBig(problem);
    if (!problem) single.mutate({ workbook: target, file });
  };
  const workbookLabel = (key: string) => d?.workbooks.find((w) => w.workbook === key)?.label ?? key;
  // Busy rows show a spinner in place of the icon; labels stay the same so the column never changes width.
  const exporting = (key: string) => exportBook.isPending && exportBook.variables === key;
  const importing = (key: string) => single.isPending && single.variables?.workbook === key;

  const workbookRow = (w: RateWorkbookInfo) => (
    <TableRow key={w.workbook} hover>
      <TableCell>
        <Typography variant="body2">{w.label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {w.workbook}_*.xlsx
        </Typography>
      </TableCell>
      <TableCell>
        {Object.entries(w.rows)
          .map(([k, n]) => `${n.toLocaleString()} ${k.replace(/_/g, ' ')}`)
          .join(' · ')}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Tooltip title={!active ? 'No rates loaded yet' : ''}>
          <span>
            <Button
              size="small"
              disabled={!active}
              startIcon={exporting(w.workbook) ? <CircularProgress size={16} color="inherit" /> : <DownloadIcon />}
              aria-busy={exporting(w.workbook)}
              onClick={() => {
                if (!exporting(w.workbook)) {
                  exportBook.reset();
                  exportBook.mutate(w.workbook);
                }
              }}
            >
              <StableLabel busy={exporting(w.workbook)} label="Export" busyLabel="Exporting…" />
            </Button>
          </span>
        </Tooltip>
        {admin && (
          <Button
            size="small"
            disabled={busy}
            aria-busy={importing(w.workbook)}
            startIcon={importing(w.workbook) ? <CircularProgress size={16} color="inherit" /> : <UploadFileIcon />}
            onClick={() => pickFile(w.workbook)}
          >
            <StableLabel busy={importing(w.workbook)} label="Import" busyLabel="Importing…" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );

  return (
    <SettingsPanel
      title="Rate tables"
      fullWidth
      subtitle="Quotes are priced from the active rate group. A submission keeps the rate group it was first quoted with."
    >
      {groups.isLoading ? (
        <Loading label="Loading rate tables…" shape="table" />
      ) : groups.isError ? (
        <ErrorState error={groups.error} onRetry={() => groups.refetch()} />
      ) : d ? (
        <Stack spacing={2}>
          {active ? (
            <Paper
              variant="outlined"
              sx={{
                px: 1.5,
                py: 0.75,
                display: 'flex',
                alignItems: 'center',
                columnGap: 1.25,
                rowGap: 0.5,
                flexWrap: 'wrap',
                borderLeft: 3,
                borderLeftColor: 'success.main',
                bgcolor: alpha(theme.palette.success.main, 0.04),
              }}
            >
              <TableChartIcon color="success" fontSize="small" />
              <Typography variant="body2" color="text.secondary">
                Active rate group
              </Typography>
              <Typography variant="body2" fontWeight={600} sx={{ wordBreak: 'break-all' }}>
                {active.name}
              </Typography>
              <Box sx={{ flexGrow: 1 }} />
              <Tooltip title={formatDateTime(active.importedAt)}>
                <Typography variant="caption" color="text.secondary">
                  Imported {formatRelative(active.importedAt)}
                </Typography>
              </Tooltip>
            </Paper>
          ) : (
            <Alert severity="warning" variant="outlined">
              No rates are loaded, so quotes cannot be priced. Import each workbook below.
            </Alert>
          )}
          {!d.geo.zips && (
            <Alert severity="warning" variant="outlined">
              No ZIP data is loaded, so the county (and territory) must come from the address.
            </Alert>
          )}
          {d.groups.length > 1 && (
            <Box>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 0.5 }}>
                Previous rate groups (kept for quotes already priced with them)
              </Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {d.groups
                  .filter((g) => !g.isActive)
                  .map((g) => (
                    <Tooltip key={g.name} title={`Imported ${formatDateTime(g.importedAt)}`}>
                      <Chip size="small" variant="outlined" label={g.name} />
                    </Tooltip>
                  ))}
              </Stack>
            </Box>
          )}
          <Box>
            <Typography variant="subtitle2">Lookups</Typography>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
              {admin
                ? 'Download a workbook to see or edit it; upload it to update just that table. An upload creates a new active rate group with the other tables copied from the current one, so quotes already priced keep their rates.'
                : 'Download a workbook to see the rates in the active rate group. Only administrators can upload workbooks or load ZIP data.'}
            </Typography>
            {admin && workbookLimit && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: -0.5, mb: 1 }}>
                .xlsx, {uploadCaption(workbookLimit).replace(/^Up/, 'up')}
              </Typography>
            )}
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onFile}
            />
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Lookup</TableCell>
                    <TableCell>Rows</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow hover>
                    <TableCell>
                      <Typography variant="body2">ZIP codes to county</Typography>
                      <Typography variant="caption" color="text.secondary">
                        Downloaded from Census and GeoNames (about 7 MB)
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {d.geo.zips
                        ? `${d.geo.zips.toLocaleString()} ZIPs · ${d.geo.zipCounties.toLocaleString()} ZIP–county rows`
                        : 'Not loaded'}
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {admin && (
                        <Button
                          size="small"
                          disabled={busy}
                          aria-busy={geo.isPending}
                          startIcon={geo.isPending ? <CircularProgress size={16} color="inherit" /> : <SyncIcon />}
                          onClick={() => {
                            resetAll();
                            geo.mutate();
                          }}
                        >
                          <StableLabel
                            busy={geo.isPending}
                            label={d.geo.zips ? 'Reload ZIP data' : 'Load ZIP data'}
                            busyLabel="Downloading…"
                          />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {d.workbooks.map(workbookRow)}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
          {tooBig && (
            <Alert severity="error" onClose={() => setTooBig(null)}>
              {tooBig} Nothing was uploaded.
            </Alert>
          )}
          {err && (
            <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
              {errorMessage(err)}
            </Alert>
          )}
          {single.isSuccess && (
            <Alert severity="success">
              {workbookLabel(single.data.workbook)} imported from {single.data.file} as rate group{' '}
              {single.data.rateGroup}
              {single.data.basedOn
                ? ` (other tables copied from ${single.data.basedOn})`
                : ' (no other tables loaded yet)'}
              ; it is now active for new quotes.
            </Alert>
          )}
          {geo.isSuccess && (
            <Alert severity="success">
              Loaded {geo.data.zips.toLocaleString()} ZIP codes ({geo.data.multiCountyZips.toLocaleString()} span more
              than one county).
            </Alert>
          )}
          {busy && <LinearProgress />}
        </Stack>
      ) : null}
    </SettingsPanel>
  );
}
