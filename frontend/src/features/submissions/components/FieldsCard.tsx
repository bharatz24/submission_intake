// Fields table: extracted and manual values together. Underwriters can add a field, edit a manual value inline and
// remove a manual row; a manual value supersedes the extracted values with its name (shown struck through).
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/EditOutlined';
import ReplayIcon from '@mui/icons-material/Replay';
import UploadIcon from '@mui/icons-material/UploadFileOutlined';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import { alpha } from '@mui/material/styles';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { hasPermission } from '../../../auth/permissions';
import { ConfirmDialog, EmptyState, SectionCard } from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { TOAST_MESSAGES, UNVERIFIED_EVIDENCE_HINT } from '../../../constants';
import { errorWithDetails } from '../../../lib/apiErrors';
import { pipelineHintHidden, useManualStep, useReprocess } from '../../../lib/automation';
import { FIELD_SUGGESTIONS, fieldLabel, isValidFieldName, mergeFields, normalizeFieldName } from '../../../lib/fields';
import { documentUploadLimit, uploadCaption, uploadProblem, useLimits } from '../../../lib/limits';
import { confidenceColor, formatBytes, formatDateTime, formatPercent } from '../../../lib/status';
import { api } from '../../../services/api';
import type { ManualField, SubmissionDetail } from '../../../types';
import { auditKeys } from '../../audit';
import { submissionKeys } from '../queryKeys';

/** Shared mutation plumbing: every field endpoint returns the updated submission. */
export function useFieldMutation<T>(s: SubmissionDetail, fn: (v: T) => Promise<SubmissionDetail>) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: fn,
    onSuccess: (d) => {
      qc.setQueryData(submissionKeys.detail(s.id), d);
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
      qc.invalidateQueries({ queryKey: submissionKeys.versions(s.id) });
    },
  });
}

