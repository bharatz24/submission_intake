import { zodResolver } from '@hookform/resolvers/zod';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { errorWithDetails } from '../../../lib/apiErrors';
import { documentUploadLimit, uploadCaption, uploadProblem, useLimits } from '../../../lib/limits';
import { formatBytes } from '../../../lib/status';
import { api } from '../../../services/api';
import { submissionKeys } from '../queryKeys';

const newSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  fromAddress: z.string().trim().email('Enter a valid sender email'),
  bodyText: z.string().max(200_000),
});

type NewValues = z.infer<typeof newSchema>;

export function NewSubmissionDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<NewValues>({
    resolver: zodResolver(newSchema),
    defaultValues: { subject: '', fromAddress: '', bodyText: '' },
  });
  const mutation = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: (v: NewValues) => api.uploadSubmission({ ...v, files }),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: submissionKeys.lists() });
      reset();
      setFiles([]);
      onClose();
      onCreated(detail.id);
    },
  });
  const close = () => {
    if (!mutation.isPending) {
      onClose();
      mutation.reset();
    }
  };
  // Checked before uploading for a clear message; the server enforces the same limits. Unknown limits block nothing.
  const uploadLimit = documentUploadLimit(useLimits().data);
  const filesProblem = uploadProblem(files, uploadLimit);

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <form
        onSubmit={handleSubmit((v) => {
          if (!filesProblem) mutation.mutate(v);
        })}
        noValidate
      >
        <DialogTitle>New manual submission</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Manual intake runs the same pipeline as Gmail: classification, document extraction (with OCR) and NPI
              verification.
            </Typography>
            {mutation.isError && (
              <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
                {errorWithDetails(mutation.error)}
              </Alert>
            )}
            <TextField
              label="Subject"
              fullWidth
              required
              {...register('subject')}
              error={!!errors.subject}
              helperText={errors.subject?.message}
            />
            <TextField
              label="From address"
              fullWidth
              required
              placeholder="broker@agency.com"
              {...register('fromAddress')}
              error={!!errors.fromAddress}
              helperText={errors.fromAddress?.message}
            />
            <TextField
              label="Email body"
              fullWidth
              multiline
              minRows={5}
              maxRows={12}
              {...register('bodyText')}
              error={!!errors.bodyText}
              helperText={errors.bodyText?.message}
            />
            <Box>
              <Button component="label" variant="outlined" startIcon={<AttachFileIcon />}>
                Attach files
                <input
                  hidden
                  multiple
                  type="file"
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    setFiles((prev) => [...prev, ...picked]);
                    e.target.value = '';
                  }}
                />
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
                PDF, DOCX, XLSX, images (OCR){uploadLimit ? ` · ${uploadCaption(uploadLimit)}` : ''}
              </Typography>
              {filesProblem && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {filesProblem} Remove files to continue.
                </Alert>
              )}
              {files.length > 0 && (
                <List dense sx={{ mt: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                  {files.map((f, i) => (
                    <ListItem
                      key={`${f.name}-${i}`}
                      secondaryAction={
                        <IconButton
                          edge="end"
                          size="small"
                          onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                          aria-label={`Remove ${f.name}`}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      }
                    >
                      <ListItemText
                        primary={f.name}
                        secondary={formatBytes(f.size)}
                        primaryTypographyProps={{ noWrap: true }}
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={mutation.isPending || !!filesProblem}>
            {mutation.isPending ? (files.length ? 'Uploading to Google Drive…' : 'Saving…') : 'Create submission'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
