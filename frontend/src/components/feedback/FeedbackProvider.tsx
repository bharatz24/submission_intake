// App-wide feedback in the app's own look instead of the browser's: toasts for the result of an action (bottom-right;
// new-mail toasts own bottom-left) and a promise-based confirm dialog in place of window.confirm.
import SuccessIcon from '@mui/icons-material/CheckCircleOutline';
import CloseIcon from '@mui/icons-material/Close';
import ErrorIcon from '@mui/icons-material/ErrorOutline';
import InfoIcon from '@mui/icons-material/InfoOutlined';
import WarningIcon from '@mui/icons-material/WarningAmberOutlined';
import { Box, Button, IconButton, Paper, Slide, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { AUTO_HIDE_MS, TOAST_LIMIT } from '../../constants';
import { onUnhandledMutationError } from '../../lib/mutationErrors';
import { errorMessage } from '../../services/api';
import { ConfirmDialog } from '../common';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';
export interface ToastOptions {
  /** Bold first line; the message follows it. */
  title?: string;
  /** One button on the toast (Undo, Open, Retry); clicking it also closes the toast. */
  action?: { label: string; onClick: () => void };
}
interface ToastItem extends ToastOptions {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface Toaster {
  success: (message: string, opts?: ToastOptions) => void;
  info: (message: string, opts?: ToastOptions) => void;
  warning: (message: string, opts?: ToastOptions) => void;
  /** A string as is; anything else in plain words (errorMessage). Stays until dismissed. */
  error: (err: unknown, opts?: ToastOptions) => void;
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  /** `error` (default) for destructive actions, `primary` for a plain "are you sure". */
  tone?: 'error' | 'primary';
}

const noop = () => undefined;
// Without a provider (component tests that do not test feedback) the hooks do nothing and confirm says yes.
const ToastContext = createContext<Toaster>({ success: noop, info: noop, warning: noop, error: noop });
const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(async () => true);

export const useToast = (): Toaster => useContext(ToastContext);
export const useConfirm = () => useContext(ConfirmContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toaster = useMemo<Toaster>(() => {
    const push = (tone: ToastTone, message: string, opts?: ToastOptions) =>
      setToasts((t) =>
        [
          { id: nextId.current++, tone, message, ...opts },
          // The same message again replaces the old toast instead of stacking.
          ...t.filter((x) => !(x.tone === tone && x.message === message)),
        ].slice(0, TOAST_LIMIT),
      );
    return {
      success: (m, o) => push('success', m, o),
      info: (m, o) => push('info', m, o),
      warning: (m, o) => push('warning', m, o),
      error: (err, o) => push('error', typeof err === 'string' ? err : errorMessage(err), o),
    };
  }, []);

  // Mutations that show no error of their own (no onError, no meta.silentError) report it here (FE-13).
  useEffect(() => onUnhandledMutationError((err) => toaster.error(err)), [toaster]);

  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );
  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <ToastContext.Provider value={toaster}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <ConfirmDialog
          open={!!pending}
          title={pending?.title ?? ''}
          message={pending?.message ?? ''}
          confirmLabel={pending?.confirmLabel ?? 'OK'}
          tone={pending?.tone}
          onConfirm={() => answer(true)}
          onCancel={() => answer(false)}
        />
        <Stack
          spacing={1}
          sx={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: (t) => t.zIndex.snackbar,
            width: 380,
            maxWidth: 'calc(100vw - 32px)',
          }}
        >
          {toasts.map((t) => (
            <Toast key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </Stack>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

const ICON: Record<ToastTone, typeof SuccessIcon> = {
  success: SuccessIcon,
  error: ErrorIcon,
  warning: WarningIcon,
  info: InfoIcon,
};

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  // Success and info close themselves (paused while hovered); errors and warnings wait to be read.
  const sticky = toast.tone === 'error' || toast.tone === 'warning';
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (sticky || hovered) return;
    const t = setTimeout(() => onDismiss(toast.id), AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [sticky, hovered, toast.id, onDismiss]);
  const Icon = ICON[toast.tone];
  const { action } = toast;

  return (
    <Slide direction="left" in mountOnEnter>
      <Paper
        elevation={6}
        role={sticky ? 'alert' : 'status'}
        aria-live={sticky ? 'assertive' : 'polite'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1.25,
          p: 1.25,
          borderLeft: 4,
          borderColor: `${toast.tone}.main`,
        }}
      >
        <Icon fontSize="small" sx={{ color: `${toast.tone}.main`, mt: 0.25 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {toast.title && (
            <Typography variant="body2" fontWeight={600}>
              {toast.title}
            </Typography>
          )}
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {toast.message}
          </Typography>
          {action && (
            <Button
              size="small"
              sx={{ mt: 0.5, ml: -0.75 }}
              color={toast.tone}
              onClick={() => {
                action.onClick();
                onDismiss(toast.id);
              }}
            >
              {action.label}
            </Button>
          )}
        </Box>
        <IconButton size="small" onClick={() => onDismiss(toast.id)} aria-label="Dismiss" sx={{ mt: -0.25 }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper>
    </Slide>
  );
}
