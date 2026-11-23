// Change your own password, from the account menu (Layout). Kept out of UsersSettings so the layout doesn't pull the
// admin-only Users page into the main bundle.
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { PasswordField } from '../components/common';
import { MAX_PASSWORD_BYTES, MIN_PASSWORD } from '../constants';
import { api, errorMessage } from '../services/api';
import { useAuth } from './AuthContext';

/** Same rules as the server's length checks (it also refuses common passwords). */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `At least ${MIN_PASSWORD} characters`;
  // bcrypt only uses the first 72 bytes, so the server refuses longer passwords; accented letters take 2+ bytes.
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES)
    return 'Too long: at most 72 bytes (about 72 plain letters)';
  if (password !== confirm) return 'Passwords do not match';
  return null;
}

/** Change your own password (account menu). Other sessions are signed out; this one continues. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setCurrentUser } = useAuth();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.changePassword(current, password),
    onSuccess: (res) => {
      setCurrentUser(res.user);
      setDone(true);
    },
  });
  const close = () => {
    setCurrent('');
    setPassword('');
    setConfirm('');
    setDone(false);
    change.reset();
    onClose();
  };
  const problem = !current ? 'Enter your current password' : passwordProblem(password, confirm);
  return (
    <Dialog open={open} onClose={() => !change.isPending && close()} fullWidth maxWidth="xs">
      <DialogTitle>Change password</DialogTitle>
      <DialogContent dividers>
        {done ? (
          <Alert severity="success">
            Password changed. Other browsers and scripts using your old sessions have been signed out.
          </Alert>
        ) : (
          <Stack spacing={2}>
            {change.isError && <Alert severity="error">{errorMessage(change.error)}</Alert>}
            <PasswordField
              label="Current password"
              autoComplete="current-password"
              autoFocus
              fullWidth
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
            <PasswordField
              label="New password"
              autoComplete="new-password"
              fullWidth
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              helperText={`At least ${MIN_PASSWORD} characters`}
            />
            <PasswordField
              label="Confirm new password"
              autoComplete="new-password"
              fullWidth
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {done ? (
          <Button variant="contained" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close} disabled={change.isPending}>
              Cancel
            </Button>
            <Button variant="contained" disabled={!!problem || change.isPending} onClick={() => change.mutate()}>
              {change.isPending ? 'Saving…' : 'Change password'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