export function FieldsCard({ s }: { s: SubmissionDetail }) {
  const { user } = useAuth();
  const writable = hasPermission(user, 'submission:write');
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManualField | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const remove = useFieldMutation(s, (fieldId: string) => api.deleteField(s.id, fieldId));
  const docName = (docId: string | null) => s.documents.find((d) => d.id === docId)?.filename;

  const rows = mergeFields(s.extractedFields, s.manualFields).filter((r) => {
    if (!filter) return true;
    const f = r.field;
    return `${f.fieldName} ${f.value} ${r.kind === 'extracted' ? r.field.sourceLabel : (r.field.note ?? '')}`
      .toLowerCase()
      .includes(filter.toLowerCase());
  });
  const empty = s.extractedFields.length === 0 && s.manualFields.length === 0;
  // Field extraction set to Manual and nothing extracted yet: say so, with the same run as Overview's button.
  const manual = useManualStep('fieldExtraction', pipelineHintHidden(s)) && s.extractedFields.length === 0;
  const reprocess = useReprocess(s.id);
  const toast = useToast();
  const manualText = "Field extraction is Manual in Settings → Automation. Run it when you're ready.";
  const runButton = writable && (
    <Button
      size="small"
      variant="outlined"
      startIcon={<ReplayIcon />}
      disabled={reprocess.isPending}
      onClick={() => reprocess.mutate()}
    >
      {reprocess.isPending ? 'Queuing…' : 'Run extraction + NPI'}
    </Button>
  );

  return (
    <SectionCard
      title="Fields"
      subtitle="Extracted values are traceable to an evidence quote and source. A manual entry supersedes the extracted values for its field."
      actions={
        <>
          {!empty && (
            <TextField
              placeholder="Filter fields…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              sx={{ width: 200 }}
            />
          )}
          {writable && (
            <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => setAdding(true)}>
              Add field
            </Button>
          )}
        </>
      }
    >
      {manual && !empty && (
        <Alert severity="info" sx={{ mb: 1.5 }} action={runButton}>
          {manualText}
        </Alert>
      )}
      {empty ? (
        manual ? (
          <EmptyState title="No fields yet" description={manualText} action={runButton} />
        ) : (
          <EmptyState
            title="No fields yet"
            description={
              writable
                ? 'Fields appear after document extraction completes. You can also add values by hand.'
                : 'Fields appear after document extraction completes.'
            }
          />
        )
      ) : (
        <TableContainer>
          <Table size="small" sx={{ minWidth: 820 }}>
            <TableHead>
              <TableRow>
                <TableCell width="17%">Field</TableCell>
                <TableCell width="24%">Value</TableCell>
                <TableCell>Evidence / note</TableCell>
                <TableCell width="17%">Source</TableCell>
                <TableCell width={90} align="right">
                  Confidence
                </TableCell>
                {writable && <TableCell width={84} />}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) =>
                r.kind === 'manual' ? (
                  <TableRow key={r.field.id} sx={{ bgcolor: (t) => alpha(t.palette.primary.main, 0.04) }}>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {r.fieldName}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <span>{r.field.value}</span>
                        <Chip size="small" color="primary" label="Manual" sx={{ height: 18, fontSize: '0.65rem' }} />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {r.field.note ? (
                        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                          {r.field.note}
                        </Typography>
                      ) : (
                        <Typography variant="caption" color="text.disabled">
                          No note
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ display: 'block' }}>
                        Manual entry
                      </Typography>
                      {r.field.documentId && docName(r.field.documentId) && (
                        <Typography variant="caption" sx={{ display: 'block', wordBreak: 'break-word' }}>
                          {docName(r.field.documentId)}
                        </Typography>
                      )}
                      <Typography variant="caption" color="text.secondary">
                        {(r.field.updatedBy ?? r.field.createdBy)?.name ?? 'Unknown'} ·{' '}
                        {formatDateTime(r.field.updatedAt)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="caption" color="text.secondary">
                        —
                      </Typography>
                    </TableCell>
                    {writable && (
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Tooltip title="Edit">
                          <IconButton
                            size="small"
                            onClick={() => setEditing(r.field)}
                            aria-label={`Edit ${r.fieldName}`}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Remove manual entry">
                          <span>
                            <IconButton
                              size="small"
                              disabled={remove.isPending}
                              onClick={() => {
                                remove.reset();
                                setPendingDelete({ id: r.field.id, name: r.fieldName });
                              }}
                              aria-label={`Remove ${r.fieldName}`}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    )}
                  </TableRow>
                ) : (
                  <TableRow key={r.field.id} sx={r.superseded ? { '& td': { color: 'text.disabled' } } : undefined}>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600} color={r.superseded ? 'text.disabled' : undefined}>
                        {r.fieldName}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      {r.superseded ? (
                        <Tooltip title="Superseded by the manual entry">
                          <Box component="span" sx={{ textDecoration: 'line-through' }}>
                            {r.field.value}
                          </Box>
                        </Tooltip>
                      ) : (
                        r.field.value
                      )}
                    </TableCell>
                    <TableCell>
                      {r.field.evidenceQuote ? (
                        <Box
                          sx={{
                            borderLeft: 3,
                            borderColor: r.field.evidenceVerified === false ? 'warning.main' : 'divider',
                            pl: 1,
                            color: 'text.secondary',
                            fontStyle: 'italic',
                            fontSize: '0.8rem',
                            wordBreak: 'break-word',
                          }}
                        >
                          “{r.field.evidenceQuote}”
                        </Box>
                      ) : (
                        <Typography variant="caption" color="text.disabled">
                          No quote
                        </Typography>
                      )}
                      {r.field.evidenceVerified === false && (
                        <Tooltip title={UNVERIFIED_EVIDENCE_HINT}>
                          <Chip size="small" color="warning" variant="outlined" label="Unverified" sx={{ mt: 0.5 }} />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ display: 'block' }}>
                        {r.field.sourceLabel}
                      </Typography>
                      {r.field.documentId &&
                        docName(r.field.documentId) &&
                        docName(r.field.documentId) !== r.field.sourceLabel && (
                          <Typography variant="caption" color="text.secondary">
                            {docName(r.field.documentId)}
                          </Typography>
                        )}
                    </TableCell>
                    <TableCell align="right">
                      <Chip
                        size="small"
                        color={r.superseded ? 'default' : confidenceColor(r.field.confidence)}
                        variant="outlined"
                        label={formatPercent(r.field.confidence)}
                      />
                    </TableCell>
                    {writable && <TableCell />}
                  </TableRow>
                ),
              )}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={writable ? 6 : 5}>
                    <Typography variant="body2" color="text.secondary" align="center">
                      No fields match “{filter}”.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {adding && <FieldDialog s={s} open onClose={() => setAdding(false)} />}
      {editing && <FieldDialog s={s} open existing={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!pendingDelete}
        title="Remove manual entry?"
        message={
          <>
            The manual value for <strong>{pendingDelete?.name}</strong> will be removed. Extracted values for this field
            will be shown again, if any exist.
          </>
        }
        confirmLabel="Remove"
        busy={remove.isPending}
        error={pendingDelete ? remove.error : null}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              toast.success(TOAST_MESSAGES.fieldRemoved(fieldLabel(pendingDelete.name)));
              setPendingDelete(null);
            },
          })
        }
        onCancel={() => {
          remove.reset();
          setPendingDelete(null);
        }}
      />
    </SectionCard>
  );
}

const UPLOAD_NEW = '__upload__';

/**
 * Add a manual value, or update one (`existing`). `fieldName` preselects the name (RequiredInfoCard) and
 * `initialValue` starts from the value in effect. The value can cite a supporting document: one already on the
 * submission, or a file uploaded here (stored as a submission document first, then linked).
 */
