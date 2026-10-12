import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import { type GetServerSidePropsContext } from 'next';

import { env } from '~/env';
import { db } from '~/server/db';
import { accounts, sessions, users, verifications } from '~/server/db/schema';
import { PREVIEW_ACCESS_EMAIL_HEADER, PREVIEW_ACCESS_NAME_HEADER } from '~/server/preview-access';

/** Session user shape the app expects (kept from the former next-auth session). */
export interface SessionUser {
  id: number;
  name: string | null;
  email: string | null;
  image: string | null;
  currency: string;
  defaultCurrency?: string | null;
  obapiProviderId?: string | null;
  bankingId?: string | null;
  preferredLanguage: string;
  hiddenFriendIds: number[];
}

export interface Session {
  user: SessionUser;
  expires: string;
}

export const auth = betterAuth({
  appName: 'SplitPro',
  baseURL: env.NEXTAUTH_URL,
  secret: env.NEXTAUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema: { user: users, session: sessions, account: accounts, verification: verifications },
  }),
  advanced: {
    // Keep integer user ids: the whole app (balances, groups, expenses) uses them.
    database: { generateId: 'serial' },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  account: {
    accountLinking: { enabled: true, trustedProviders: ['google'] },
  },
  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            prompt: 'select_account',
          },
        }
      : {},
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!user.email) {
            return { data: user };
          }
          // Users created by invites or Splitwise imports already exist without an account.
          // Better-auth links by email, so only brand-new emails reach this hook.
          if (env.INVITE_ONLY) {
            throw new Error('This instance is Invite Only');
          }
          const name = user.name?.trim() ? user.name : user.email.split('@')[0];
          return { data: { ...user, email: user.email.toLowerCase(), name } };
        },
      },
    },
  },
});

/** Enabled sign-in providers, for the sign-in page. */
export const getAuthProviders = () =>
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? [{ id: 'google', name: 'Google', type: 'oauth' as const }]
    : [];

export type AuthProvider = ReturnType<typeof getAuthProviders>[number];

const toHeaders = (raw: Headers | Record<string, string | string[] | undefined>): Headers => {
  if (raw instanceof Headers) {
    return raw;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    } else if (undefined !== value) {
      headers.set(key, value);
    }
  }
  return headers;
};

const loadSessionUser = async (userId: number): Promise<SessionUser | null> => {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    currency: user.currency,
    defaultCurrency: user.defaultCurrency,
    obapiProviderId: user.obapiProviderId,
    bankingId: user.bankingId,
    preferredLanguage: user.preferredLanguage,
    hiddenFriendIds: user.hiddenFriendIds ?? [],
  };
};

/** Session from request headers (cookie). Returns the app's full session user. */
export const getSessionFromHeaders = async (
  raw: Headers | Record<string, string | string[] | undefined>,
): Promise<Session | null> => {
  const headers = toHeaders(raw);
  if (env.PREVIEW_ACCESS_AUTH) {
    const email = headers.get(PREVIEW_ACCESS_EMAIL_HEADER)?.trim().toLowerCase();
    if (!email) return null;

    await db
      .insert(users)
      .values({
        email,
        name: headers.get(PREVIEW_ACCESS_NAME_HEADER)?.trim() || email.split('@')[0],
        emailVerified: true,
      })
      .onConflictDoNothing();

    const accessUser = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!accessUser) return null;
    const user = await loadSessionUser(Number(accessUser.id));
    if (!user) return null;
    return { user, expires: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() };
  }

  const result = await auth.api.getSession({ headers });
  if (!result) {
    return null;
  }
  const user = await loadSessionUser(Number(result.user.id));
  if (!user) {
    return null;
  }
  return { user, expires: new Date(result.session.expiresAt).toISOString() };
};

/** Drop-in for the former next-auth wrapper used by getServerSideProps and tRPC. */
export const getServerAuthSession = (ctx: {
  req:
    | GetServerSidePropsContext['req']
    | { headers: Headers | Record<string, string | string[] | undefined> };
}) => getSessionFromHeaders(ctx.req.headers as Record<string, string | string[] | undefined>);

export const getServerAuthSessionForSSG = async (context: GetServerSidePropsContext) => {
  const session = await getServerAuthSession(context);

  if (!session?.user?.email) {
    return { redirect: { destination: '/', permanent: false } };
  }

  return { props: { user: session.user } };
};
