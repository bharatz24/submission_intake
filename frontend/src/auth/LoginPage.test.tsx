// @vitest-environment jsdom
// Sign-in through the real AuthProvider and API client (MSW): success goes where the user was heading, a wrong
// password and a lockout (429) say so in the form, and the session is not treated as expired.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockApi } from '../test/msw/api';
import { apiError } from '../test/msw/handlers';
import { AuthProvider } from './AuthContext';
import { LoginPage } from './LoginPage';

const USER = { id: 'u1', email: 'uw@example.test', name: 'Una Writer', role: 'UNDERWRITER', createdAt: '2026-01-01' };

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/submissions/abc' } }]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/submissions/:id" element={<p>workspace page</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function signIn(email: string, password: string) {
  await userEvent.type(await screen.findByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

let login: ReturnType<typeof mockApi>['POST /auth/login'];
const serve = (answer: () => unknown) => {
  login = mockApi({
    'GET /auth/me': () => apiError(401, 'UNAUTHORIZED', 'Not signed in'),
    'GET /auth/bootstrap': () => ({ needsSetup: false }),
    'POST /auth/login': answer,
  })['POST /auth/login'];
};

describe('LoginPage', () => {
  beforeEach(() => serve(() => ({ user: USER })));

  it('validates the form before calling the API', async () => {
    renderLogin();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('signs in and returns to the page the user was opening', async () => {
    renderLogin();
    await signIn('uw@example.test', 'correct horse');
    expect(await screen.findByText('workspace page')).toBeInTheDocument();
    expect(login.mock.calls[0]?.[0].body).toEqual({ email: 'uw@example.test', password: 'correct horse' });
  });

  it('shows the server message for a wrong password and stays on the form', async () => {
    serve(() => apiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'));
    renderLogin();
    await signIn('uw@example.test', 'wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.queryByText('workspace page')).toBeNull();
  });

  it('explains a lockout after too many attempts (429)', async () => {
    serve(() => apiError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again in 15 minutes.'));
    renderLogin();
    await signIn('uw@example.test', 'guess');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts. Try again in 15 minutes.');
  });
});
