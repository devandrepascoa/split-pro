/**
 * Client auth helpers built on better-auth. Keeps the call shapes the app used with
 * next-auth (`useSession`, `signIn`, `signOut`, `SessionProvider`) so pages change little.
 */
import { createAuthClient } from 'better-auth/react';
import { useRouter } from 'next/router';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

import type { Session } from '~/server/auth';

export const authClient = createAuthClient();

type Status = 'loading' | 'authenticated' | 'unauthenticated';

interface SessionContextValue {
  data: Session | null;
  status: Status;
  update: (
    data?: Partial<Session> | ((current: Session | null) => Partial<Session>),
  ) => Promise<Session | null>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const fetchSession = async (): Promise<Session | null> => {
  const res = await fetch('/api/session', { credentials: 'include' });
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as Session | null;
};

export function SessionProvider({
  session,
  children,
}: {
  session?: Session | null;
  children: ReactNode;
}) {
  const [data, setData] = useState<Session | null>(session ?? null);
  const [status, setStatus] = useState<Status>(session ? 'authenticated' : 'loading');

  const refresh = useCallback(async () => {
    const next = await fetchSession().catch(() => null);
    setData(next);
    setStatus(next ? 'authenticated' : 'unauthenticated');
    return next;
  }, []);

  useEffect(() => {
    if (!session) {
      void refresh();
    }
  }, [session, refresh]);

  const update = useCallback(
    async (input?: Partial<Session> | ((current: Session | null) => Partial<Session>)) => {
      const patch = 'function' === typeof input ? input(data) : input;
      if (patch?.user && data) {
        const merged = { ...data, user: { ...data.user, ...patch.user } };
        setData(merged);
        return merged;
      }
      return refresh();
    },
    [data, refresh],
  );

  return (
    <SessionContext.Provider value={{ data, status, update }}>{children}</SessionContext.Provider>
  );
}

type RequiredSession =
  | {
      data: Session;
      status: 'authenticated';
      update: SessionContextValue['update'];
    }
  | { data: null; status: 'loading'; update: SessionContextValue['update'] };

export function useSession(options: { required: true }): RequiredSession;
export function useSession(options?: { required?: false }): SessionContextValue;
export function useSession(options?: { required?: boolean }) {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used inside SessionProvider');
  }
  const router = useRouter();
  const mustRedirect = Boolean(options?.required) && 'unauthenticated' === ctx.status;

  useEffect(() => {
    if (mustRedirect) {
      const callbackUrl = encodeURIComponent(window.location.href);
      void router.push(`/auth/signin?error=SessionRequired&callbackUrl=${callbackUrl}`);
    }
  }, [mustRedirect, router]);

  if (options?.required && 'authenticated' !== ctx.status) {
    return { data: null, status: 'loading', update: ctx.update };
  }
  return ctx;
}

export const signIn = async (provider: string, options?: { callbackUrl?: string }) => {
  await authClient.signIn.social({
    provider: provider as 'google',
    callbackURL: options?.callbackUrl || '/balances',
    errorCallbackURL: '/auth/signin',
  });
};

export const signOut = async (_options?: { redirect?: boolean }) => {
  await authClient.signOut();
};
