import CheckIcon from '@mui/icons-material/CheckCircleOutline';
import SyncIcon from '@mui/icons-material/Sync';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ErrorState, Loading, PasswordField } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { api, apiWith, errorMessage } from '../../../services/api';
import { settingsKeys, systemKeys } from '../queryKeys';
import { LimitFields } from './LimitsCard';
import { SettingsPanel } from './SettingsShell';

/** The Anthropic API key and default model. The saved key is never shown; a new one replaces it. */
/** "claude-sonnet-5-5" → "Claude Sonnet 5.5"; unknown shapes are shown as typed. */
function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id.trim());
  if (!m) return id.trim() || 'No model';
  const [, family = '', major = '', minor = ''] = m;
  return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

export function AnthropicCard() {
  const { user } = useAuth();
  const admin = hasPermission(user, 'settings:manage');
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: settingsKeys.anthropic(),
    queryFn: ({ signal }) => apiWith(signal).anthropicSettings(),
  });
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const test = useMutation({ meta: { silentError: true }, mutationFn: api.testAnthropicSettings });
  const toast = useToast();
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: api.saveAnthropicSettings,
    onSuccess: (data) => {
      toast.success(TOAST_MESSAGES.claudeSaved);
      qc.setQueryData(settingsKeys.anthropic(), data);
      // The key and model change what Connections shows (configured, LLM status): refetch both now.
      qc.invalidateQueries({ queryKey: systemKeys.status() });
      qc.invalidateQueries({ queryKey: settingsKeys.connections() });
      setApiKey('');
      setModel(null);
      setConfirmRemove(false);
    },
  });
  const s = settings.data;
  const shownModel = (model ?? s?.model ?? '').trim();
  const modelValid = /^claude-[a-z0-9-.]+$/.test(shownModel);
  const keyValid = apiKey.trim() === '' || apiKey.trim().length >= 20;
  const dirty = !!s && (apiKey.trim() !== '' || shownModel !== s.model);
  const reset = () => {
    test.reset();
    save.reset();
  };
  const input = () => ({ model: shownModel, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });

  return (
    <SettingsPanel
      title="Claude API key and model"
      subtitle="The Anthropic API key and the model reports, extraction and chat use. A skill's own model (for example Haiku for the automatic quote) still applies."
    >
      {settings.isLoading ? (
        <Loading label="Loading settings…" shape="form" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
      ) : s ? (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              color={s.keySet ? 'success' : 'warning'}
              variant={s.keySet ? 'filled' : 'outlined'}
              label={s.keySet ? `API key set ${s.keyHint ?? ''}` : 'No API key'}
            />
            <Chip size="small" variant="outlined" label={`Model: ${s.model}`} />
          </Stack>
          {s.keyError && (
            <Alert severity="error" variant="outlined">
              {s.keyError}
            </Alert>
          )}
          {!s.keySet && !s.keyError && (
            <Alert severity="warning" variant="outlined">
              Without a key, classification falls back to rules and reports, extraction and chat are off.
            </Alert>
          )}
          {admin ? (
            <>
              <PasswordField
                size="small"
                autoComplete="off"
                label={s.keySet ? 'Replace API key' : 'API key'}
                placeholder={s.keySet ? 'Leave empty to keep the saved key' : 'sk-ant-…'}
                value={apiKey}
                onChange={(e) => {
                  reset();
                  setApiKey(e.target.value);
                }}
                error={!keyValid}
                helperText={
                  keyValid
                    ? 'Stored encrypted; it is never shown again.'
                    : 'That does not look like an Anthropic API key'
                }
              />
              <Autocomplete
                freeSolo
                forcePopupIcon
                disableClearable
                autoHighlight
                options={
                  s.suggestedModels.includes(s.defaultModel)
                    ? s.suggestedModels
                    : [s.defaultModel, ...s.suggestedModels]
                }
                value={shownModel}
                inputValue={shownModel}
                onInputChange={(_e, v) => {
                  reset();
                  setModel(v);
                }}
                // Show every model while the box holds a known one; filter only once the user types something new.
                filterOptions={(opts, { inputValue }) => {
                  const q = inputValue.trim().toLowerCase();
                  if (!q || opts.includes(q)) return opts;
                  return opts.filter((o) => o.includes(q));
                }}
                slotProps={{ paper: { elevation: 4, sx: { mt: 0.5 } }, listbox: { sx: { py: 0.5 } } }}
                renderOption={(props, option, { selected }) => {
                  const { key, ...rest } = props;
                  return (
                    <Box
                      component="li"
                      key={key}
                      {...rest}
                      sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: '8px !important' }}
                    >
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={selected ? 600 : 500}>
                          {modelLabel(option)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                          {option}
                        </Typography>
                      </Box>
                      {option === s.defaultModel && (
                        <Chip size="small" variant="outlined" label="Default" sx={{ height: 20, fontSize: '0.7rem' }} />
                      )}
                      {selected && <CheckIcon fontSize="small" color="primary" />}
                    </Box>
                  );
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    size="small"
                    label="Model"
                    placeholder="claude-…"
                    error={!modelValid}
                    helperText={
                      modelValid
                        ? `${modelLabel(shownModel)} · default is ${modelLabel(s.defaultModel)}. Pick one or type any Anthropic model ID.`
                        : 'Use an Anthropic model ID such as claude-opus-5-5'
                    }
                  />
                )}
              />
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button
                  variant="outlined"
                  startIcon={<SyncIcon />}
                  disabled={!modelValid || !keyValid || test.isPending || (!s.keySet && !apiKey.trim())}
                  onClick={() => {
                    reset();
                    test.mutate(input());
                  }}
                >
                  {test.isPending ? 'Testing…' : 'Test connection'}
                </Button>
                <Button
                  variant="contained"
                  disabled={!dirty || !modelValid || !keyValid || save.isPending}
                  onClick={() => {
                    reset();
                    save.mutate(input());
                  }}
                >
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
                {s.keySet && (
                  <Button
                    color="error"
                    variant="text"
                    disabled={save.isPending}
                    onClick={() => {
                      reset();
                      setConfirmRemove(true);
                    }}
                  >
                    Remove key
                  </Button>
                )}
              </Stack>
              {test.isSuccess && (
                <Alert severity={test.data.ok ? 'success' : 'error'}>
                  {test.data.ok ? `${test.data.detail} (${test.data.model})` : test.data.detail}
                </Alert>
              )}
              {test.error && <Alert severity="error">{errorMessage(test.error)}</Alert>}
              {save.error && <Alert severity="error">{errorMessage(save.error)}</Alert>}
              {(test.isPending || save.isPending) && <LinearProgress />}
            </>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Only administrators can change the API key or model.
            </Typography>
          )}
        </Stack>
      ) : null}
      <LimitFields group="claudeOutput" />
      <LimitFields group="claudeTimeout" />
      <Dialog open={confirmRemove} onClose={() => !save.isPending && setConfirmRemove(false)} fullWidth maxWidth="xs">
        <DialogTitle>Remove the API key?</DialogTitle>
        <DialogContent dividers>
          <DialogContentText>
            Reports, extraction, the automatic quote and chat stop working until a new key is saved. Classification
            falls back to rules.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRemove(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={save.isPending || !s}
            onClick={() => s && save.mutate({ model: s.model, apiKey: null })}
          >
            {save.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>
    </SettingsPanel>
  );
}
