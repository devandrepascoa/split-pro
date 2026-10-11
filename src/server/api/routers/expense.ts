import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { simplifyDebts } from '~/lib/simplify';
import { createTRPCRouter, groupProcedure, protectedProcedure } from '~/server/api/trpc';
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import { db } from '~/server/db';
import {
  balanceView,
  expenseParticipants,
  expenses as expensesTable,
  groupUsers,
  groups,
} from '~/server/db/schema';
import { BigMath, currencyConversion } from '~/utils/numbers';

import {
  arrayify,
  createCurrencyConversionSchema,
  createExpenseSchema,
  getBatchCurrencyRatesSchema,
  getCurrencyRateSchema,
} from '~/types/expense.types';
import { createExpense, deleteExpense, editExpense } from '../services/splitService';
import { currencyRateProvider } from '../services/currencyRateService';
import { type CurrencyCode, isCurrencyCode } from '~/lib/currency';
import { SplitType } from '~/server/db/types';
import { DEFAULT_CATEGORY } from '~/lib/category';
import { getUserMap } from './user';
import { deleteJob, updateJobSchedule } from '../services/scheduleService';

/** Correlated EXISTS: the expense identified by `expenseIdCol` has participant `userId`. */
const hasParticipant = (expenseIdCol: typeof expensesTable.id, userId: number, nonZero = false) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(expenseParticipants)
      .where(
        and(
          eq(expenseParticipants.expenseId, expenseIdCol),
          eq(expenseParticipants.userId, userId),
          nonZero ? ne(expenseParticipants.amount, 0n) : undefined,
        ),
      ),
  );

/** Hide the "from" half of a currency conversion; the "to" half carries conversionToId. */
const notConversionFromHalf = (e: typeof expensesTable._.columns) =>
  or(ne(e.splitType, SplitType.CURRENCY_CONVERSION), isNotNull(e.conversionToId));

const userSummaryColumns = { name: true, email: true, image: true, id: true } as const;

