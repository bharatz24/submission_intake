import AddIcon from '@mui/icons-material/Add';
import CalculateIcon from '@mui/icons-material/CalculateOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import SaveIcon from '@mui/icons-material/SaveOutlined';
import SearchIcon from '@mui/icons-material/Search';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  FormGroup,
  Grid,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';

import { Loading, UsDateField } from '../../../components/common';
import { useConfirm, useToast } from '../../../components/feedback/FeedbackProvider';
import { STALE_MS, TOAST_MESSAGES } from '../../../constants';
import { UnsavedChangesGuard, useDiscardGuard } from '../../../hooks/useUnsavedChanges';
import { errorWithDetails } from '../../../lib/apiErrors';
import { api, apiWith, errorMessage } from '../../../services/api';
import {
  type Quote,
  type RatingInputs,
  type RatingInputsResponse,
  type RatingSpeciality,
  type SpecialityOption,
  SURGERY_TYPES,
  type SurgeryType,
} from '../../../types';
import { auditKeys } from '../../audit';
import { quoteKeys, rateKeys } from '../queryKeys';
import { limitLabel, money, QuoteBreakdown } from './QuoteBreakdown';

const DATE_KEYS = ['effectiveDate', 'expirationDate', 'retroDate'] as const;

/**
 * Creates a quote by hand. Prefilled from the submission's fields (each value shows where it came from) and the
 * latest quote's underwriter choices. "Calculate" prices without saving; "Save quote" adds the next quote version.
 * With `from` it edits that saved quote instead: prefilled from its inputs, saved either as a new version that leaves
 * it unchanged or over it ("Save changes to vN", same version).
 */
