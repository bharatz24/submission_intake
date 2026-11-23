// Settings > Claude skills: view a skill's files, and (admins) edit them. backend/skills/ on disk is the shipped
// default; a save is stored as a revision that overrides that file, so the next report records a new skill version.
import { markdown } from '@codemirror/lang-markdown';
import CloseIcon from '@mui/icons-material/Close';
import RestoreIcon from '@mui/icons-material/Restore';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CodeMirror, { EditorState, EditorView } from '@uiw/react-codemirror';
import { useState } from 'react';
import CodeMirrorMerge from 'react-codemirror-merge';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ConfirmDialog, ErrorState, Loading, Markdown } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES } from '../../../constants';
import { UnsavedChangesGuard } from '../../../hooks/useUnsavedChanges';
import { formatDateTime } from '../../../lib/status';
import { api, ApiError, apiWith, errorMessage } from '../../../services/api';
import type { SkillFile, SkillInfo, SkillRevision } from '../../../types';
import { skillKeys } from '../queryKeys';

type Mode = 'edit' | 'preview' | 'diff';
const EDITOR_HEIGHT = 'calc(100vh - 230px)';
const READ_ONLY = [EditorView.editable.of(false), EditorState.readOnly.of(true)];
const BASE_EXTENSIONS = [markdown(), EditorView.lineWrapping];

