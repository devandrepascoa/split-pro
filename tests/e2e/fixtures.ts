import { type BrowserContext, test as base, expect } from '@playwright/test';

import { USERS, sessionCookie } from './users.mjs';

type Who = keyof typeof USERS;

export const login = async (context: BrowserContext, who: Who, baseURL: string) => {
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: sessionCookie(USERS[who].token),
      url: baseURL,
    },
  ]);
};

/** Calls a tRPC procedure over HTTP the way the browser does (superjson, single call). */
export const trpc = async (
  context: BrowserContext,
  baseURL: string,
  kind: 'query' | 'mutation',
  path: string,
  input?: unknown,
) => {
  const body = input === undefined ? { json: null, meta: { values: ['undefined'], v: 1 } } : input;
  const response =
    kind === 'query'
      ? await context.request.get(
          `${baseURL}/api/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: body }))}`,
        )
      : await context.request.post(`${baseURL}/api/trpc/${path}?batch=1`, { data: { 0: body } });
  const parsed = (await response.json()) as unknown;
  if (response.status() >= 400) {
    console.log(`tRPC ${path} -> ${response.status()}`, JSON.stringify(parsed).slice(0, 600));
  }
  return { status: response.status(), body: parsed };
};

export { expect };
export const test = base;
