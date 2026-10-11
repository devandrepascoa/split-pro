import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';

import { appRouter } from '~/server/api/root';
import type { Session } from '~/server/auth';
import { db } from '~/server/db';
import {
  balanceView,
  expenseParticipants,
  expenses,
  groupUsers,
  groups,
  users,
} from '~/server/db/schema';
import { SplitType } from '~/server/db/types';

export type TestUser = typeof users.$inferSelect;

/** Delete every row from every app table (not the migration bookkeeping tables). */
export const resetDb = async () => {
  const { results } = await (env as unknown as { DB: D1Database }).DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`,
  ).all<{ name: string }>();
  await (env as unknown as { DB: D1Database }).DB.batch([
    (env as unknown as { DB: D1Database }).DB.prepare('PRAGMA defer_foreign_keys = on'),
    ...results.map(({ name }) =>
      (env as unknown as { DB: D1Database }).DB.prepare(`DELETE FROM "${name}"`),
    ),
  ]);
};

let counter = 0;

export const makeUser = async (overrides: Partial<typeof users.$inferInsert> = {}) => {
  counter += 1;
  const [user] = await db
    .insert(users)
    .values({ name: `User ${counter}`, email: `user${counter}@example.test`, ...overrides })
    .returning();
  return user!;
};

export const makeGroup = async (owner: TestUser, members: TestUser[] = [], name = 'Trip') => {
  counter += 1;
  const [group] = await db
    .insert(groups)
    .values({
      name: `${name} ${counter}`,
      publicId: `pub-${counter}-${crypto.randomUUID()}`,
      userId: owner.id,
    })
    .returning();
  const everyone = [owner, ...members.filter((m) => m.id !== owner.id)];
  await db.insert(groupUsers).values(everyone.map((u) => ({ groupId: group!.id, userId: u.id })));
  return group!;
};

export const sessionFor = (user: TestUser): Session => ({
  user: {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    currency: user.currency,
    defaultCurrency: user.defaultCurrency,
    obapiProviderId: user.obapiProviderId,
    bankingId: user.bankingId,
    preferredLanguage: user.preferredLanguage,
    hiddenFriendIds: user.hiddenFriendIds,
  },
  expires: new Date(Date.now() + 86_400_000).toISOString(),
});

/** TRPC caller bound to a user's session, or anonymous when `user` is null. */
// oxlint-disable-next-line typescript/no-redundant-type-constituents
export const callerFor = (user: TestUser | null) =>
  appRouter.createCaller({ session: user ? sessionFor(user) : null, db });

// ---------------------------------------------------------------------------------------------
// Expense helpers
// ---------------------------------------------------------------------------------------------
type Caller = ReturnType<typeof callerFor>;
type ExpenseInput = Parameters<Caller['expense']['addOrEditExpense']>[0];
type SingleExpenseInput = Extract<ExpenseInput, { paidBy: number }>;

/**
 * Create an expense through the real tRPC procedure.
 * `shares` maps userId -> signed amount. The payer is positive, everyone else negative, and the
 * amounts sum to zero (the convention the app and BalanceView use).
 */
export const addExpense = async (
  caller: Caller,
  opts: {
    paidBy: TestUser;
    shares: Record<number, bigint>;
    amount: bigint;
    groupId?: number | null;
    currency?: string;
    splitType?: SingleExpenseInput['splitType'];
    name?: string;
    cronExpression?: string;
  },
) => {
  const [created] = await caller.expense.addOrEditExpense({
    paidBy: opts.paidBy.id,
    name: opts.name ?? 'Expense',
    category: 'general',
    amount: opts.amount,
    groupId: opts.groupId ?? null,
    splitType: opts.splitType ?? SplitType.EQUAL,
    currency: opts.currency ?? 'EUR',
    participants: Object.entries(opts.shares).map(([userId, amount]) => ({
      userId: Number(userId),
      amount,
    })),
    cronExpression: opts.cronExpression,
  });
  return created!;
};

/** Net amount `userId` is owed by `friendId` (positive = friend owes user), summed over rows. */
export const balanceBetween = async (
  userId: number,
  friendId: number,
  where: { groupId?: number | null; currency?: string } = {},
) => {
  const rows = await db
    .select()
    .from(balanceView)
    .where(
      and(
        eq(balanceView.userId, userId),
        eq(balanceView.friendId, friendId),
        where.currency ? eq(balanceView.currency, where.currency) : undefined,
      ),
    );
  return rows
    .filter((r) => (where.groupId === undefined ? true : r.groupId === where.groupId))
    .reduce((sum, r) => sum + r.amount, 0n);
};

export const participantsOf = async (expenseId: string) =>
  (await db.select().from(expenseParticipants).where(eq(expenseParticipants.expenseId, expenseId)))
    .map((p) => ({ userId: p.userId, amount: p.amount }))
    .sort((a, b) => a.userId - b.userId);

export const expenseRow = async (expenseId: string) =>
  (await db.select().from(expenses).where(eq(expenses.id, expenseId)))[0];