export const expenseRouter = createTRPCRouter({
  getCumulatedBalances: protectedProcedure.query(async ({ ctx }) => {
    const total = sql<bigint>`SUM(${balanceView.amount})`.mapWith((v) => BigInt(v ?? 0));
    const cumulatedBalances = (
      await db
        .select({ currency: balanceView.currency, amount: total })
        .from(balanceView)
        .where(and(eq(balanceView.userId, ctx.session.user.id), ne(balanceView.amount, 0n)))
        .groupBy(balanceView.currency)
        .orderBy(desc(total))
    ).map((b) => ({ currency: b.currency, _sum: { amount: b.amount } }));

    const youOwe = cumulatedBalances
      .filter((b) => b._sum.amount && 0 > b._sum.amount)
      .map((b) => ({ currency: b.currency, amount: b._sum.amount }))
      .reverse();

    const youGet = cumulatedBalances
      .filter((b) => b._sum.amount && 0 < b._sum.amount)
      .map((b) => ({ currency: b.currency, amount: b._sum.amount }));

    return { youOwe, youGet };
  }),

  getBalances: protectedProcedure.query(async ({ ctx }) => {
    const rawBalances = await db
      .select({
        friendId: balanceView.friendId,
        currency: balanceView.currency,
        amount: balanceView.amount,
        groupId: balanceView.groupId,
        group: { simplifyDebts: groups.simplifyDebts },
      })
      .from(balanceView)
      .leftJoin(groups, eq(groups.id, balanceView.groupId))
      .where(
        and(
          eq(balanceView.userId, ctx.session.user.id),
          notInArray(balanceView.friendId, ctx.session.user.hiddenFriendIds),
        ),
      );

    const processedBalances = await Promise.all(
      rawBalances.map(async ({ friendId, currency, amount, groupId, group }) => {
        if (!group?.simplifyDebts || null === groupId) {
          return { friendId, currency, amount };
        }

        const allGroupBalances = await db
          .select()
          .from(balanceView)
          .where(and(eq(balanceView.groupId, groupId), eq(balanceView.currency, currency)));

        const simplified = simplifyDebts(allGroupBalances);
        const simplifiedBalance = simplified.find(
          (b) =>
            b.userId === ctx.session.user.id && b.friendId === friendId && b.currency === currency,
        );

        return { friendId, currency, amount: simplifiedBalance?.amount ?? 0n };
      }),
    );

    // Group by friendId and fetch user details
    const friendIds = [...new Set([...processedBalances].map((b) => b.friendId))];
    const userMap = await getUserMap(friendIds);

    // Aggregate by (friendId, currency) since same pair can appear in multiple groups
    const aggregated = processedBalances
      .filter((b) => 0n !== b.amount)
      .reduce<Map<string, { friendId: number; currency: string; amount: bigint }>>(
        (acc, { friendId, currency, amount }) => {
          const key = `${friendId}-${currency}`;
          const existing = acc.get(key);
          if (existing) {
            existing.amount += amount;
          } else {
            acc.set(key, { friendId, currency, amount });
          }
          return acc;
        },
        new Map(),
      );

    const balancesByFriend = [...aggregated.values()].reduce<
      Record<number, { currency: string; amount: bigint }[]>
    >((acc, { friendId, currency, amount }) => {
      if (!acc[friendId]) {
        acc[friendId] = [];
      }
      acc[friendId].push({ currency, amount });
      return acc;
    }, {});

    friendIds.forEach((friendId) => {
      if (!balancesByFriend[friendId]) {
        balancesByFriend[friendId] = [];
      }
    });

    const balances = Object.entries(balancesByFriend)
      .map(([friendId, currencies]) => ({
        friendId: Number(friendId),
        currencies,
        friend: userMap[Number(friendId)]!,
        maxAmount: currencies.reduce(
          (max, curr) => (BigMath.abs(curr.amount) > BigMath.abs(max) ? curr.amount : max),
          0n,
        ),
      }))
      .sort((a, b) => Number(BigMath.abs(b.maxAmount) - BigMath.abs(a.maxAmount)));

    return { balances };
  }),

  addOrEditExpense: protectedProcedure
    .input(arrayify(createExpenseSchema))
    .mutation(async ({ input: expenses, ctx }) => {
      const results = [];
      for (const input of expenses) {
        if (input.expenseId) {
          await validateEditExpensePermission(input.expenseId, ctx.session.user.id);
        }
        if (input.splitType === SplitType.CURRENCY_CONVERSION) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid split type' });
        }

        if (input.groupId !== null) {
          await assertCanWriteToGroup(input.groupId, ctx.session.user.id);
        }

        try {
          const expense = input.expenseId
            ? await editExpense(input, ctx.session.user.id)
            : await createExpense(input, ctx.session.user.id);

          results.push(expense);
        } catch (error) {
          console.error(error);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to create expense',
          });
        }
      }

      return results;
    }),

  addOrEditCurrencyConversion: protectedProcedure
    .input(createCurrencyConversionSchema)
    .mutation(async ({ input, ctx }) => {
      const { amount, rate, from, to, senderId, receiverId, groupId, expenseId } = input;

      if (expenseId) {
        await validateEditExpensePermission(expenseId, ctx.session.user.id);
      }
      if (groupId !== null && groupId !== undefined) {
        await assertCanWriteToGroup(groupId, ctx.session.user.id);
      }

      if (!isCurrencyCode(from) || !isCurrencyCode(to)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid currency code' });
      }

      const amountTo = currencyConversion({ from, to, amount, rate });
      const name = `${from} → ${to} @ ${rate}`;

      const conversionFrom = {
        expenseId,
        name,
        currency: from,
        amount,
        paidBy: senderId,
        splitType: SplitType.CURRENCY_CONVERSION,
        category: DEFAULT_CATEGORY,
        participants: [
          { userId: senderId, amount: amount },
          { userId: receiverId, amount: -amount },
        ],
        groupId,
        expenseDate: new Date(),
      };

      const conversionTo = {
        ...conversionFrom,
        expenseId: undefined,
        currency: to,
        amount: amountTo,
        paidBy: receiverId,
        participants: [
          { userId: senderId, amount: -amountTo },
          { userId: receiverId, amount: amountTo },
        ],
      };

      let res = null;

      if (!expenseId) {
        res = await createExpense(conversionTo, ctx.session.user.id, conversionFrom);
      } else {
        res = await editExpense(conversionFrom, ctx.session.user.id, conversionTo);
      }

      if (!res) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to upsert currency conversion record',
        });
      }
    }),

  getExpensesWithFriend: protectedProcedure
    .input(z.object({ friendId: z.number() }))
    .query(async ({ input, ctx }) => {
      const me = ctx.session.user.id;
      const expenses = await db.query.expenses.findMany({
        where: (e) =>
          and(
            hasParticipant(e.id, input.friendId, true),
            hasParticipant(e.id, me, true),
            or(eq(e.paidBy, me), eq(e.paidBy, input.friendId)),
            isNull(e.deletedBy),
            notConversionFromHalf(e),
          ),
        orderBy: (e) => [desc(e.expenseDate)],
        with: {
          expenseParticipants: {
            where: (ep) => inArray(ep.userId, [me, input.friendId]),
          },
          paidByUser: true,
          conversionTo: true,
          group: { columns: { id: true, name: true, simplifyDebts: true } },
        },
      });

      return expenses;
    }),

  getGroupExpenses: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .query(async ({ input, ctx }) => {
      const expenses = await ctx.db.query.expenses.findMany({
        where: (e) =>
          and(eq(e.groupId, input.groupId), isNull(e.deletedBy), notConversionFromHalf(e)),
        orderBy: (e) => [desc(e.expenseDate)],
        with: {
          expenseParticipants: true,
          paidByUser: true,
          deletedByUser: true,
          conversionTo: true,
        },
      });

      return expenses;
    }),

  getExpenseDetails: protectedProcedure
    .input(z.object({ expenseId: z.string() }))
    .query(async ({ input, ctx }) => {
      const expense = await db.query.expenses.findFirst({
        where: eq(expensesTable.id, input.expenseId),
        with: {
          expenseParticipants: { with: { user: true } },
          expenseNotes: true,
          addedByUser: true,
          paidByUser: true,
          deletedByUser: true,
          updatedByUser: true,
          group: true,
          recurrence: { with: { job: { columns: { schedule: true, command: true } } } },
          conversionTo: { with: { expenseParticipants: { with: { user: true } } } },
        },
      });

      if (expense && !(await canAccessExpense(expense.id, ctx.session.user.id))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Expense not found' });
      }

      if (expense && expense.groupId !== null) {
        const participantIds = expense.expenseParticipants.map((ep) => ep.userId);
        const missingGroupMembers = await db.query.groups.findFirst({
          where: eq(groups.id, expense.groupId),
          with: {
            groupUsers: {
              where: (gu) => notInArray(gu.userId, participantIds),
              with: { user: true },
            },
          },
        });
        missingGroupMembers?.groupUsers.forEach((gu) => {
          expense.expenseParticipants.push({
            userId: gu.user.id,
            expenseId: expense.id,
            user: gu.user,
            amount: 0n,
          });
        });
      }

      if (expense?.recurrence?.job.schedule) {
        expense.recurrence.job.schedule = expense.recurrence.job.schedule.replaceAll('$', 'L');
      }

      return expense;
    }),

  getAllExpenses: protectedProcedure.query(async ({ ctx }) => {
    const expenses = (
      await db.query.expenseParticipants.findMany({
        where: eq(expenseParticipants.userId, ctx.session.user.id),
        with: {
          expense: {
            with: {
              paidByUser: { columns: userSummaryColumns },
              deletedByUser: { columns: userSummaryColumns },
            },
          },
        },
      })
    ).sort((a, b) => b.expense.createdAt.getTime() - a.expense.createdAt.getTime());

    return expenses;
  }),

  getRecurringExpenses: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.user.id;
    const recurrences = await db.query.expenseRecurrences.findMany({
      with: {
        job: true,
        expense: {
          limit: 1,
          orderBy: (e) => [desc(e.createdAt)],
          where: (e) =>
            and(isNull(e.deletedBy), hasParticipant(e.id, me), isNotNull(e.recurrenceId)),
          with: { addedByUser: { columns: userSummaryColumns } },
        },
      },
    });

    return recurrences
      .filter((r) => r.expense.length > 0)
      .map((r) => Object.assign(r, { expense: r.expense[0]! }));
  }),

  deleteRecurrence: protectedProcedure
    .input(z.object({ recurrenceId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const recurrence = await findUserRecurrence(input.recurrenceId, ctx.session.user.id);

      if (!recurrence || 0 === recurrence.expense.length) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Recurrence not found' });
      }

      // Deleting the job cascades to the recurrence, which nulls recurrenceId on expenses.
      await deleteJob(recurrence.job.jobid);
    }),

  updateRecurrence: protectedProcedure
    .input(z.object({ recurrenceId: z.number(), cronExpression: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const recurrence = await findUserRecurrence(input.recurrenceId, ctx.session.user.id);

      if (!recurrence || 0 === recurrence.expense.length) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Recurrence not found' });
      }

      await updateJobSchedule(recurrence.job.jobid, input.cronExpression);
    }),

  deleteExpense: protectedProcedure
    .input(z.object({ expenseId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await validateEditExpensePermission(input.expenseId, ctx.session.user.id);

      const expense = await db.query.expenses.findFirst({
        where: eq(expensesTable.id, input.expenseId),
        columns: { groupId: true },
      });

      if (!expense) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Expense not found' });
      }

      if (expense.groupId !== null) {
        await assertCanWriteToGroup(expense.groupId, ctx.session.user.id);
      }

      await deleteExpense(input.expenseId, ctx.session.user.id);
    }),

  getCurrencyRate: protectedProcedure.input(getCurrencyRateSchema).query(async ({ input }) => {
    const { from, to, date } = input;

    if (!isCurrencyCode(from) || !isCurrencyCode(to)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid currency code' });
    }

    const rate = await currencyRateProvider.getCurrencyRate(from, to, date);

    return { rate };
  }),

  getBatchCurrencyRates: protectedProcedure
    .input(getBatchCurrencyRatesSchema)
    .query(async ({ input }) => {
      const { from, to, date } = input;

      if (from.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing from currency code' });
      }

      if (!from.every(isCurrencyCode) || !isCurrencyCode(to)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid currency code' });
      }

      const rates = new Map<string, number>();

      // Get the first rate to precache rates for the target currency
      const rate = await currencyRateProvider.getCurrencyRate(from[0] as CurrencyCode, to, date);
      rates.set(from[0]!, rate);

      if (from.length > 1) {
        // Fetch rates for remaining currencies and return as map
        await Promise.all(
          from.slice(1).map(async (currency) => {
            const r = await currencyRateProvider.getCurrencyRate(currency, to, date);
            rates.set(currency, r);
          }),
        );
      }

      return { rates };
    }),
});

