import PersonAddIcon from '@mui/icons-material/PersonAddAlt1Outlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import { passwordProblem } from '../../../auth/ChangePasswordDialog';
import { hasPermission } from '../../../auth/permissions';
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  PasswordField,
  SectionBands,
  SectionCard,
} from '../../../components/common';
import { useToast } from '../../../components/feedback/FeedbackProvider';
import { MIN_PASSWORD, TOAST_MESSAGES } from '../../../constants';
import { formatDateTime, humanize } from '../../../lib/status';
import { api, apiWith, errorMessage, type ManagedUser } from '../../../services/api';
import type { Role } from '../../../types';
import { userKeys } from '../queryKeys';

const ROLES: Role[] = ['ADMIN', 'UNDERWRITER', 'VIEWER'];

// ------------------------------------------------------------------ Users (/settings/users), admins only

export function UsersSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: userKeys.managed(),
    queryFn: ({ signal }) => apiWith(signal).managedUsers(),
    enabled: hasPermission(user, 'user:manage'),
  });
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<ManagedUser | null>(null);
  const [disableFor, setDisableFor] = useState<ManagedUser | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: userKeys.managed() });
    void qc.invalidateQueries({ queryKey: userKeys.all(), exact: true });
  };
  const toast = useToast();
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: Role; disabled?: boolean } }) => api.updateUser(id, body),
    onSuccess: (u, { body }) => {
      setDisableFor(null);
      refresh();
      toast.success(
        body.disabled === true
          ? TOAST_MESSAGES.userDisabled(u.name)
          : body.disabled === false
            ? TOAST_MESSAGES.userEnabled(u.name)
            : TOAST_MESSAGES.roleChanged(u.name, humanize(u.role)),
      );
    },
    // Disabling asks first; that dialog shows its own error.
    onError: (err, { body }) => {
      if (body.disabled !== true) toast.error(err);
    },
  });

  if (!hasPermission(user, 'user:manage'))
    return <EmptyState title="Administrators only" description="Ask an administrator to manage user accounts." />;

  return (
    <Box>
      <PageHeader
        title="Users"
        subtitle="Accounts, roles and access. Changing a role, disabling an account or resetting a password signs that user out everywhere."
        actions={
          <Button variant="contained" startIcon={<PersonAddIcon />} onClick={() => setAdding(true)}>
            Add user
          </Button>
        }
      />
      <SectionBands>
        <SectionCard title="Accounts">
          {users.isLoading && <Loading label="Loading users…" shape="table" />}
          {users.isError && (
            <ErrorState error={users.error} onRetry={() => users.refetch()} title="Could not load users" />
          )}
          {users.data && (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell sx={{ width: 170 }}>Role</TableCell>
                    <TableCell sx={{ width: 110 }}>Status</TableCell>
                    <TableCell sx={{ width: 170 }}>Created</TableCell>
                    <TableCell align="right" sx={{ width: 230 }}>
                      Actions
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {/* Your own account is managed from the account menu (Change password), so it is not listed. */}
                  {users.data
                    .filter((u) => u.id !== user?.id)
                    .map((u) => {
                      const locked = u.isDefaultAdmin;
                      const busy = update.isPending && update.variables?.id === u.id;
                      return (
                        <TableRow key={u.id} hover sx={{ opacity: u.disabledAt ? 0.6 : 1 }}>
                          <TableCell>
                            {u.name}
                            {locked && (
                              <Chip
                                size="small"
                                label="Default admin"
                                color="primary"
                                variant="outlined"
                                sx={{ ml: 1 }}
                              />
                            )}
                          </TableCell>
                          <TableCell sx={{ wordBreak: 'break-all' }}>{u.email}</TableCell>
                          <TableCell>
                            <TextField
                              select
                              size="small"
                              fullWidth
                              value={u.role}
                              disabled={locked || busy}
                              inputProps={{ 'aria-label': `Role of ${u.name}` }}
                              onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value as Role } })}
                            >
                              {ROLES.map((r) => (
                                <MenuItem key={r} value={r}>
                                  {humanize(r)}
                                </MenuItem>
                              ))}
                            </TextField>
                          </TableCell>
                          <TableCell>
                            {u.disabledAt ? (
                              <Tooltip title={`Disabled ${formatDateTime(u.disabledAt)}`}>
                                <Chip size="small" label="Disabled" color="default" />
                              </Tooltip>
                            ) : (
                              <Chip size="small" label="Active" color="success" variant="outlined" />
                            )}
                          </TableCell>
                          <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                            {formatDateTime(u.createdAt)}
                          </TableCell>
                          <TableCell align="right">
                            {locked ? (
                              <Typography variant="caption" color="text.secondary">
                                Cannot be modified
                              </Typography>
                            ) : (
                              <Stack direction="row" spacing={1} justifyContent="flex-end">
                                <Button size="small" onClick={() => setResetFor(u)}>
                                  Reset password
                                </Button>
                                {u.disabledAt ? (
                                  <Button
                                    size="small"
                                    disabled={busy}
                                    onClick={() => update.mutate({ id: u.id, body: { disabled: false } })}
                                  >
                                    Enable
                                  </Button>
                                ) : (
                                  <Button size="small" color="error" disabled={busy} onClick={() => setDisableFor(u)}>
                                    Disable
                                  </Button>
                                )}
                              </Stack>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  {users.data.every((u) => u.id === user?.id) && (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ color: 'text.secondary' }}>
                        No other users yet. Use Add user to create one.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </SectionCard>
      </SectionBands>

      <ConfirmDialog
        open={!!disableFor}
        title="Disable account?"
        message={
          disableFor ? (
            <>
              <b>{disableFor.name}</b> ({disableFor.email}) will be signed out everywhere and cannot sign in until
              re-enabled.
            </>
          ) : (
            ''
          )
        }
        confirmLabel="Disable"
        busy={update.isPending}
        error={update.isError ? update.error : undefined}
        onConfirm={() => disableFor && update.mutate({ id: disableFor.id, body: { disabled: true } })}
        onCancel={() => {
          setDisableFor(null);
          update.reset();
        }}
      />
      <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} onDone={refresh} />
      <AddUserDialog open={adding} onClose={() => setAdding(false)} onDone={refresh} />
    </Box>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: ManagedUser | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const toast = useToast();
  const reset = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.resetUserPassword(user!.id, password),
    onSuccess: () => {
      toast.success(TOAST_MESSAGES.passwordReset(user!.name));
      onDone();
      close();
    },
  });
  const close = () => {
    setPassword('');
    setConfirm('');
    setTouched(false);
    reset.reset();
    onClose();
  };
  const problem = passwordProblem(password, confirm);
  return (
    <Dialog open={!!user} onClose={() => !reset.isPending && close()} fullWidth maxWidth="xs">
      <DialogTitle>Reset password</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2">
            Set a new password for <b>{user?.name}</b>. They are signed out everywhere and must use the new password.
          </Typography>
          {reset.isError && <Alert severity="error">{errorMessage(reset.error)}</Alert>}
          <PasswordField
            label="New password"
            autoComplete="new-password"
            autoFocus
            fullWidth
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <PasswordField
            label="Confirm password"
            autoComplete="new-password"
            fullWidth
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => setTouched(true)}
            error={touched && !!problem}
            helperText={touched ? (problem ?? ' ') : ' '}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={reset.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!!problem || reset.isPending} onClick={() => reset.mutate()}>
          {reset.isPending ? 'Saving…' : 'Set password'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AddUserDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('UNDERWRITER');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const toast = useToast();
  const create = useMutation({
    meta: { silentError: true }, // its error is shown where it happened, not as a toast
    mutationFn: () => api.register({ name: name.trim(), email: email.trim(), password, role }),
    onSuccess: () => {
      toast.success(TOAST_MESSAGES.userCreated(name.trim()));
      onDone();
      close();
    },
  });
  const close = () => {
    setName('');
    setEmail('');
    setRole('UNDERWRITER');
    setPassword('');
    setConfirm('');
    create.reset();
    onClose();
  };
  const problem = !name.trim()
    ? 'Name is required'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ? 'Enter a valid email'
      : passwordProblem(password, confirm);
  return (
    <Dialog open={open} onClose={() => !create.isPending && close()} fullWidth maxWidth="xs">
      <DialogTitle>Add user</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {create.isError && <Alert severity="error">{errorMessage(create.error)}</Alert>}
          <TextField label="Full name" autoFocus fullWidth value={name} onChange={(e) => setName(e.target.value)} />
          <TextField
            label="Email"
            type="email"
            autoComplete="off"
            fullWidth
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField select label="Role" fullWidth value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <MenuItem key={r} value={r}>
                {humanize(r)}
              </MenuItem>
            ))}
          </TextField>
          <PasswordField
            label="Password"
            autoComplete="new-password"
            fullWidth
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helperText={`At least ${MIN_PASSWORD} characters. Share it with the user securely.`}
          />
          <PasswordField
            label="Confirm password"
            autoComplete="new-password"
            fullWidth
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={create.isPending}>
          Cancel
        </Button>
        <Tooltip title={problem ?? ''}>
          <span>
            <Button variant="contained" disabled={!!problem || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating…' : 'Create user'}
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}
