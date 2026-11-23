// In-app toasts for new mail, bottom-left, newest on top. Each closes itself after a few seconds.
import CloseIcon from '@mui/icons-material/Close';
import { Avatar, Box, IconButton, Paper, Slide, Stack, Typography } from '@mui/material';
import { useEffect } from 'react';

import { AUTO_HIDE_MS } from '../../constants';
import type { EmailNotification } from '../../lib/notifications';

export function ToastStack({
  toasts,
  onOpen,
  onDismiss,
}: {
  toasts: EmailNotification[];
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <Stack
      spacing={1}
      aria-live="polite"
      sx={{
        position: 'fixed',
        left: 16,
        bottom: 16,
        zIndex: (t) => t.zIndex.snackbar,
        width: 340,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onOpen={onOpen} onDismiss={onDismiss} />
      ))}
    </Stack>
  );
}

function Toast({
  toast,
  onOpen,
  onDismiss,
}: {
  toast: EmailNotification;
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);

  return (
    <Slide direction="up" in mountOnEnter>
      <Paper
        elevation={6}
        role="status"
        sx={{ display: 'flex', alignItems: 'center', gap: 1.25, p: 1.25, borderLeft: 4, borderColor: 'primary.main' }}
      >
        <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: '0.8rem' }}>
          {toast.senderInitials}
        </Avatar>
        <Box
          component="button"
          type="button"
          onClick={() => onOpen(toast.id)}
          sx={{ all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0 }}
          aria-label={`Open email from ${toast.senderName}: ${toast.subject}`}
        >
          <Typography variant="caption" color="text.secondary" component="div" noWrap>
            New email · {toast.senderName}
          </Typography>
          <Typography variant="body2" fontWeight={600} noWrap>
            {toast.subject}
          </Typography>
        </Box>
        <IconButton size="small" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper>
    </Slide>
  );
}
