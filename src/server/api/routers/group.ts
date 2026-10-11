import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { simplifyDebts } from '~/lib/simplify';
import { createTRPCRouter, groupProcedure, protectedProcedure } from '~/server/api/trpc';
import { sendGroupSimplifyDebtsToggleNotification } from '~/server/api/services/notificationService';
import { SplitType } from '~/server/db/types';
import { runBatch } from '~/server/db/batch';
import { balanceView, expenses, groupDefaultSplits, groupUsers, groups } from '~/server/db/schema';
import type { DB } from '~/server/db';
import { runInBackground } from '~/server/observability/background';
import {
  defaultSplitInputSchema,
  deserializeDefaultSplit,
  parseSerializedDefaultSplit,
  serializeDefaultSplit,
} from '~/lib/defaultSplit';

export const groupRouter = createTRPCRouter({
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const publicId = nanoid();
      const [[group]] = (await runBatch([
        ctx.db
          .insert(groups)
          .values({ name: input.name, publicId, userId: ctx.session.user.id })
          .returning(),
        ctx.db.insert(groupUsers).values({
          groupId: sql`(SELECT ${groups.id} FROM ${groups} WHERE ${groups.publicId} = ${publicId})`,
          userId: ctx.session.user.id,
        }),
      ])) as [(typeof groups.$inferSelect)[]];

      return group!;
    }),

  getAllGroups: protectedProcedure.query(async ({ ctx }) => {
    const userGroups = await ctx.db.query.groupUsers.findMany({
      where: eq(groupUsers.userId, ctx.session.user.id),
      with: {
        group: {
          with: { groupUsers: { with: { user: true } }, groupDefaultSplit: true },
        },
      },
    });

    return userGroups.map((groupUser) => ({
      ...groupUser,
      group: {
        ...groupUser.group,
        defaultSplit: groupUser.group.groupDefaultSplit
          ? parseSerializedDefaultSplit(
              groupUser.group.groupDefaultSplit.splitType,
              groupUser.group.groupDefaultSplit.shares,
            )
          : null,
      },
    }));
  }),

  getAllGroupsWithBalances: protectedProcedure
    .input(z.object({ getArchived: z.boolean() }).optional())
    .query(async ({ ctx, input }) => {
      const me = ctx.session.user.id;
      const memberships = await ctx.db.query.groupUsers.findMany({
        where: eq(groupUsers.userId, me),
        with: {
          group: {
            with: { expenses: { orderBy: (e) => [desc(e.createdAt)], limit: 1 } },
          },
        },
      });
      const filtered = memberships.filter((m) =>
        input?.getArchived ? null !== m.group.archivedAt : null === m.group.archivedAt,
      );
      const myBalances =
        0 === filtered.length
          ? []
          : await ctx.db
              .select()
              .from(balanceView)
              .where(
                and(
                  eq(balanceView.userId, me),
                  inArray(
                    balanceView.groupId,
                    filtered.map((m) => m.groupId),
                  ),
                ),
              );
      const groups = filtered.map((m) => ({
        ...m,
        group: { ...m.group, groupBalances: myBalances.filter((b) => b.groupId === m.groupId) },
      }));

      const sortedGroupsByLatestExpense = groups.sort((a, b) => {
        const aDate = a.group.expenses[0]?.createdAt ?? new Date(0);
        const bDate = b.group.expenses[0]?.createdAt ?? new Date(0);
        return bDate.getTime() - aDate.getTime();
      });

      const groupsWithBalances = sortedGroupsByLatestExpense.map((g) => {
        const balances: Record<string, bigint> = {};

        for (const balance of g.group.groupBalances) {
          balances[balance.currency] = (balances[balance.currency] ?? 0n) + balance.amount;
        }

        return {
          ...g.group,
          balances,
        };
      });

      return groupsWithBalances;
    }),

  joinGroup: protectedProcedure
    .input(z.object({ groupId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.query.groups.findFirst({
        where: eq(groups.publicId, input.groupId),
      });

      if (!group) {
        throw new Error('Group not found');
      }

      await runBatch([
        ctx.db.insert(groupUsers).values({ groupId: group.id, userId: ctx.session.user.id }),
        ctx.db.delete(groupDefaultSplits).where(eq(groupDefaultSplits.groupId, group.id)),
      ]);

      return group;
    }),

  getGroupDetails: groupProcedure.query(async ({ input, ctx }) => {
    const found = await ctx.db.query.groups.findFirst({
      where: eq(groups.id, input.groupId),
      with: { groupUsers: { with: { user: true } }, groupDefaultSplit: true },
    });
    const group = found && { ...found, groupBalances: await groupBalancesOf(ctx.db, found.id) };

    if (!group) {
      return group;
    }

    if (group.simplifyDebts) {
      group.groupBalances = simplifyDebts(group.groupBalances);
    }

    const defaultSplit =
      group.groupDefaultSplit &&
      parseSerializedDefaultSplit(
        group.groupDefaultSplit.splitType,
        group.groupDefaultSplit.shares,
      );

    return {
      ...group,
      defaultSplit,
    };
  }),

  getGroupTotals: groupProcedure.query(async ({ input, ctx }) => {
    const totals = (
      await ctx.db
        .select({
          currency: expenses.currency,
          amount: sql<bigint>`SUM(${expenses.amount})`.mapWith((v) => BigInt(v ?? 0)),
        })
        .from(expenses)
        .where(
          and(
            eq(expenses.groupId, input.groupId),
            isNull(expenses.deletedAt),
            ne(expenses.splitType, SplitType.SETTLEMENT),
          ),
        )
        .groupBy(expenses.currency)
    ).map((t) => ({ currency: t.currency, _sum: { amount: t.amount } }));

    return totals;
  }),

  addMembers: groupProcedure
    .input(z.object({ userIds: z.array(z.number()) }))
    .mutation(async ({ input, ctx }) => {
      await runBatch([
        ...(input.userIds.length
          ? [
              ctx.db
                .insert(groupUsers)
                .values(input.userIds.map((userId) => ({ groupId: input.groupId, userId }))),
            ]
          : []),
        ctx.db.delete(groupDefaultSplits).where(eq(groupDefaultSplits.groupId, input.groupId)),
      ]);
      const created = { count: input.userIds.length };

      return created;
    }),

  toggleSimplifyDebts: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const group = await ctx.db.query.groups.findFirst({ where: eq(groups.id, input.groupId) });

      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      if (group.archivedAt) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Cannot toggle simplify debts for archived groups',
        });
      }

      const isInGroup = await ctx.db.query.groupUsers.findFirst({
        where: and(
          eq(groupUsers.groupId, input.groupId),
          eq(groupUsers.userId, ctx.session.user.id),
        ),
      });

      if (!isInGroup) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Only group members can toggle Simplify Debts',
        });
      }

      const simplifyDebtsInv = !group.simplifyDebts;

      await ctx.db
        .update(groups)
        .set({ simplifyDebts: simplifyDebtsInv })
        .where(eq(groups.id, input.groupId));

      // Send notifications asynchronously
      runInBackground(
        'push:simplify-debts',
        sendGroupSimplifyDebtsToggleNotification(
          input.groupId,
          ctx.session.user.id,
          simplifyDebtsInv,
        ),
      );

      return simplifyDebts;
    }),

  leaveGroup: groupProcedure
    .input(z.object({ groupId: z.number(), userId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const userId = input.userId ?? ctx.session.user.id;

      const group = await ctx.db.query.groups.findFirst({ where: eq(groups.id, input.groupId) });
      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      if (group.userId !== ctx.session.user.id && userId !== ctx.session.user.id) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Only group creator can remove someone from the group',
        });
      }

      const groupBalances = await groupBalancesOf(ctx.db, input.groupId);

      const finalGroupBalances = group.simplifyDebts ? simplifyDebts(groupBalances) : groupBalances;

      if (finalGroupBalances.some((b) => b.userId === userId && 0n !== b.amount)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'User has a non-zero balance in this group',
        });
      }

      const [[groupUser]] = (await runBatch([
        ctx.db
          .delete(groupUsers)
          .where(and(eq(groupUsers.groupId, input.groupId), eq(groupUsers.userId, userId)))
          .returning(),
        ctx.db.delete(groupDefaultSplits).where(eq(groupDefaultSplits.groupId, input.groupId)),
      ])) as [(typeof groupUsers.$inferSelect)[]];

      return groupUser;
    }),

  upsertDefaultSplit: groupProcedure
    .input(
      z.object({
        groupId: z.number(),
        defaultSplit: defaultSplitInputSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const parsed = deserializeDefaultSplit(input.defaultSplit);
      if (!parsed) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Malformed default split' });
      }

      const serialized = serializeDefaultSplit(parsed);

      const [groupDefaultSplit] = await ctx.db
        .insert(groupDefaultSplits)
        .values({
          groupId: input.groupId,
          splitType: serialized.splitType,
          shares: serialized.shares,
        })
        .onConflictDoUpdate({
          target: groupDefaultSplits.groupId,
          set: {
            splitType: serialized.splitType,
            shares: serialized.shares,
            updatedAt: new Date(),
          },
        })
        .returning();

      return {
        splitType: groupDefaultSplit!.splitType,
        shares: serialized.shares,
      };
    }),

  clearDefaultSplit: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db.delete(groupDefaultSplits).where(eq(groupDefaultSplits.groupId, input.groupId));
      return true;
    }),

  updateGroupDetails: groupProcedure
    .input(
      z.object({
        name: z.string().min(1),
        image: z.string().nullable().optional(),
        defaultCurrency: z.string().nullable().optional(),
        groupId: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const group = await ctx.db.query.groups.findFirst({ where: eq(groups.id, input.groupId) });

      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      const [updatedGroup] = await ctx.db
        .update(groups)
        .set({ name: input.name, image: input.image, defaultCurrency: input.defaultCurrency })
        .where(eq(groups.id, input.groupId))
        .returning();

      return updatedGroup;
    }),

  toggleArchive: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const found = await ctx.db.query.groups.findFirst({ where: eq(groups.id, input.groupId) });
      const group = found && { ...found, groupBalances: await groupBalancesOf(ctx.db, found.id) };

      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
      }

      // Check if user is a member of the group
      const isInGroup = await ctx.db.query.groupUsers.findFirst({
        where: and(
          eq(groupUsers.groupId, input.groupId),
          eq(groupUsers.userId, ctx.session.user.id),
        ),
      });

      if (!isInGroup) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Only group members can archive/unarchive the group',
        });
      }

      const isArchiving = !group.archivedAt;

      // Only check balances when archiving (not when unarchiving)
      if (isArchiving) {
        if (group?.simplifyDebts) {
          group.groupBalances = simplifyDebts(group.groupBalances);
        }

        const balanceWithNonZero = group.groupBalances.find((b) => 0n !== b.amount);

        if (balanceWithNonZero) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Cannot archive group with outstanding balances. All balances must be settled first.',
          });
        }
      }

      const [updatedGroup] = await ctx.db
        .update(groups)
        .set({ archivedAt: isArchiving ? new Date() : null })
        .where(eq(groups.id, input.groupId))
        .returning();

      return updatedGroup;
    }),

  delete: groupProcedure
    .input(z.object({ groupId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const found = await ctx.db.query.groups.findFirst({ where: eq(groups.id, input.groupId) });
      const group = found && { ...found, groupBalances: await groupBalancesOf(ctx.db, found.id) };

      if (group?.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Only creator can delete the group' });
      }

      if (group?.simplifyDebts) {
        group.groupBalances = simplifyDebts(group.groupBalances);
      }

      const balanceWithNonZero = group?.groupBalances.find((b) => 0n !== b.amount);

      if (balanceWithNonZero) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You have a non-zero balance in this group',
        });
      }

      await ctx.db.delete(groups).where(eq(groups.id, input.groupId));

      return group;
    }),
});

const groupBalancesOf = (database: DB, groupId: number) =>
  database.select().from(balanceView).where(eq(balanceView.groupId, groupId));

export type GroupRouter = typeof groupRouter;
