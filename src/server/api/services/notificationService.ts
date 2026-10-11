import { SplitType } from '~/server/db/types';
import { isCurrencyCode } from '~/lib/currency';
import { type PushMessage } from '~/types';

import { and, desc, eq, inArray, or } from 'drizzle-orm';

import { db } from '~/server/db';
import { expenseRecurrences, expenses, groups, pushNotifications, users } from '~/server/db/schema';
import { pushNotification } from '~/server/notification';
import { getCurrencyHelpers } from '~/utils/numbers';

export const getSubscriptionEndpoint = (subscription: string) => {
  try {
    const parsed = JSON.parse(subscription) as { endpoint?: string };
    if ('string' === typeof parsed.endpoint && '' !== parsed.endpoint) {
      return parsed.endpoint;
    }
  } catch {
    return null;
  }

  return null;
};

const removeStalePushSubscriptions = async (
  subscriptions: { userId: number; endpoint: string }[],
) => {
  if (0 === subscriptions.length) {
    return;
  }

  await db
    .delete(pushNotifications)
    .where(
      or(
        ...subscriptions.map((s) =>
          and(eq(pushNotifications.userId, s.userId), eq(pushNotifications.endpoint, s.endpoint)),
        ),
      ),
    );
};

const isPermanentPushFailure = (statusCode: number | undefined) =>
  404 === statusCode || 410 === statusCode;

export const sendPushNotificationToUsers = async (userIds: number[], pushData: PushMessage) => {
  if (0 === userIds.length) {
    return { sentCount: 0 };
  }

  const subscriptions = await db
    .select()
    .from(pushNotifications)
    .where(inArray(pushNotifications.userId, userIds));

  const pushResults = await Promise.all(
    subscriptions.map(async (s) => {
      const result = await pushNotification(s.subscription, pushData);
      return { ...result, userId: s.userId, endpoint: s.endpoint };
    }),
  );

  await removeStalePushSubscriptions(
    pushResults
      .filter((result) => !result.ok && isPermanentPushFailure(result.statusCode))
      .map((result) => ({ userId: result.userId, endpoint: result.endpoint })),
  );

  return { sentCount: pushResults.filter((result) => result.ok).length };
};

export async function sendExpensePushNotification(expenseId: string) {
  const nameEmail = { columns: { name: true, email: true } } as const;
  const expense = await db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    columns: {
      paidBy: true,
      amount: true,
      currency: true,
      addedBy: true,
      name: true,
      deletedBy: true,
      splitType: true,
    },
    with: {
      deletedByUser: nameEmail,
      expenseParticipants: { columns: { userId: true, amount: true } },
      paidByUser: nameEmail,
      addedByUser: nameEmail,
      updatedByUser: nameEmail,
      conversionTo: { columns: { currency: true, amount: true } },
    },
  });

  if (!expense) {
    return;
  }

  const participants = expense.deletedBy
    ? expense.expenseParticipants.filter(
        ({ userId, amount }) => userId !== expense.deletedBy && 0n !== amount,
      )
    : expense.expenseParticipants.filter(
        ({ userId, amount }) => userId !== expense.addedBy && 0n !== amount,
      );

  // A way to localize it and reuse our utils would be ideal
  const getUserDisplayName = (user: { name: string | null; email: string | null } | null) =>
    user?.name ?? user?.email ?? '';

  const formatAmount = (currency: string, amount: bigint) => {
    const { toUIString } = getCurrencyHelpers({
      currency: isCurrencyCode(currency) ? currency : 'USD',
    });
    return toUIString(amount);
  };

  const getNotificationContent = (): { title: string; message: string } => {
    const payer = getUserDisplayName(expense.paidByUser);
    const adder = getUserDisplayName(expense.addedByUser);
    const amount = formatAmount(expense.currency, expense.amount);

    // Deleted expense
    if (expense.deletedBy) {
      return {
        title: getUserDisplayName(expense.deletedByUser),
        message: `Deleted ${expense.name}`,
      };
    }

    // Updated expense
    if (expense.updatedByUser) {
      return {
        title: getUserDisplayName(expense.updatedByUser),
        message: `Updated ${expense.name} ${amount}`,
      };
    }

    // Currency conversion
    if (expense.splitType === SplitType.CURRENCY_CONVERSION && expense.conversionTo) {
      const toAmount = formatAmount(expense.conversionTo.currency, expense.conversionTo.amount);
      return {
        title: adder,
        message: `${payer} converted ${amount} → ${toAmount}`,
      };
    }

    // Settlement
    if (expense.splitType === SplitType.SETTLEMENT) {
      return {
        title: adder,
        message: `${payer} settled up ${amount}`,
      };
    }

    // Regular expense
    return {
      title: adder,
      message: `${payer} paid ${amount} for ${expense.name}`,
    };
  };

  const pushData = {
    ...getNotificationContent(),
    data: {
      url: `/expenses/${expenseId}`,
    },
  };

  await sendPushNotificationToUsers(
    participants.map((p) => p.userId),
    pushData,
  );
}

export async function sendGroupSimplifyDebtsToggleNotification(
  groupId: number,
  togglerUserId: number,
  newState: boolean,
) {
  try {
    const group = await db.query.groups.findFirst({
      where: eq(groups.id, groupId),
      columns: { name: true },
      with: {
        groupUsers: {
          columns: { userId: true },
          with: { user: { columns: { name: true, email: true } } },
        },
      },
    });

    if (!group) {
      return;
    }

    const togglerUser = await db.query.users.findFirst({
      where: eq(users.id, togglerUserId),
      columns: { name: true, email: true },
    });

    if (!togglerUser) {
      return;
    }

    // Filter out the toggler from recipients
    const recipients = group.groupUsers.filter((gu) => gu.userId !== togglerUserId);

    if (recipients.length === 0) {
      return;
    }

    const getUserDisplayName = (user: { name: string | null; email: string | null } | null) =>
      user?.name ?? user?.email ?? '';

    const togglerName = getUserDisplayName(togglerUser);
    const stateText = newState ? 'on' : 'off';

    const pushData = {
      title: togglerName,
      message: `turned ${stateText} debt simplification for ${group.name}`,
      data: {
        url: `/groups/${groupId}`,
      },
    };

    await sendPushNotificationToUsers(
      recipients.map((r) => r.userId),
      pushData,
    );
  } catch (error) {
    console.error('Error sending group simplify debts toggle notifications', error);
  }
}

export async function checkRecurrenceNotifications() {
  try {
    const recurrences = await db.query.expenseRecurrences.findMany({
      where: eq(expenseRecurrences.notified, false),
      with: {
        expense: {
          columns: { id: true },
          orderBy: (e) => [desc(e.createdAt)],
          limit: 1,
        },
      },
    });

    await Promise.all(
      recurrences
        .filter((r) => r.expense[0])
        .map(async (r) => {
          await sendExpensePushNotification(r.expense[0]!.id);
          await db
            .update(expenseRecurrences)
            .set({ notified: true })
            .where(eq(expenseRecurrences.id, r.id));
        }),
    );
  } catch (e) {
    console.error('Error sending recurrence notifications', e);
    throw e;
  }
}