/**
 * Who may see or change an expense: its payer, the user who added it, a participant, or (for
 * group expenses) any member of the group.
 */
const canAccessExpense = async (expenseId: string, userId: number): Promise<boolean> => {
  const expense = await db.query.expenses.findFirst({
    where: eq(expensesTable.id, expenseId),
    columns: { paidBy: true, addedBy: true, groupId: true },
  });
  if (!expense) {
    return false;
  }
  if (expense.paidBy === userId || expense.addedBy === userId) {
    return true;
  }

  const [participant, member] = await Promise.all([
    db.query.expenseParticipants.findFirst({
      where: and(
        eq(expenseParticipants.expenseId, expenseId),
        eq(expenseParticipants.userId, userId),
      ),
    }),
    expense.groupId === null
      ? undefined
      : db.query.groupUsers.findFirst({
          where: and(eq(groupUsers.groupId, expense.groupId), eq(groupUsers.userId, userId)),
        }),
  ]);
  return Boolean(participant ?? member);
};

const validateEditExpensePermission = async (expenseId: string, userId: number): Promise<void> => {
  if (!(await canAccessExpense(expenseId, userId))) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You are not the participant of the expense',
    });
  }
};

/** The group must exist, be active, and the user must be a member. */
const assertCanWriteToGroup = async (groupId: number, userId: number): Promise<void> => {
  const group = await db.query.groups.findFirst({
    where: eq(groups.id, groupId),
    columns: { archivedAt: true },
  });
  if (!group) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Group not found' });
  }
  const membership = await db.query.groupUsers.findFirst({
    where: and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, userId)),
  });
  if (!membership) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a group member' });
  }
  if (group.archivedAt) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Group is archived' });
  }
};

const findUserRecurrence = (recurrenceId: number, userId: number) =>
  db.query.expenseRecurrences.findFirst({
    where: (r) => eq(r.id, recurrenceId),
    with: {
      job: true,
      expense: { where: (e) => hasParticipant(e.id, userId), limit: 1 },
    },
  });

export type ExpenseRouter = typeof expenseRouter;