export function QuoteDialog({
  submissionId,
  from,
  onClose,
}: {
  submissionId: string;
  from?: Quote;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const loaded = useQuery({
    queryKey: from ? quoteKeys.editInputs(submissionId, from.id) : quoteKeys.ratingInputs(submissionId),
    queryFn: (): Promise<RatingInputsResponse & { rateGroup?: string }> =>
      from ? api.quoteEditInputs(submissionId, from.id) : api.ratingInputs(submissionId),
    gcTime: 0,
  });
  const base = useQuery({
    queryKey: rateKeys.allOptions(),
    queryFn: ({ signal }) => apiWith(signal).rateOptions(),
    staleTime: STALE_MS.rateOptions,
    retry: false,
  });
  const [draft, setDraft] = useState<RatingInputs | null>(null);
  useEffect(() => {
    if (loaded.data && !draft) setDraft(loaded.data.inputs);
  }, [loaded.data, draft]);
  const state = draft?.state;
  const stateOpts = useQuery({
    queryKey: rateKeys.options(state),
    queryFn: ({ signal }) => apiWith(signal).rateOptions(state),
    enabled: !!state,
    staleTime: STALE_MS.rateOptions,
  });
  const [finder, setFinder] = useState<number | null>(null);
  // Any input changed by the user: closing then asks first.
  const [edited, setEdited] = useState(false);

  const sources = loaded.data?.sources ?? {};
  const src = (k: string) => sources[k] ?? ' ';

  /** Dates left at their default are sent blank, so the server recomputes them from the effective date. */
  const payload = (): RatingInputs => {
    const out: RatingInputs = { ...draft! };
    for (const k of DATE_KEYS) {
      if (k !== 'effectiveDate' && sources[k]?.startsWith('default') && out[k] === loaded.data!.inputs[k])
        delete out[k];
    }
    if (out.limitKey) delete out.limit;
    return out;
  };

  const toast = useToast();
  const preview = useMutation({
    meta: { silentError: true },
    mutationFn: () => api.previewQuote(submissionId, payload()),
  });
  // `overwrite` saves over the quote being edited (same version); otherwise the save adds the next version.
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: ({ overwrite }: { overwrite: boolean }) =>
      overwrite && from
        ? api.updateQuote(submissionId, from.id, payload())
        : api.createQuote(submissionId, payload(), from?.id),
    onSuccess: (q, { overwrite }) => {
      qc.invalidateQueries({ queryKey: quoteKeys.list(submissionId) });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
      toast.success(overwrite ? TOAST_MESSAGES.quoteUpdated(q.version) : TOAST_MESSAGES.quoteSaved(q.version));
      onClose();
    },
  });
  const saving = (overwrite: boolean) => save.isPending && save.variables?.overwrite === overwrite;
  const busy = preview.isPending || save.isPending;
  const dirty = edited && !save.isPending && !save.isSuccess;
  const discard = useDiscardGuard(dirty);

  const set = <K extends keyof RatingInputs>(k: K, v: RatingInputs[K] | undefined) => {
    setEdited(true);
    setDraft((d) => {
      const next = { ...d! };
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete next[k];
      else next[k] = v;
      return next;
    });
    preview.reset();
  };
  const specs = draft?.specialities ?? [];
  // An empty manualReason is kept: it marks a row being rated manually before the reason is typed.
  const setSpec = (i: number, patch: Partial<RatingSpeciality>) =>
    set(
      'specialities',
      specs.map((s, j) =>
        j === i
          ? Object.fromEntries(
              Object.entries({ ...s, ...patch }).filter(
                ([k, v]) => v !== undefined && (v !== '' || k === 'manualReason'),
              ),
            )
          : s,
      ),
    );
  const isManual = (sp: RatingSpeciality) => sp.manualReason !== undefined || sp.manualFactor !== undefined;
  const startManual = (i: number) => setSpec(i, { code: undefined, manualReason: specs[i]?.manualReason ?? '' });
  const stopManual = (i: number) => setSpec(i, { manualFactor: undefined, manualReason: undefined });
  const toggle = (k: 'scheduledCreditKeys' | 'optionalFeeKeys', key: string) => {
    const cur = draft?.[k] ?? [];
    set(k, cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]);
  };
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

  const opts = stateOpts.data ?? base.data;
  const ratesMissing = base.isError;
  // A manually rated row needs its name, a factor in range and a reason before it can be priced.
  const bounds = opts?.manualFactor;
  const manualErrors = specs.map((sp) => {
    if (!isManual(sp)) return null;
    const f = sp.manualFactor;
    return {
      factor:
        f === undefined || Number.isNaN(f)
          ? 'Enter the factor'
          : bounds && (f < bounds.min || f > bounds.max)
            ? `Between ${bounds.min} and ${bounds.max}`
            : null,
      reason: sp.manualReason?.trim() ? null : 'Give a reason: it is shown on the quote and in the audit trail',
      title: sp.title?.trim() ? null : 'Enter the specialty name',
    };
  });
  const manualInvalid = manualErrors.some((e) => e && (e.factor || e.reason || e.title));
  const pricedWith = loaded.data?.rateGroup;

  return (
    <Dialog open onClose={() => !busy && discard(onClose)} fullWidth maxWidth="lg">
      <UnsavedChangesGuard when={dirty} />
      <DialogTitle>{from ? `Edit quote v${from.version}` : 'Create quote'}</DialogTitle>
      <DialogContent dividers>
        {(loaded.isLoading || base.isLoading || !draft) && !loaded.isError && !ratesMissing ? (
          <Loading label="Loading rating inputs…" minHeight={240} shape="form" />
        ) : null}
        {loaded.isError && <Alert severity="error">{errorMessage(loaded.error)}</Alert>}
        {ratesMissing && <Alert severity="error">{errorMessage(base.error)}</Alert>}
        {draft && opts && (
          <Stack spacing={2.5}>
            {from ? (
              <Typography variant="body2" color="text.secondary">
                Prefilled from quote v{from.version}. Save as new version adds a version and leaves v{from.version}{' '}
                unchanged; Save changes to v{from.version} re-prices and replaces v{from.version} itself.
              </Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Prefilled from the submission's fields; the text under each value says where it came from. Changes here
                apply to this quote only. To correct the submission itself, edit the field on Documents &amp; Evidence.
              </Typography>
            )}
            {from && pricedWith && from.rateGroup !== pricedWith && (
              <Alert severity="info">
                Re-priced with rate tables {pricedWith}; v{from.version} used {from.rateGroup}.
              </Alert>
            )}

            <Box>
              <Typography variant="overline">Location</Typography>
              <Grid container spacing={2}>
                <Grid item xs={6} md={3}>
                  <TextField
                    fullWidth
                    size="small"
                    label="ZIP"
                    value={draft.zip ?? ''}
                    onChange={(e) => set('zip', e.target.value.trim())}
                    helperText={src('zip')}
                  />
                </Grid>
                <Grid item xs={6} md={3}>
                  <TextField
                    fullWidth
                    size="small"
                    label="City"
                    value={draft.city ?? ''}
                    onChange={(e) => set('city', e.target.value)}
                    helperText={src('city')}
                  />
                </Grid>
                <Grid item xs={6} md={3}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="State"
                    value={draft.state ?? ''}
                    InputLabelProps={{ shrink: true }}
                    SelectProps={{ displayEmpty: true }}
                    helperText={src('state')}
                    onChange={(e) => {
                      set('state', e.target.value);
                      set('limitKey', undefined);
                    }}
                  >
                    <MenuItem value="">
                      <em>From ZIP</em>
                    </MenuItem>
                    {draft.state && !base.data!.states.includes(draft.state) && (
                      <MenuItem value={draft.state}>{draft.state} (not rated)</MenuItem>
                    )}
                    {base.data!.states.map((st) => (
                      <MenuItem key={st} value={st}>
                        {st}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={6} md={3}>
                  <TextField
                    fullWidth
                    size="small"
                    label="County"
                    value={draft.county ?? ''}
                    onChange={(e) => set('county', e.target.value)}
                    placeholder="From ZIP"
                    InputLabelProps={{ shrink: true }}
                    helperText={src('county')}
                  />
                </Grid>
              </Grid>
            </Box>

            <Box>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="overline">Specialties</Typography>
                <Button size="small" startIcon={<AddIcon />} onClick={() => set('specialities', [...specs, {}])}>
                  Add specialty
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                {sources.specialities}
                {sources.surgeryType && ` · surgery type: ${sources.surgeryType}`}
              </Typography>
              <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Specialty as written</TableCell>
                      <TableCell>Rate class code</TableCell>
                      <TableCell>Surgery type</TableCell>
                      <TableCell width={110}>% of practice</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {specs.map((sp, i) => (
                      <Fragment key={i}>
                        <TableRow sx={isManual(sp) ? { '& > td': { borderBottom: 0 } } : undefined}>
                          <TableCell>
                            <TextField
                              fullWidth
                              size="small"
                              variant="standard"
                              value={sp.title ?? ''}
                              onChange={(e) => setSpec(i, { title: e.target.value })}
                              error={!!manualErrors[i]?.title}
                              helperText={manualErrors[i]?.title ?? undefined}
                            />
                          </TableCell>
                          <TableCell>
                            {isManual(sp) ? (
                              <Stack direction="row" spacing={0.75} alignItems="center">
                                <Chip size="small" color="warning" variant="outlined" label="Manual" />
                                <TextField
                                  size="small"
                                  variant="standard"
                                  type="number"
                                  placeholder="Factor"
                                  value={sp.manualFactor ?? ''}
                                  sx={{ width: 80 }}
                                  inputProps={{
                                    step: 0.01,
                                    min: bounds?.min,
                                    max: bounds?.max,
                                    'aria-label': 'Manual factor',
                                  }}
                                  error={!!manualErrors[i]?.factor}
                                  onChange={(e) => setSpec(i, { manualFactor: num(e.target.value) })}
                                />
                              </Stack>
                            ) : (
                              <TextField
                                size="small"
                                variant="standard"
                                value={sp.code ?? ''}
                                placeholder="best match"
                                onChange={(e) => setSpec(i, { code: e.target.value.trim() })}
                              />
                            )}
                          </TableCell>
                          <TableCell>
                            <TextField
                              select
                              size="small"
                              variant="standard"
                              value={sp.surgeryType ?? ''}
                              SelectProps={{ displayEmpty: true }}
                              sx={{ minWidth: 140 }}
                              onChange={(e) =>
                                setSpec(i, { surgeryType: (e.target.value || undefined) as SurgeryType | undefined })
                              }
                            >
                              <MenuItem value="">
                                <em>Not stated</em>
                              </MenuItem>
                              {SURGERY_TYPES.map((t) => (
                                <MenuItem key={t} value={t}>
                                  {t}
                                </MenuItem>
                              ))}
                            </TextField>
                          </TableCell>
                          <TableCell>
                            <TextField
                              size="small"
                              variant="standard"
                              type="number"
                              value={sp.practicePercent ?? ''}
                              inputProps={{ min: 0, max: 100 }}
                              onChange={(e) => setSpec(i, { practicePercent: num(e.target.value) })}
                            />
                          </TableCell>
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            <Tooltip title="Find the rate class">
                              <span>
                                <IconButton
                                  size="small"
                                  aria-label="Find the rate class"
                                  disabled={!draft.state && !draft.zip}
                                  onClick={() => setFinder(finder === i ? null : i)}
                                >
                                  <SearchIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="Remove">
                              <IconButton
                                size="small"
                                aria-label="Remove speciality"
                                onClick={() => {
                                  set(
                                    'specialities',
                                    specs.filter((_, j) => j !== i),
                                  );
                                  setFinder(null);
                                }}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                        {isManual(sp) && (
                          <TableRow>
                            <TableCell colSpan={5} sx={{ pt: 0 }}>
                              <Stack
                                direction={{ xs: 'column', sm: 'row' }}
                                spacing={1}
                                alignItems={{ sm: 'flex-start' }}
                              >
                                <TextField
                                  fullWidth
                                  size="small"
                                  variant="standard"
                                  label="Reason for the manual factor"
                                  required
                                  value={sp.manualReason ?? ''}
                                  onChange={(e) => setSpec(i, { manualReason: e.target.value })}
                                  error={!!(manualErrors[i]?.factor || (manualErrors[i]?.reason && sp.manualReason))}
                                  helperText={
                                    manualErrors[i]?.factor
                                      ? `Factor: ${manualErrors[i]!.factor}`
                                      : (manualErrors[i]?.reason ??
                                        'No rate class matches this specialty, so it is priced with this factor. Shown on the quote and in the audit trail.')
                                  }
                                />
                                <Button
                                  size="small"
                                  sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                                  onClick={() => stopManual(i)}
                                >
                                  Use a rate class instead
                                </Button>
                              </Stack>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    ))}
                    {!specs.length && (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <Typography variant="body2" color="text.secondary">
                            No specialty in the submission: add one.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
              {specs.length > 1 && (
                <FormControlLabel
                  sx={{ mt: 0.5 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={!!draft.pickHighest}
                      onChange={(e) => set('pickHighest', e.target.checked || undefined)}
                    />
                  }
                  label={
                    <Typography variant="body2">
                      Rate on the highest class instead of the practice split{' '}
                      {sources.pickHighest && (
                        <Typography component="span" variant="caption" color="text.secondary">
                          ({sources.pickHighest})
                        </Typography>
                      )}
                    </Typography>
                  }
                />
              )}
              {finder !== null && specs[finder] && (
                // Keyed per row (and quote session) so its snapshot and search reset when switching rows.
                <ClassFinder
                  key={`${submissionId}:${from?.id ?? 'new'}:${finder}`}
                  submissionId={submissionId}
                  inputs={payload()}
                  index={finder}
                  onPick={(o) => {
                    setSpec(finder, {
                      code: o.code,
                      surgeryType: o.surgeryType,
                      manualFactor: undefined,
                      manualReason: undefined,
                    });
                    setFinder(null);
                  }}
                  onManual={() => {
                    startManual(finder);
                    setFinder(null);
                  }}
                />
              )}
            </Box>

            <Box>
              <Typography variant="overline">Coverage</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Limits"
                    value={draft.limitKey ?? ''}
                    InputLabelProps={{ shrink: true }}
                    SelectProps={{ displayEmpty: true }}
                    helperText={
                      draft.limitKey
                        ? ' '
                        : draft.limit
                          ? `${money(draft.limit.incident)} / ${money(draft.limit.aggregate)} from ${src('limit')}`
                          : 'Not stated: state default'
                    }
                    onChange={(e) => set('limitKey', e.target.value || undefined)}
                    disabled={!opts.limits}
                  >
                    <MenuItem value="">
                      <em>{draft.limit ? 'As requested' : 'State default'}</em>
                    </MenuItem>
                    {(opts.limits ?? []).map((l) => (
                      <MenuItem key={l.key} value={l.key}>
                        {limitLabel(l)} (×{l.factor}){l.isDefault ? ' · default' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                {DATE_KEYS.map((k) => (
                  <Grid item xs={12} sm={4} md={8 / 3} key={k}>
                    <UsDateField
                      fullWidth
                      size="small"
                      value={draft[k] ?? null}
                      helperText={src(k)}
                      label={
                        { effectiveDate: 'Effective date', expirationDate: 'Expiration date', retroDate: 'Retro date' }[
                          k
                        ]
                      }
                      onChange={(iso) => set(k, iso ?? undefined)}
                    />
                  </Grid>
                ))}
                <Grid item xs={6} md={4}>
                  <TextField
                    fullWidth
                    size="small"
                    type="number"
                    label="Hours per week"
                    value={draft.hoursPerWeek ?? ''}
                    inputProps={{ min: 0, max: 168 }}
                    helperText={src('hoursPerWeek')}
                    onChange={(e) => set('hoursPerWeek', num(e.target.value))}
                  />
                </Grid>
                <Grid item xs={6} md={4}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Hours band"
                    value={draft.hoursWorkedKey ?? ''}
                    InputLabelProps={{ shrink: true }}
                    SelectProps={{ displayEmpty: true }}
                    helperText=" "
                    onChange={(e) => set('hoursWorkedKey', e.target.value || undefined)}
                  >
                    <MenuItem value="">
                      <em>From hours per week</em>
                    </MenuItem>
                    {base.data!.hours.map((h) => (
                      <MenuItem key={h.key} value={h.key}>
                        {h.title} (×{h.factor})
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={6} md={4}>
                  <TextField
                    fullWidth
                    size="small"
                    type="number"
                    label="UW credit (−) / debit (+) %"
                    value={draft.uwCreditPercent ?? ''}
                    inputProps={{ step: 0.5, min: -100, max: 100 }}
                    helperText={src('uwCreditPercent')}
                    onChange={(e) => set('uwCreditPercent', num(e.target.value))}
                  />
                </Grid>
              </Grid>
            </Box>

            <Box>
              <Typography variant="overline">Scheduled credits / debits</Typography>
              <FormGroup row>
                {base.data!.scheduledCredits.map((c) => (
                  <FormControlLabel
                    key={c.key}
                    control={
                      <Checkbox
                        size="small"
                        checked={(draft.scheduledCreditKeys ?? []).includes(c.key)}
                        onChange={() => toggle('scheduledCreditKeys', c.key)}
                      />
                    }
                    label={
                      <Typography variant="body2">
                        {c.title} ({c.percent > 0 ? '+' : ''}
                        {c.percent}%)
                      </Typography>
                    }
                  />
                ))}
              </FormGroup>
              {sources.scheduledCreditKeys && (
                <Typography variant="caption" color="text.secondary">
                  {sources.scheduledCreditKeys}
                </Typography>
              )}
            </Box>
            {(opts.ratingFees ?? []).some((x) => !x.required) && (
              <Box>
                <Typography variant="overline">Optional rating fees</Typography>
                <FormGroup row>
                  {(opts.ratingFees ?? [])
                    .filter((x) => !x.required)
                    .map((x) => (
                      <FormControlLabel
                        key={x.key}
                        control={
                          <Checkbox
                            size="small"
                            checked={(draft.optionalFeeKeys ?? []).includes(x.key)}
                            onChange={() => toggle('optionalFeeKeys', x.key)}
                          />
                        }
                        label={
                          <Typography variant="body2">
                            {x.title} ({x.calculate ? `${x.amountOrPercent}%` : money(x.amountOrPercent)})
                          </Typography>
                        }
                      />
                    ))}
                </FormGroup>
              </Box>
            )}
            <TextField
              size="small"
              label="Quote label (optional)"
              placeholder="e.g. Option A: $1M/$3M"
              value={draft.label ?? ''}
              onChange={(e) => set('label', e.target.value)}
              sx={{ maxWidth: 420 }}
            />

            {(preview.data || preview.error) && <Divider />}
            {preview.error && (
              <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
                {errorWithDetails(preview.error)}
              </Alert>
            )}
            {preview.data && (
              <Box>
                <Typography variant="overline">Calculated (not saved)</Typography>
                <QuoteBreakdown
                  status={preview.data.status}
                  total={preview.data.summary?.total ?? null}
                  premium={preview.data.summary?.premium ?? null}
                  factors={preview.data.factors}
                  pricing={preview.data.pricing}
                  flags={preview.data.flags}
                  missing={preview.data.missing}
                />
              </Box>
            )}
            {save.error && (
              <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
                {errorWithDetails(save.error)}
              </Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => discard(onClose)} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="outlined"
          startIcon={<CalculateIcon />}
          disabled={!draft || busy || ratesMissing || manualInvalid}
          onClick={() => preview.mutate()}
        >
          {preview.isPending ? 'Calculating…' : 'Calculate'}
        </Button>
        {from && (
          <Button
            variant="outlined"
            startIcon={<SaveIcon />}
            disabled={!draft || busy || ratesMissing || manualInvalid}
            onClick={() => save.mutate({ overwrite: true })}
          >
            {saving(true) ? 'Saving…' : `Save changes to v${from.version}`}
          </Button>
        )}
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={!draft || busy || ratesMissing || manualInvalid}
          onClick={() => save.mutate({ overwrite: false })}
        >
          {saving(false) ? 'Saving…' : from ? 'Save as new version' : 'Save quote'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Rate classes matching one specialty, each priced with the other inputs. */
function ClassFinder({
  submissionId,
  inputs,
  index,
  onPick,
  onManual,
}: {
  submissionId: string;
  inputs: RatingInputs;
  index: number;
  onPick: (o: SpecialityOption) => void;
  onManual: () => void;
}) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState<string | undefined>(undefined);
  // Inputs as they were when the finder opened; typing elsewhere in the dialog does not re-run the search.
  const [snapshot] = useState(inputs);
  const options = useQuery({
    queryKey: quoteKeys.specialityOptions(submissionId, index, title, snapshot),
    queryFn: ({ signal }) => apiWith(signal).specialityOptions(submissionId, snapshot, index, title),
    // Never ask about a row the snapshot doesn't have.
    enabled: index < (snapshot.specialities?.length ?? 0),
    retry: false,
  });
  // Only for the row's own wording: a search for another wording says nothing about whether the row matches.
  const exact = title === undefined ? options.data?.options.find((o) => o.score === 100) : undefined;
  const confirm = useConfirm();
  const choose = async (o: SpecialityOption) => {
    if (
      o.weak &&
      !(await confirm({
        ...TOAST_MESSAGES.weakClassMatch(`${o.code} ${o.title}`, options.data?.requested ?? ''),
        tone: 'primary',
      }))
    )
      return;
    onPick(o);
  };
  return (
    <Box sx={{ mt: 1.5, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="Search another wording, e.g. urgent care, FP, phlebology"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setTitle(text.trim() || undefined)}
        />
        <Button variant="outlined" startIcon={<SearchIcon />} onClick={() => setTitle(text.trim() || undefined)}>
          Search
        </Button>
      </Stack>
      {options.isLoading && <Loading label="Matching and pricing…" minHeight={120} shape="list" />}
      {options.isError && <Alert severity="warning">{errorMessage(options.error)}</Alert>}
      {options.data?.note && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {options.data.note}
        </Alert>
      )}
      {!!options.data?.options.length && (
        <TableContainer sx={{ maxHeight: 320 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Class</TableCell>
                <TableCell>Surgery</TableCell>
                <TableCell align="right">Factor</TableCell>
                <TableCell>Match</TableCell>
                <TableCell align="right">Total</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {options.data.options.map((o, i) => (
                <TableRow key={i} hover>
                  <TableCell>
                    <b>{o.code}</b> {o.title}{' '}
                    {o.recommended && <Chip size="small" color="success" label="Best match" />}{' '}
                    {o.lowestPremium && <Chip size="small" color="primary" label="Lowest premium" />}{' '}
                    {o.weak && <Chip size="small" color="warning" label="Weak match" />}
                  </TableCell>
                  <TableCell>{o.surgeryType}</TableCell>
                  <TableCell align="right">{o.specialityClass}</TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {o.matchedFrom}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    {o.quote.total !== null ? (
                      money(o.quote.total)
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        {o.quote.missing[0] || 'incomplete'}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" variant={o.recommended ? 'contained' : 'outlined'} onClick={() => choose(o)}>
                      Use
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {!options.isLoading &&
        // An exact match is rated from the rate table; otherwise the underwriter may enter a factor.
        (exact ? (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
            “{options.data?.requested}” matches {exact.code} exactly, so it is rated with the rate table's factor.
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              No class right for this specialty?
            </Typography>
            <Button size="small" onClick={onManual}>
              None of these fit — enter a factor
            </Button>
          </Stack>
        ))}
    </Box>
  );
}
