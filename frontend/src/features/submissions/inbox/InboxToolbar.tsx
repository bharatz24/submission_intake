import DeleteIcon from '@mui/icons-material/DeleteOutline';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import SyncIcon from '@mui/icons-material/Sync';
import { Box, Button, Chip, InputAdornment, MenuItem, Stack, Tab, Tabs, TextField, Tooltip } from '@mui/material';

import { EnumChip } from '../../../components/common';
import { classificationColor, submissionStatusColor } from '../../../lib/status';
import { errorMessage } from '../../../services/api';
import type { InboxView, SubmissionPage } from '../../../types';
import { SUBMISSION_CLASSIFICATIONS, SUBMISSION_STATUSES, VIEWS } from './inboxOptions';
import type { InboxActions } from './useInboxActions';
import type { InboxParams } from './useInboxParams';

const ACTION_SX = { whiteSpace: 'nowrap', flexShrink: 0, alignSelf: { md: 'stretch' }, px: 2 } as const;

/** The inbox's tabs (with counts), search, per-tab filters and bulk actions. */
export function InboxToolbar({
  p,
  list,
  actions,
  extraCounts,
  writable,
  canDelete,
}: {
  p: InboxParams;
  list: SubmissionPage | undefined;
  actions: InboxActions;
  /** Rows not in the list that a tab also counts: failed Gmail imports (Errors) and emails skipped at intake (Ignored). */
  extraCounts: Partial<Record<InboxView, number>>;
  writable: boolean;
  canDelete: boolean;
}) {
  const { view } = p;
  const counts = list?.counts;
  const { selected } = actions.selection;
  return (
    <>
      <Tabs
        value={view}
        onChange={(_, v: InboxView) =>
          p.update({
            view: v === 'submissions' ? null : v,
            page: null,
            status: null,
            classification: null,
            strength: null,
          })
        }
        sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        {VIEWS.map((v) => (
          <Tab
            key={v.key}
            value={v.key}
            label={
              <Stack direction="row" spacing={0.75} alignItems="center">
                <span>{v.label}</span>
                {counts && (
                  <Chip
                    size="small"
                    label={counts[v.key] + (extraCounts[v.key] ?? 0)}
                    variant={list?.unread[v.key] ? 'filled' : 'outlined'}
                    color={list?.unread[v.key] ? 'primary' : 'default'}
                    title={`${list?.unread[v.key] ?? 0} unread`}
                    sx={{ height: 18, fontSize: '0.65rem' }}
                  />
                )}
              </Stack>
            }
          />
        ))}
      </Tabs>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ p: 1.5 }} alignItems={{ md: 'center' }}>
        <TextField
          placeholder="Search subject, sender, applicant…"
          value={p.search}
          onChange={(e) => p.setSearch(e.target.value)}
          sx={{ flex: 1, minWidth: 220 }}
          inputProps={{ 'aria-label': 'Search the inbox' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        {view === 'submissions' && (
          <>
            <TextField
              select
              label="Status"
              value={p.status}
              onChange={(e) => p.update({ status: e.target.value, page: null })}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">All statuses</MenuItem>
              {SUBMISSION_STATUSES.map((s) => (
                <MenuItem key={s} value={s}>
                  <EnumChip value={s} color={submissionStatusColor(s)} />
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Classification"
              value={p.classification}
              onChange={(e) => p.update({ classification: e.target.value, page: null })}
              sx={{ minWidth: 190 }}
            >
              <MenuItem value="">All classifications</MenuItem>
              {SUBMISSION_CLASSIFICATIONS.map((c) => (
                <MenuItem key={c} value={c}>
                  <EnumChip value={c} color={classificationColor(c)} />
                </MenuItem>
              ))}
            </TextField>
          </>
        )}
        {view === 'duplicates' && (
          <TextField
            select
            label="Match"
            value={p.strength}
            onChange={(e) => p.update({ strength: e.target.value, page: null })}
            sx={{ minWidth: 190 }}
          >
            <MenuItem value="">All matches</MenuItem>
            <MenuItem value="POSSIBLE">Possible only</MenuItem>
          </TextField>
        )}
        {!!list?.unread[view] && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<DoneAllIcon />}
            disabled={actions.readAll.isPending}
            onClick={() => actions.readAll.mutate()}
            sx={ACTION_SX}
          >
            {p.hasFilters ? 'Mark matching read' : `Mark all read (${list.unread[view]})`}
          </Button>
        )}
        {view === 'errors' && writable && !!list?.total && (
          <Button
            size="small"
            variant="contained"
            startIcon={<RefreshIcon />}
            disabled={actions.retryAll.isPending}
            onClick={() => actions.retryAll.mutate()}
            sx={ACTION_SX}
          >
            {actions.retryAll.isPending ? 'Queuing…' : `Retry all from failed step (${list.total})`}
          </Button>
        )}
        {view === 'submissions' && actions.ims2.configured && writable && (
          <Tooltip
            title={
              actions.ims2.sync.isError
                ? `Sync failed: ${errorMessage(actions.ims2.sync.error)}`
                : 'Read which IMS 2 intakes were linked or rejected, and refresh the workflow status and policy number of linked ones'
            }
          >
            <Box component="span" sx={{ display: 'flex', flexShrink: 0, alignSelf: { md: 'stretch' } }}>
              <Button
                size="small"
                variant="outlined"
                color={actions.ims2.sync.isError ? 'error' : 'primary'}
                startIcon={<SyncIcon />}
                disabled={actions.ims2.syncing}
                onClick={() => actions.ims2.sync.mutate()}
                sx={{ whiteSpace: 'nowrap', px: 2 }}
              >
                {actions.ims2.syncing ? 'Syncing…' : 'Sync IMS status'}
              </Button>
            </Box>
          </Tooltip>
        )}
        {canDelete &&
          !!list?.total &&
          (selected.size ? (
            <Button
              size="small"
              color="error"
              variant="contained"
              startIcon={<DeleteIcon />}
              onClick={() => actions.deletion.setTarget('selected')}
              sx={ACTION_SX}
            >
              Delete selected ({selected.size})
            </Button>
          ) : (
            <Button
              size="small"
              color="error"
              variant="outlined"
              startIcon={<DeleteIcon />}
              onClick={() => actions.deletion.setTarget('all')}
              sx={ACTION_SX}
            >
              {p.hasFilters ? `Delete matching (${list.total})` : `Delete all (${list.total})`}
            </Button>
          ))}
        {p.hasFilters && (
          <Button size="small" onClick={p.clearFilters}>
            Clear
          </Button>
        )}
      </Stack>
    </>
  );
}