export function SkillEditorDialog({ skill, onClose }: { skill: SkillInfo; onClose: () => void }) {
  const { user } = useAuth();
  const admin = hasPermission(user, 'skill:edit');
  const qc = useQueryClient();
  const [path, setPath] = useState('SKILL.md');
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('edit');
  const [saveOpen, setSaveOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [note, setNote] = useState('');
  // An action waiting on "discard unsaved changes?": switch file, or close.
  const [pending, setPending] = useState<(() => void) | null>(null);

  const file = useQuery({
    queryKey: skillKeys.file(skill.name, path),
    queryFn: ({ signal }) => apiWith(signal).skillFile(skill.name, path),
  });
  const revisions = useQuery({
    queryKey: skillKeys.revisions(skill.name, path),
    queryFn: ({ signal }) => apiWith(signal).skillRevisions(skill.name, path),
  });

  const text = draft ?? file.data?.content ?? '';
  const dirty = draft !== null && !!file.data && draft !== file.data.content;

  const toast = useToast();
  const afterChange = (saved: SkillFile) => {
    qc.setQueryData(skillKeys.file(skill.name, path), saved);
    qc.invalidateQueries({ queryKey: skillKeys.revisions(skill.name, path) });
    qc.invalidateQueries({ queryKey: skillKeys.all() });
    setDraft(null);
  };
  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () =>
      api.saveSkillFile(skill.name, { path, content: text, baseHash: file.data!.hash, note: note.trim() }),
    onSuccess: (saved) => {
      afterChange(saved);
      setSaveOpen(false);
      setNote('');
      toast.success(TOAST_MESSAGES.skillSaved(path));
    },
  });
  const reset = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.resetSkillFile(skill.name, path),
    onSuccess: (saved) => {
      afterChange(saved);
      setResetOpen(false);
      toast.success(TOAST_MESSAGES.skillReset(path));
    },
  });
  const conflict = save.error instanceof ApiError && save.error.status === 409;

  const guarded = (action: () => void) => (dirty ? setPending(() => action) : action());
  const openFile = (p: string) =>
    guarded(() => {
      setPath(p);
      setDraft(null);
      save.reset();
    });
  const close = () => guarded(onClose);
  const reloadLatest = () => {
    setDraft(null);
    save.reset();
    void file.refetch();
  };
  const restore = (r: SkillRevision) => {
    setDraft(r.reset ? file.data!.defaultContent : (r.content ?? ''));
    setMode('edit');
  };

  const overridden = new Set(skill.overridden);
  const version = file.data?.skillVersion ?? skill.version;

  return (
    <Dialog open fullScreen onClose={close}>
      {/* Switching file and closing already ask (guarded); this covers tab close and Back. */}
      <UnsavedChangesGuard when={dirty && !save.isPending} />
      <DialogTitle sx={{ py: 1.25, pr: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h6" sx={{ flexGrow: 1, minWidth: 0 }} noWrap>
            Skill: {skill.name}
          </Typography>
          <Chip size="small" variant="outlined" label={`v${version}`} />
          {!admin && <Chip size="small" label="Read only" />}
          <IconButton onClick={close} aria-label="Close">
            <CloseIcon />
          </IconButton>
        </Stack>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ p: 0, display: 'flex', flexDirection: { xs: 'column', md: 'row' }, minHeight: 0 }}>
        {/* Files */}
        <Box
          sx={{
            width: { md: 240 },
            flexShrink: 0,
            borderRight: { md: 1 },
            borderBottom: { xs: 1, md: 0 },
            borderColor: 'divider',
            overflow: 'auto',
          }}
        >
          <List dense disablePadding>
            {skill.files.map((f) => (
              <ListItemButton key={f} selected={f === path} onClick={() => f !== path && openFile(f)}>
                <ListItemText
                  primary={f}
                  primaryTypographyProps={{
                    sx: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.8rem', wordBreak: 'break-all' },
                  }}
                />
                {overridden.has(f) && (
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label="edited"
                    sx={{ height: 18, fontSize: '0.65rem', ml: 0.5 }}
                  />
                )}
              </ListItemButton>
            ))}
          </List>
        </Box>

        {/* Editor */}
        <Box sx={{ flexGrow: 1, minWidth: 0, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v: Mode | null) => v && setMode(v)}>
              <ToggleButton value="edit">{admin ? 'Edit' : 'Source'}</ToggleButton>
              <ToggleButton value="preview">Preview</ToggleButton>
              <ToggleButton value="diff">Diff with default</ToggleButton>
            </ToggleButtonGroup>
            {file.data?.overridden ? (
              <Chip size="small" color="warning" label="Edited in Settings (overrides the default)" />
            ) : (
              <Chip size="small" variant="outlined" label="Shipped default" />
            )}
            {dirty && <Chip size="small" color="info" label="Unsaved changes" />}
            <Box sx={{ flexGrow: 1 }} />
            {admin && (
              <>
                <Button disabled={!dirty} onClick={() => setDraft(null)}>
                  Discard
                </Button>
                <Button color="warning" disabled={!file.data?.overridden || dirty} onClick={() => setResetOpen(true)}>
                  Reset to default
                </Button>
                <Button variant="contained" disabled={!dirty} onClick={() => setSaveOpen(true)}>
                  Save
                </Button>
              </>
            )}
          </Stack>
          {conflict && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={reloadLatest}>
                  Reload latest
                </Button>
              }
            >
              {errorMessage(save.error)} Reloading discards your changes; copy them first if you need them.
            </Alert>
          )}
          {file.isLoading ? (
            <Loading label="Loading file…" />
          ) : file.isError ? (
            <ErrorState error={file.error} onRetry={() => file.refetch()} title="Could not load skill file" />
          ) : file.data ? (
            <Paper variant="outlined" sx={{ overflow: 'hidden', flexGrow: 1 }}>
              {mode === 'edit' && (
                <CodeMirror
                  value={text}
                  height={EDITOR_HEIGHT}
                  extensions={admin ? BASE_EXTENSIONS : [...BASE_EXTENSIONS, ...READ_ONLY]}
                  onChange={(v) => setDraft(v)}
                  basicSetup={{ foldGutter: false }}
                />
              )}
              {mode === 'preview' && (
                <Box sx={{ p: 2.5, height: EDITOR_HEIGHT, overflow: 'auto' }}>
                  <Markdown>{text}</Markdown>
                </Box>
              )}
              {mode === 'diff' && (
                <Box sx={{ height: EDITOR_HEIGHT, overflow: 'auto' }}>
                  <Stack direction="row" sx={{ px: 1.5, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                      Shipped default (backend/skills)
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                      {dirty ? 'Your unsaved text' : 'Active text'}
                    </Typography>
                  </Stack>
                  <CodeMirrorMerge>
                    <CodeMirrorMerge.Original
                      value={file.data.defaultContent}
                      extensions={[...BASE_EXTENSIONS, ...READ_ONLY]}
                    />
                    <CodeMirrorMerge.Modified value={text} extensions={[...BASE_EXTENSIONS, ...READ_ONLY]} />
                  </CodeMirrorMerge>
                </Box>
              )}
            </Paper>
          ) : null}
        </Box>

        {/* History */}
        <Box
          sx={{
            width: { md: 300 },
            flexShrink: 0,
            borderLeft: { md: 1 },
            borderTop: { xs: 1, md: 0 },
            borderColor: 'divider',
            overflow: 'auto',
            p: 1.5,
          }}
        >
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            History of {path}
          </Typography>
          {revisions.isLoading ? (
            <Loading label="Loading history…" minHeight={60} shape="list" />
          ) : revisions.isError ? (
            <ErrorState error={revisions.error} onRetry={() => revisions.refetch()} />
          ) : !revisions.data?.length ? (
            <Typography variant="body2" color="text.secondary">
              Never edited: the shipped default is in use.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {revisions.data.map((r, i) => (
                <Paper key={r.id} variant="outlined" sx={{ p: 1 }}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Chip
                      size="small"
                      label={r.reset ? 'Reset to default' : 'Edit'}
                      color={r.reset ? 'default' : 'primary'}
                      variant="outlined"
                    />
                    {i === 0 && <Chip size="small" color="success" label="active" />}
                    <Box sx={{ flexGrow: 1 }} />
                    {admin && i > 0 && (
                      <Tooltip title="Load this version into the editor; save to make it active">
                        <IconButton
                          size="small"
                          aria-label="Restore this version"
                          onClick={() => guarded(() => restore(r))}
                        >
                          <RestoreIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                  {r.note && (
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      {r.note}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                    {r.createdBy?.name ?? 'System'} · {formatDateTime(r.createdAt)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ wordBreak: 'break-all' }}>
                    Skill v{r.skillVersion}
                  </Typography>
                </Paper>
              ))}
            </Stack>
          )}
        </Box>
      </DialogContent>

      {/* Save with a note */}
      <Dialog open={saveOpen} onClose={() => !save.isPending && setSaveOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Save {path}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {save.isError && !conflict && <Alert severity="error">{errorMessage(save.error)}</Alert>}
            <Alert severity="info">
              New {skill.name} runs use this text straight away and record a new skill version. Reports already
              generated keep the version they were made with.
            </Alert>
            <TextField
              label="What changed and why"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              multiline
              minRows={2}
              inputProps={{ maxLength: 500 }}
              autoFocus
              fullWidth
              helperText="Shown in the file's history and the audit trail."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveOpen(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={resetOpen}
        title={`Reset ${path}?`}
        confirmLabel="Reset to default"
        busy={reset.isPending}
        error={reset.error}
        message="The Settings edit stops being used and the shipped file from backend/skills becomes active again. The edit stays in the history and can be restored."
        onConfirm={() => reset.mutate()}
        onCancel={() => setResetOpen(false)}
      />

      <ConfirmDialog
        open={!!pending}
        title="Discard unsaved changes?"
        confirmLabel="Discard"
        message={`Your changes to ${path} have not been saved.`}
        onConfirm={() => {
          const go = pending;
          setPending(null);
          setDraft(null);
          go?.();
        }}
        onCancel={() => setPending(null)}
      />
    </Dialog>
  );
}
