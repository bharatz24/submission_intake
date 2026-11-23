// A default error toast for mutations that do not show their own error (FE-13).
import { type Mutation, MutationCache } from '@tanstack/react-query';

import { ApiError } from '../services/api';

/** What a mutation may say about itself in `meta`. */
export interface AppMutationMeta extends Record<string, unknown> {
  /**
   * The mutation shows its own error (an Alert in its dialog or card, a field error), so the app-wide toast stays
   * quiet. A mutation with its own `onError` is skipped too, without needing this.
   */
  silentError?: boolean;
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: AppMutationMeta;
  }
}

type Notify = (error: unknown) => void;
const listeners = new Set<Notify>();

/** Subscribe to mutation errors nobody else reports (FeedbackProvider shows them as toasts). Returns unsubscribe. */
export function onUnhandledMutationError(fn: Notify): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Whether a failed mutation should get the default toast: not when it handles the error itself (`onError`, or
 * `meta.silentError` for one that renders it), and not for a 401, which signs the user out instead.
 */
export function needsDefaultErrorToast(
  error: unknown,
  mutation: Pick<Mutation<unknown, unknown, unknown, unknown>, 'options'>,
): boolean {
  if (mutation.options.meta?.silentError || mutation.options.onError) return false;
  return !(error instanceof ApiError && error.status === 401);
}

/** The app's MutationCache: failed mutations that report nothing themselves still tell the user. */
export function createMutationCache(): MutationCache {
  return new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (needsDefaultErrorToast(error, mutation)) listeners.forEach((notify) => notify(error));
    },
  });
}
