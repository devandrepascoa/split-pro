import { TRPCError } from '@trpc/server';
import type { SessionUser as User } from '~/server/auth';
import { z } from 'zod';

import { env } from '~/env';
import {
  deserializeDefaultSplit,
  serializeDefaultSplit,
  toSortedFriendPair,
} from '~/lib/defaultSplit';
import { simplifyDebts } from '~/lib/simplify';
import { createTRPCRouter, protectedProcedure } from '~/server/api/trpc';
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';

import { db } from '~/server/db';
import { runInBackground } from '~/server/observability/background';
import {
  balanceView,
  expenses,
  friendDefaultSplits,
  groups,
  pushNotifications,
  users,
} from '~/server/db/schema';
import { sendFeedbackEmail, sendInviteEmail } from '~/server/mailer';
import { SplitwiseGroupSchema, SplitwiseUserSchema } from '~/types';

import {
  getSubscriptionEndpoint,
  sendPushNotificationToUsers,
} from '../services/notificationService';
import {
  getCompleteFriendsDetails,
  getCompleteGroupDetails,
  importGroupFromSplitwise,
  importUserBalanceFromSplitWise,
} from '../services/splitService';

export const userRouter = createTRPCRouter({
  me: protectedProcedure.query(({ ctx }) => ctx.session.user),

  getFriends: protectedProcedure.query(async ({ ctx }) => {
    const friends = await db
      .selectDistinct({ friend: users })
      .from(balanceView)
      .innerJoin(users, eq(users.id, balanceView.friendId))
      .where(
        and(
          eq(balanceView.userId, ctx.session.user.id),
          notInArray(balanceView.friendId, ctx.session.user.hiddenFriendIds),
        ),
      );

    return friends.map((f) => f.friend);
  }),

  getOwnExpenses: protectedProcedure.query(async ({ ctx }) => {
    const ownExpenses = await db.query.expenses.findMany({
      where: and(eq(expenses.paidBy, ctx.session.user.id), isNull(expenses.deletedBy)),
      orderBy: [desc(expenses.expenseDate)],
      with: { group: true },
    });

    return ownExpenses;
  }),

  inviteFriend: protectedProcedure
    .input(z.object({ email: z.string(), sendInviteEmail: z.boolean().optional() }))
    .mutation(async ({ input, ctx: { session } }) => {
      const email = input.email.toLowerCase();
      const friend = await db.query.users.findFirst({ where: eq(users.email, email) });

      if (friend) {
        return friend;
      }

      const [user] = await db
        .insert(users)
        .values({ email, name: email.split('@')[0] })
        .returning();
      if (!user) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create user' });
      }

      if (input.sendInviteEmail) {
        runInBackground(
          'invite-email',
          sendInviteEmail(input.email, session.user.name ?? session.user.email ?? ''),
        );
      }

      return user;
    }),

  getBalancesWithFriend: protectedProcedure
    .input(z.object({ friendId: z.number() }))
    .query(async ({ input, ctx }) => {
      const rawBalances = await db
        .select({
          groupId: balanceView.groupId,
          currency: balanceView.currency,
          amount: balanceView.amount,
          group: { name: groups.name, simplifyDebts: groups.simplifyDebts },
        })
        .from(balanceView)
        .leftJoin(groups, eq(groups.id, balanceView.groupId))
        .where(
          and(
            eq(balanceView.userId, ctx.session.user.id),
            eq(balanceView.friendId, input.friendId),
            ne(balanceView.amount, 0n),
          ),
        );

      const processedBalances = await Promise.all(
        rawBalances.map(async ({ groupId, currency, amount, group }) => {
          // For non-simplifyDebts groups and non-group balances, use raw balance
          if (!group?.simplifyDebts || null === groupId) {
            return {
              friendId: input.friendId,
              currency,
              amount,
              groupId,
              groupName: group?.name ?? null,
            };
          }

          // For simplifyDebts groups, fetch all group balances and simplify
          const allGroupBalances = await db
            .select()
            .from(balanceView)
            .where(and(eq(balanceView.groupId, groupId), eq(balanceView.currency, currency)));

          const simplified = simplifyDebts(allGroupBalances);

          const simplifiedBalance = simplified.find(
            (b) =>
              b.userId === ctx.session.user.id &&
              b.friendId === input.friendId &&
              b.currency === currency,
          );

          return {
            friendId: input.friendId,
            currency,
            amount: simplifiedBalance?.amount ?? 0n,
            groupId,
            groupName: group.name,
          };
        }),
      );

      return processedBalances.filter((b) => 0n !== b.amount);
    }),

  updateUserDetail: protectedProcedure
    .input(
      z.object({
        name: z.string().optional(),
        image: z.string().nullable().optional(),
        currency: z.string().optional(),
        defaultCurrency: z.string().nullable().optional(),
        obapiProviderId: z.string().optional(),
        bankingId: z.string().optional(),
        preferredLanguage: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [user] = await db
        .update(users)
        .set(input)
        .where(eq(users.id, ctx.session.user.id))
        .returning();

      return user;
    }),

  getUserDetails: protectedProcedure
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });

      return user;
    }),

  submitFeedback: protectedProcedure
    .input(z.object({ feedback: z.string().min(10) }))
    .mutation(async ({ input, ctx }) => {
      await sendFeedbackEmail(input.feedback, ctx.session.user);
    }),

  getFriend: protectedProcedure
    .input(z.object({ friendId: z.number() }))
    .query(async ({ input, ctx }) => {
      const friend = await db.query.users.findFirst({
        // Uncorrelated IN subquery: relational queries alias the outer table, so a correlated
        // Reference to `users.id` would render as "User"."id" and fail on D1.
        where: and(
          eq(users.id, input.friendId),
          inArray(
            users.id,
            db
              .select({ userId: balanceView.userId })
              .from(balanceView)
              .where(eq(balanceView.friendId, ctx.session.user.id)),
          ),
        ),
      });

      if (!friend) {
        return friend;
      }

      const [userAId, userBId] = toSortedFriendPair(ctx.session.user.id, input.friendId);

      const friendDefaultSplit = await db.query.friendDefaultSplits.findFirst({
        where: and(
          eq(friendDefaultSplits.userAId, userAId),
          eq(friendDefaultSplits.userBId, userBId),
        ),
      });

      const defaultSplit =
        friendDefaultSplit &&
        (() => {
          const parsedShares = z
            .record(z.string(), z.string())
            .safeParse(friendDefaultSplit.shares);
          if (!parsedShares.success) {
            return null;
          }

          return deserializeDefaultSplit({
            splitType: friendDefaultSplit.splitType,
            shares: parsedShares.data,
          });
        })();

      return {
        ...friend,
        defaultSplit: defaultSplit ? serializeDefaultSplit(defaultSplit) : null,
      };
    }),

  upsertFriendDefaultSplit: protectedProcedure
    .input(
      z.object({
        friendId: z.number(),
        defaultSplit: z.object({
          splitType: z.enum(['EQUAL', 'PERCENTAGE', 'SHARE']),
          shares: z.record(z.string(), z.string()),
        }),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const friend = await db.query.users.findFirst({
        // Uncorrelated IN subquery: relational queries alias the outer table, so a correlated
        // Reference to `users.id` would render as "User"."id" and fail on D1.
        where: and(
          eq(users.id, input.friendId),
          inArray(
            users.id,
            db
              .select({ userId: balanceView.userId })
              .from(balanceView)
              .where(eq(balanceView.friendId, ctx.session.user.id)),
          ),
        ),
      });

      if (!friend) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Friend not found' });
      }

      const parsed = deserializeDefaultSplit(input.defaultSplit);
      if (!parsed) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Malformed default split' });
      }

      const [userAId, userBId] = toSortedFriendPair(ctx.session.user.id, input.friendId);
      const serialized = serializeDefaultSplit(parsed);

      await db
        .insert(friendDefaultSplits)
        .values({ userAId, userBId, splitType: serialized.splitType, shares: serialized.shares })
        .onConflictDoUpdate({
          target: [friendDefaultSplits.userAId, friendDefaultSplits.userBId],
          set: {
            splitType: serialized.splitType,
            shares: serialized.shares,
            updatedAt: new Date(),
          },
        });

      return serialized;
    }),

  clearFriendDefaultSplit: protectedProcedure
    .input(z.object({ friendId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const [userAId, userBId] = toSortedFriendPair(ctx.session.user.id, input.friendId);
      await db
        .delete(friendDefaultSplits)
        .where(
          and(eq(friendDefaultSplits.userAId, userAId), eq(friendDefaultSplits.userBId, userBId)),
        );
      return true;
    }),

  updatePushNotification: protectedProcedure
    .input(z.object({ subscription: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const endpoint = getSubscriptionEndpoint(input.subscription);

      if (!endpoint) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid push subscription payload',
        });
      }

      await db
        .insert(pushNotifications)
        .values({ userId: ctx.session.user.id, endpoint, subscription: input.subscription })
        .onConflictDoUpdate({
          target: [pushNotifications.userId, pushNotifications.endpoint],
          set: { subscription: input.subscription },
        });
    }),

  deletePushNotification: protectedProcedure
    .input(z.object({ subscription: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const endpoint = getSubscriptionEndpoint(input.subscription);
      if (!endpoint) {
        return;
      }

      await db
        .delete(pushNotifications)
        .where(
          and(
            eq(pushNotifications.userId, ctx.session.user.id),
            eq(pushNotifications.endpoint, endpoint),
          ),
        )
        .catch(() => null);
    }),

  sendTestPushNotification: protectedProcedure.mutation(async ({ ctx }) => {
    const { sentCount } = await sendPushNotificationToUsers([ctx.session.user.id], {
      title: 'SplitPro',
      message: 'Test notification from debug info',
      data: {
        url: '/account',
      },
    });

    return { sentCount };
  }),

  deleteFriend: protectedProcedure
    .input(z.object({ friendId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const total = sql<number>`SUM(${balanceView.amount})`;
      const friendBalances = await db
        .select({ currency: balanceView.currency, amount: total })
        .from(balanceView)
        .where(
          and(
            eq(balanceView.userId, ctx.session.user.id),
            eq(balanceView.friendId, input.friendId),
            ne(balanceView.amount, 0n),
          ),
        )
        .groupBy(balanceView.currency)
        .having(sql`${total} != 0`);

      if (0 < friendBalances.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You have outstanding balances with this friend',
        });
      }

      // Atomic JSON array append (no read-modify-write race).
      await db
        .update(users)
        .set({
          hiddenFriendIds: sql`(
            SELECT json_group_array(value) FROM (
              SELECT value FROM json_each(${users.hiddenFriendIds})
              UNION SELECT ${input.friendId}
            )
          )`,
        })
        .where(eq(users.id, ctx.session.user.id));
    }),

  downloadData: protectedProcedure.mutation(async ({ ctx }) => {
    const { user } = ctx.session;

    const friends = await getCompleteFriendsDetails(user.id);
    const groups = await getCompleteGroupDetails(user.id);

    return { friends, groups };
  }),

  importUsersFromSplitWise: protectedProcedure
    .input(
      z.object({
        usersWithBalance: z.array(SplitwiseUserSchema),
        groups: z.array(SplitwiseGroupSchema),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await importUserBalanceFromSplitWise(ctx.session.user.id, input.usersWithBalance);
      await importGroupFromSplitwise(ctx.session.user.id, input.groups);
    }),

  getWebPushPublicKey: protectedProcedure.query(() => env.WEB_PUSH_PUBLIC_KEY ?? ''),
});

export const getUserMap = async (userIds: number[]) => {
  const found =
    0 === userIds.length ? [] : await db.select().from(users).where(inArray(users.id, userIds));

  return Object.fromEntries(found.map((u) => [u.id, u]));
};

export type UserRouter = typeof userRouter;