export function FieldDialog({
  s,
  open,
  onClose,
  fieldName: preset,
  initialValue,
  existing,
}: {
  s: SubmissionDetail;
  open: boolean;
  onClose: () => void;
  fieldName?: string;
  initialValue?: string;
  existing?: ManualField;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const editing = !!existing;
  const [name, setName] = useState(existing?.fieldName ?? preset ?? '');
  const [value, setValue] = useState(existing?.value ?? initialValue ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [docChoice, setDocChoice] = useState<string>(existing?.documentId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [touched, setTouched] = useState(false);
  // The file uploaded by an earlier attempt: a retry after the field save fails links it instead of uploading again.
  const uploaded = useRef<{ file: File; documentId: string | null } | null>(null);
  useEffect(() => {
    if (!open) uploaded.current = null;
  }, [open]);

  const save = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: async () => {
      let documentId: string | null = docChoice && docChoice !== UPLOAD_NEW ? docChoice : null;
      if (docChoice === UPLOAD_NEW && file) {
        if (uploaded.current?.file !== file) {
          const up = await api.uploadDocuments(s.id, [file]);
          uploaded.current = { file, documentId: up.documentIds[0] ?? null };
        }
        documentId = uploaded.current.documentId;
      }
      const body = { value: value.trim(), note: note.trim() || null, documentId };
      return existing
        ? api.updateField(s.id, existing.id, body)
        : api.addFields(s.id, [{ fieldName: normalizeFieldName(name), ...body }]);
    },
    onSuccess: (d) => {
      qc.setQueryData(submissionKeys.detail(s.id), d);
      qc.invalidateQueries({ queryKey: submissionKeys.detail(s.id) }); // picks up the uploaded document's extraction
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      qc.invalidateQueries({ queryKey: auditKeys.all() });
      toast.success(TOAST_MESSAGES.fieldSaved(fieldLabel(existing?.fieldName ?? normalizeFieldName(name))));
      onClose();
    },
  });
  const nameOk = isValidFieldName(name);
  const valueOk = value.trim().length > 0;
  const fileOk = docChoice !== UPLOAD_NEW || !!file;
  // Checked before uploading for a clear message; the server enforces the same limit. Unknown limits block nothing.
  const uploadLimit = documentUploadLimit(useLimits().data);
  const fileProblem = docChoice === UPLOAD_NEW && file ? uploadProblem([file], uploadLimit) : null;
  const extracted = s.extractedFields.filter((f) => f.fieldName === normalizeFieldName(name));

  return (
    <Dialog open={open} onClose={() => !save.isPending && onClose()} fullWidth maxWidth="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (nameOk && valueOk && fileOk && !fileProblem) save.mutate();
        }}
        noValidate
      >
        <DialogTitle>
          {editing ? `Update ${fieldLabel(name)}` : preset ? `Add ${fieldLabel(preset)}` : 'Add field'}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {save.isError && (
              <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
                {errorWithDetails(save.error)}
              </Alert>
            )}
            {!editing && !preset && (
              <Autocomplete
                freeSolo
                options={FIELD_SUGGESTIONS as readonly string[]}
                value={name}
                inputValue={name}
                onInputChange={(_, v) => setName(v)}
                getOptionLabel={(o) => o}
                renderOption={(props, o) => (
                  <li {...props} key={o}>
                    <Box>
                      <Typography variant="body2">{o}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {fieldLabel(o)}
                      </Typography>
                    </Box>
                  </li>
                )}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Field name"
                    autoFocus
                    error={touched && !nameOk}
                    helperText={
                      touched && !nameOk ? 'Letters, digits and underscores' : 'Pick a field or type a new name'
                    }
                  />
                )}
              />
            )}
            {!editing && extracted.length > 0 && (
              <Alert severity="info" variant="outlined">
                Extracted: {extracted.map((f) => f.value).join('; ')}. Your entry replaces{' '}
                {extracted.length > 1 ? 'them' : 'it'}.
              </Alert>
            )}
            <TextField
              label="Value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              fullWidth
              multiline
              maxRows={6}
              autoFocus={editing || !!preset}
              error={touched && !valueOk}
              helperText={touched && !valueOk ? 'Required' : undefined}
            />
            <TextField
              select
              label="Supporting document"
              value={docChoice}
              onChange={(e) => {
                setDocChoice(e.target.value);
                setFile(null);
              }}
              fullWidth
              helperText="Optional"
            >
              <MenuItem value="">
                <em>None</em>
              </MenuItem>
              {s.documents.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.filename}
                </MenuItem>
              ))}
              <MenuItem value={UPLOAD_NEW}>Upload a new document…</MenuItem>
            </TextField>
            {docChoice === UPLOAD_NEW && (
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Button component="label" variant="outlined" size="small" startIcon={<UploadIcon />}>
                  Choose file
                  <input hidden type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </Button>
                <Typography
                  variant="body2"
                  color={(touched && !fileOk) || fileProblem ? 'error' : 'text.secondary'}
                  noWrap
                >
                  {file ? `${file.name} (${formatBytes(file.size)})` : 'No file chosen'}
                </Typography>
              </Stack>
            )}
            {docChoice === UPLOAD_NEW && uploadLimit && !fileProblem && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: '4px !important' }}>
                {uploadCaption({ maxFileMb: uploadLimit.maxFileMb })}
              </Typography>
            )}
            {fileProblem && <Alert severity="error">{fileProblem} Choose a smaller file.</Alert>}
            <TextField
              label="Note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
              helperText="Optional"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Update' : 'Add'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
