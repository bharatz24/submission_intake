import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { Alert, Box, Button, IconButton, InputAdornment, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, Loading } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import {
  formatLimit,
  LIMIT_FIELDS,
  LIMIT_GROUPS,
  limitErrors,
  type LimitGroupKey,
  limitHelper,
  useLimits,
} from '../../../lib/limits';
import { formatDateTime } from '../../../lib/status';
import { api, errorMessage } from '../../../services/api';
import type { LimitsKey } from '../../../types';
import { settingsKeys, systemKeys } from '../queryKeys';
import { SettingsPanel } from './SettingsShell';

/**
 * A button label that switches to `busyLabel` without changing width: both labels sit in the same grid cell and the
 * hidden one still takes space, so the button (and its table column) is always as wide as the longer of the two.
 */
export function StableLabel({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <Box component="span" sx={{ display: 'inline-grid', '& > span': { gridArea: '1 / 1', textAlign: 'center' } }}>
      <span style={{ visibility: busy ? 'hidden' : 'visible' }}>{label}</span>
      <span style={{ visibility: busy ? 'visible' : 'hidden' }}>{busyLabel}</span>
    </Box>
  );
}

/** Settings → Limits: upload sizes and how much document text is read. Token caps and timeouts sit with Claude and Connections. */
export function LimitsCard() {
  return (
    <SettingsPanel
      title="Limits"
      subtitle="How large uploads may be and how much of each document is read. Changes apply right away."
    >
      <LimitFields group="uploads" first />
      <LimitFields group="documentText" />
    </SettingsPanel>
  );
}

type LimitRow = {
  id: LimitsKey;
  label: string;
  unit: string;
  saved: number;
  byDefault: number;
  min: number;
  max: number;
  helper: string;
};

/**
 * One group of admin-editable limits (LIMIT_GROUPS): a number input per key with its unit, default and allowed range,
 * a per-field reset, and one Save that sends only the changed keys (null resets a key to its default).
 */
export function LimitFields({ group, first }: { group: LimitGroupKey; first?: boolean }) {
  const { user } = useAuth();
  const admin = hasPermission(user, 'settings:manage');
  const qc = useQueryClient();
  const def = LIMIT_GROUPS[group];
  const limits = useLimits();
  // A typed value, or null for "reset to default"; rows not in the draft show the saved value.
  const [draft, setDraft] = useState<Partial<Record<LimitsKey, string | null>>>({});
  const toast = useToast();
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.saveLimitsSettings,
    onSuccess: (data) => {
      qc.setQueryData(settingsKeys.limits(), data);
      // Timeouts shape the connection checks: show Connections as re-checked with the saved values.
      qc.invalidateQueries({ queryKey: settingsKeys.connections() });
      qc.invalidateQueries({ queryKey: systemKeys.status() });
      setDraft({});
      toast.success(TOAST_MESSAGES.limitsSaved);
    },
  });
  const s = limits.data;
  const wrap = (body: ReactNode) => (
    <Box
      component="section"
      aria-label={def.title}
      sx={first ? undefined : { mt: 3, pt: 3, borderTop: 1, borderColor: 'divider' }}
    >
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" component="h3">
          {def.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="p">
          {def.description}
        </Typography>
      </Box>
      {body}
    </Box>
  );
  if (limits.isLoading) return wrap(<Loading label="Loading limits…" shape="form" />);
  if (limits.isError) return wrap(<ErrorState error={limits.error} onRetry={() => limits.refetch()} />);
  if (!s) return null;

  const rows: LimitRow[] = def.keys.map((k) => ({
    id: k,
    label: LIMIT_FIELDS[k].label,
    unit: LIMIT_FIELDS[k].unit,
    saved: s.values[k],
    byDefault: s.defaults[k],
    min: s.bounds[k].min,
    max: s.bounds[k].max,
    helper: limitHelper(s, k),
  }));
  const rowOf = (id: LimitsKey) => rows.find((r) => r.id === id);
  const shown = (r: LimitRow): string => {
    const d = draft[r.id];
    return d === null ? String(r.byDefault) : (d ?? String(r.saved));
  };
  const numberOf = (id: LimitsKey): number => {
    const r = rowOf(id);
    if (!r) return s.values[id]; // keys outside this group count at their saved value
    const t = shown(r).trim();
    return /^\d+$/.test(t) ? Number(t) : NaN;
  };
  const errors = limitErrors(s, def.keys, numberOf);
  const changes: Partial<Record<LimitsKey, number | null>> = {};
  for (const r of rows) {
    const d = draft[r.id];
    if (d === undefined || (d === null ? r.saved === r.byDefault : numberOf(r.id) === r.saved)) continue;
    changes[r.id] = d === null ? null : numberOf(r.id);
  }
  const dirty = Object.keys(changes).length > 0;
  const invalid = Object.keys(errors).length > 0;
  const edit = (id: LimitsKey, v: string | null) => {
    save.reset();
    setDraft((prev) => ({ ...prev, [id]: v }));
  };

  return wrap(
    <Stack spacing={2.5}>
      {/* A plain CSS grid: flush with the group title on the left and the Save button on the right, no gutter offset. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          columnGap: 3,
          rowGap: 2.5,
        }}
      >
        {rows.map((r) => {
          const atDefault = draft[r.id] === null || (draft[r.id] === undefined && r.saved === r.byDefault);
          return (
            <TextField
              key={r.id}
              fullWidth
              size="small"
              type="number"
              label={r.label}
              value={shown(r)}
              disabled={!admin || save.isPending}
              onChange={(e) => edit(r.id, e.target.value)}
              error={!!errors[r.id]}
              helperText={errors[r.id] ?? r.helper}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    {r.unit}
                    {admin && (
                      <Tooltip title={atDefault ? '' : `Reset to default (${formatLimit(r.byDefault)})`}>
                        <span>
                          <IconButton
                            size="small"
                            edge="end"
                            sx={{ ml: 0.5 }}
                            disabled={save.isPending || atDefault}
                            aria-label={`Reset ${r.label} to default`}
                            onClick={() => edit(r.id, null)}
                          >
                            <RestartAltIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    )}
                  </InputAdornment>
                ),
                inputProps: { min: r.min, max: r.max, step: 1 },
              }}
            />
          );
        })}
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Stack sx={{ flexGrow: 1 }}>
          {s.updatedAt && (
            <Typography variant="caption" color="text.secondary">
              Last changed {s.updatedBy ? `by ${s.updatedBy} ` : ''}on {formatDateTime(s.updatedAt)}
            </Typography>
          )}
          {!admin && (
            <Typography variant="caption" color="text.secondary">
              Only administrators can change these limits.
            </Typography>
          )}
        </Stack>
        {admin && (
          <>
            <Button
              disabled={Object.keys(draft).length === 0 || save.isPending}
              onClick={() => {
                save.reset();
                setDraft({});
              }}
            >
              Discard
            </Button>
            <Button
              variant="contained"
              disabled={!dirty || invalid || save.isPending}
              onClick={() => save.mutate(changes)}
            >
              {save.isPending ? 'Saving…' : `Save ${def.title.toLowerCase()}`}
            </Button>
          </>
        )}
      </Stack>
      {save.error && <Alert severity="error">{errorMessage(save.error)}</Alert>}
    </Stack>,
  );
}
