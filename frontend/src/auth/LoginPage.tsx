import { zodResolver } from '@hookform/resolvers/zod';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import { Alert, Box, Button, Divider, Paper, Stack, TextField, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation } from 'react-router';
import { z } from 'zod';

import { ErrorState, Loading, PasswordField } from '../components/common';
import { MIN_PASSWORD } from '../constants';
import { errorWithDetails } from '../lib/apiErrors';
import { apiWith } from '../services/api';
import { useAuth } from './AuthContext';
import { authKeys } from './queryKeys';

const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type LoginValues = z.infer<typeof loginSchema>;

const registerSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    email: z.string().trim().email('Enter a valid email'),
    password: z.string().min(MIN_PASSWORD, `At least ${MIN_PASSWORD} characters`),
    confirm: z.string(),
    setupToken: z.string().trim(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type RegisterValues = z.infer<typeof registerSchema>;

export function LoginPage() {
  const { user } = useAuth();
  const location = useLocation();
  const bootstrap = useQuery({
    queryKey: authKeys.bootstrap(),
    queryFn: ({ signal }) => apiWith(signal).bootstrap(),
    retry: 1,
  });

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
        backgroundImage: (t) =>
          `linear-gradient(180deg, ${t.palette.primary.main} 0, ${t.palette.primary.main} 38vh, transparent 38vh)`,
      }}
    >
      <Paper
        variant="outlined"
        sx={{
          width: '100%',
          maxWidth: 420,
          p: 4,
          boxShadow: (t) => `0 10px 30px ${alpha(t.palette.primary.dark, 0.12)}`,
        }}
      >
        <Stack spacing={0.5} alignItems="center" sx={{ mb: 3, textAlign: 'center' }}>
          <ShieldOutlinedIcon color="primary" sx={{ fontSize: 36 }} />
          <Typography variant="h6">Submission Intake Workbench</Typography>
          <Typography variant="caption" color="text.secondary">
            Synthesis creates the facts. LLM Analysis interprets the risks.
          </Typography>
        </Stack>
        {bootstrap.isLoading && <Loading label="Checking setup…" minHeight={120} shape="form" />}
        {bootstrap.isError && (
          <ErrorState error={bootstrap.error} onRetry={() => bootstrap.refetch()} title="Cannot reach the API" />
        )}
        {bootstrap.data &&
          (bootstrap.data.needsSetup ? (
            <SetupForm needsToken={bootstrap.data.setupTokenRequired === true} />
          ) : (
            <LoginForm />
          ))}
      </Paper>
    </Box>
  );
}

function LoginForm() {
  const { login } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const onSubmit = handleSubmit(async (v) => {
    setSubmitError(null);
    try {
      await login(v.email, v.password);
    } catch (e) {
      setSubmitError(errorWithDetails(e));
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate>
      <Stack spacing={2}>
        {submitError && (
          <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
            {submitError}
          </Alert>
        )}
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
          fullWidth
          {...register('email')}
          error={!!errors.email}
          helperText={errors.email?.message}
        />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          fullWidth
          {...register('password')}
          error={!!errors.password}
          helperText={errors.password?.message}
        />
        <Button type="submit" variant="contained" size="large" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </Stack>
    </form>
  );
}

function SetupForm({ needsToken }: { needsToken: boolean }) {
  const { register: registerUser } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', confirm: '', setupToken: '' },
  });
  const onSubmit = handleSubmit(async (v) => {
    setSubmitError(null);
    try {
      await registerUser({
        name: v.name,
        email: v.email,
        password: v.password,
        ...(needsToken ? { setupToken: v.setupToken } : {}),
      });
    } catch (e) {
      setSubmitError(errorWithDetails(e));
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate>
      <Stack spacing={2}>
        <Alert severity="info" variant="outlined">
          First-run setup: no users exist yet. The account you create now becomes the <b>Administrator</b>.
        </Alert>
        {submitError && (
          <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>
            {submitError}
          </Alert>
        )}
        <TextField
          label="Full name"
          autoFocus
          fullWidth
          {...register('name')}
          error={!!errors.name}
          helperText={errors.name?.message}
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          fullWidth
          {...register('email')}
          error={!!errors.email}
          helperText={errors.email?.message}
        />
        {needsToken && (
          <PasswordField
            label="Setup token"
            autoComplete="off"
            fullWidth
            required
            {...register('setupToken')}
            helperText="The SETUP_TOKEN value from the server's environment"
          />
        )}
        <Divider />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          fullWidth
          {...register('password')}
          error={!!errors.password}
          helperText={errors.password?.message}
        />
        <PasswordField
          label="Confirm password"
          autoComplete="new-password"
          fullWidth
          {...register('confirm')}
          error={!!errors.confirm}
          helperText={errors.confirm?.message}
        />
        <Button type="submit" variant="contained" size="large" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create administrator account'}
        </Button>
      </Stack>
    </form>
  );
}
