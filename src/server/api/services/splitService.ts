import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { nanoid } from 'nanoid';

import { bindings, db } from '~/server/db';
import { chunk, runBatch } from '~/server/db/batch';
import {
  SplitType,
  type User,
  balanceView,
  expenseParticipants,
  expenseRecurrences,
  expenses,
  groupUsers,
  groups,
  jobs,
  users,
} from '~/server/db/schema';
import { type SplitwiseGroup, type SplitwiseUser } from '~/types';

import type { CreateExpense } from '~/types/expense.types';
import { sendExpensePushNotification } from './notificationService';
import {
  deleteJob,
  jobIdSubquery,
  nextRunAt,
  recurringJobCommand,
  recurringJobName,
  updateJobSchedule,
} from './scheduleService';
import { runInBackground } from '~/server/observability/background';
import { getCurrencyHelpers } from '~/utils/numbers';
import { isCurrencyCode } from '~/lib/currency';
import { DEFAULT_CATEGORY } from '~/lib/category';
import { extractTemplateExpenseId } from '~/lib/cron';

interface Participant {
  userId: number;
  amount: bigint;
}

/** 3 bound parameters per participant row; D1 allows 100 per statement. */
const PARTICIPANT_CHUNK = 33;

const insertParticipants = (
  expenseId: string,
  participants: Participant[],
): BatchItem<'sqlite'>[] =>
  chunk(participants, PARTICIPANT_CHUNK).map((rows) =>
    db
      .insert(expenseParticipants)
      .values(rows.map((p) => ({ expenseId, userId: p.userId, amount: p.amount }))),
  );

/** Columns of an expense that a create/edit request may set. */
const expenseColumns = (e: CreateExpense) => ({
  groupId: e.groupId,
  paidBy: e.paidBy,
  name: e.name,
  category: e.category,
  amount: e.amount,
  splitType: e.splitType,
  currency: e.currency,
});

export async function joinGroup(userId: number, publicGroupId: string) {
  const group = await db.query.groups.findFirst({ where: eq(groups.publicId, publicGroupId) });

  if (!group) {
    throw new Error('Group not found');
  }

  await db.insert(groupUsers).values({ groupId: group.id, userId });

  return group;
}

export async function createExpense(
  input: CreateExpense & { cronExpression?: string },
  currentUserId: number,
  conversionFromParams?: CreateExpense,
) {
  const { participants, expenseDate, fileKey, transactionId, cronExpression } = input;
  const expenseId = crypto.randomUUID();
  const now = new Date();
  const items: BatchItem<'sqlite'>[] = [];

  // Recurrence: job -> ExpenseRecurrence -> Expense.recurrenceId, all resolved inside the batch.
  let recurrenceIdSql: ReturnType<typeof sql> | null = null;
  if (cronExpression) {
    const jobname = recurringJobName(expenseId);
    items.push(
      db.insert(jobs).values({
        schedule: cronExpression,
        command: recurringJobCommand(expenseId),
        jobname,
        nextRunAt: nextRunAt(cronExpression, now),
      }),
      db.insert(expenseRecurrences).values({ jobId: jobIdSubquery(jobname) }),
    );
    recurrenceIdSql = sql`(SELECT ${expenseRecurrences.id} FROM ${expenseRecurrences} WHERE ${expenseRecurrences.jobId} = ${jobIdSubquery(jobname)})`;
  }

  const expenseIndex = items.length;
  items.push(
    db
      .insert(expenses)
      .values({
        id: expenseId,
        ...expenseColumns(input),
        fileKey,
        addedBy: currentUserId,
        expenseDate: expenseDate ?? now,
        transactionId,
        recurrenceId: recurrenceIdSql,
      })
      .returning(),
  );
  items.push(...insertParticipants(expenseId, getNonZeroParticipants(participants)));

  // Currency conversion: the "from" expense points at this one via conversionToId.
  if (conversionFromParams) {
    const fromId = crypto.randomUUID();
    items.push(
      db.insert(expenses).values({
        id: fromId,
        ...expenseColumns(conversionFromParams),
        addedBy: currentUserId,
        expenseDate: conversionFromParams.expenseDate ?? now,
        conversionToId: expenseId,
      }),
      ...insertParticipants(fromId, getNonZeroParticipants(conversionFromParams.participants)),
    );
  }

  const results = await runBatch(items);
  const [createdExpense] = results[expenseIndex] as (typeof expenses.$inferSelect)[];
  if (!createdExpense) {
    throw new Error('Expense creation failed');
  }

  runInBackground('push:create', sendExpensePushNotification(createdExpense.id));
  return createdExpense;
}

const getExpenseWithJob = (expenseId: string) =>
  db.query.expenses.findFirst({
    where: eq(expenses.id, expenseId),
    with: { recurrence: { with: { job: true } } },
  });

export async function deleteExpense(expenseId: string, deletedBy: number) {
  const items: BatchItem<'sqlite'>[] = [];
  const touched: string[] = [];

  // Collect the expense and its conversion chain, then soft-delete all of them atomically.
  let currentId: string | null = expenseId;
  while (currentId) {
    const expense = await getExpenseWithJob(currentId);
    if (!expense) {
      throw new Error('Expense not found');
    }
    touched.push(expense.id);

    items.push(
      db
        .update(expenses)
        .set({ deletedBy, deletedAt: new Date() })
        .where(eq(expenses.id, expense.id)),
    );

    const job = expense.recurrence?.job;
    // Template deletion stops the recurrence; deleting a derived expense keeps it running.
    if (job && extractTemplateExpenseId(job.command) === expense.id) {
      items.push(deleteJob(job.jobid));
    }

    currentId = expense.conversionToId;
  }

  await runBatch(items);
  runInBackground('push:expense', sendExpensePushNotification(expenseId));
}

export async function editExpense(
  input: CreateExpense & { cronExpression?: string },
  currentUserId: number,
  conversionToParams?: CreateExpense,
) {
  const { expenseId, participants, expenseDate, fileKey, transactionId, cronExpression } = input;
  if (!expenseId) {
    throw new Error('Expense ID is required for editing');
  }

  const expense = await getExpenseWithJob(expenseId);
  if (!expense) {
    throw new Error('Expense not found');
  }

  const job = expense.recurrence?.job;
  const isTemplate = job ? extractTemplateExpenseId(job.command) === expenseId : false;

  if (conversionToParams && !expense.conversionToId) {
    throw new Error('Conversion to expense not found for editing');
  }

  const affectedIds = expense.conversionToId ? [expenseId, expense.conversionToId] : [expenseId];

  const items: BatchItem<'sqlite'>[] = [
    db.delete(expenseParticipants).where(inArray(expenseParticipants.expenseId, affectedIds)),
    db
      .update(expenses)
      .set({
        ...expenseColumns(input),
        fileKey,
        transactionId,
        ...(expenseDate && { expenseDate }),
        updatedBy: currentUserId,
      })
      .where(eq(expenses.id, expenseId)),
    ...insertParticipants(expenseId, participants),
  ];

  if (conversionToParams && expense.conversionToId) {
    items.push(
      db
        .update(expenses)
        .set({
          ...expenseColumns(conversionToParams),
          ...(conversionToParams.expenseDate && { expenseDate: conversionToParams.expenseDate }),
          updatedBy: currentUserId,
        })
        .where(eq(expenses.id, expense.conversionToId)),
      ...insertParticipants(expense.conversionToId, conversionToParams.participants),
    );
  }

  // Recurrence changes apply only to the template expense.
  if (isTemplate && job) {
    if (cronExpression && cronExpression !== job.schedule) {
      items.push(updateJobSchedule(job.jobid, cronExpression));
    } else if (!cronExpression) {
      items.push(deleteJob(job.jobid));
    }
  }

  await runBatch(items);
  runInBackground('push:expense', sendExpensePushNotification(expenseId));
  return { id: expenseId };
}

/**
 * Executes one recurring-expense job: copies the template expense and its participants.
 *
 * Idempotent per run slot: the copy's id is derived from (jobid, scheduled time), and the
 * inserts use INSERT OR IGNORE, so a retried Workflow step cannot create duplicates.
 */
export async function runRecurringJob(jobid: number, now: Date = new Date()) {
  const job = await db.query.jobs.findFirst({ where: eq(jobs.jobid, jobid) });
  if (!job?.active || !job.nextRunAt || job.nextRunAt > now) {
    return { skipped: true };
  }

  const templateId = extractTemplateExpenseId(job.command);
  const slot = job.nextRunAt;
  const newId = await deterministicUuid(`${jobid}:${slot.getTime()}`);
  const ts = now.getTime();

  // Drizzle's `db.run()` cannot be part of a D1 batch, so the whole batch is built from prepared
  // D1 statements. Drizzle builders contribute their SQL via `toSQL()`.
  const prepare = (statement: { sql: string; params: unknown[] }) =>
    bindings.DB.prepare(statement.sql).bind(...statement.params);

  await bindings.DB.batch([
    bindings.DB.prepare(
      `INSERT OR IGNORE INTO "Expense" (
        "id", "paidBy", "addedBy", "name", "category", "amount", "splitType", "expenseDate",
        "createdAt", "updatedAt", "currency", "groupId", "updatedBy", "recurrenceId"
      )
      SELECT ?, "paidBy", "addedBy", "name", "category", "amount", "splitType", ?,
        ?, ?, "currency", "groupId", "updatedBy", "recurrenceId"
      FROM "Expense" WHERE "id" = ?`,
    ).bind(newId, ts, ts, ts, templateId),
    bindings.DB.prepare(
      `INSERT OR IGNORE INTO "ExpenseParticipant" ("expenseId", "userId", "amount")
      SELECT ?, "userId", "amount" FROM "ExpenseParticipant"
      WHERE "expenseId" = ?
        AND EXISTS (SELECT 1 FROM "Expense" WHERE "id" = ?)`,
    ).bind(newId, templateId, newId),
    prepare(
      db
        .update(expenseRecurrences)
        .set({ notified: false })
        .where(eq(expenseRecurrences.jobId, jobid))
        .toSQL(),
    ),
    prepare(
      db
        .update(jobs)
        .set({ lastRunAt: now, nextRunAt: nextRunAt(job.schedule, now) })
        .where(eq(jobs.jobid, jobid))
        .toSQL(),
    ),
  ]);

  return { skipped: false, expenseId: newId };
}

const deterministicUuid = async (seed: string) => {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)),
  );
  const b = hash.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // Version 5-style
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export async function getCompleteFriendsDetails(userId: number) {
  const viewBalances = await db
    .select({
      balance: {
        friendId: balanceView.friendId,
        currency: balanceView.currency,
        amount: balanceView.amount,
      },
      friend: { email: users.email, name: users.name },
    })
    .from(balanceView)
    .innerJoin(users, eq(users.id, balanceView.friendId))
    .where(eq(balanceView.userId, userId));

  const friends = viewBalances.reduce<
    Record<
      number,
      {
        id: number;
        email?: string | null;
        name?: string | null;
        balances: { currency: string; amount: bigint }[];
      }
    >
  >((acc, { balance, friend }) => {
    const { friendId } = balance;
    acc[friendId] ??= {
      balances: [],
      id: friendId,
      email: friend.email,
      name: friend.name,
    };

    if (0n !== balance.amount) {
      acc[friendId]?.balances.push({
        currency: balance.currency,
        amount: balance.amount,
      });
    }

    return acc;
  }, {});

  return friends;
}

export async function getCompleteGroupDetails(userId: number) {
  const userGroups = await db.query.groups.findMany({
    where: inArray(
      groups.id,
      db
        .select({ groupId: groupUsers.groupId })
        .from(groupUsers)
        .where(eq(groupUsers.userId, userId)),
    ),
    with: { groupUsers: true },
  });

  if (0 === userGroups.length) {
    return [];
  }

  const balances = await db
    .select()
    .from(balanceView)
    .where(
      inArray(
        balanceView.groupId,
        userGroups.map((g) => g.id),
      ),
    );

  return userGroups.map((g) => ({
    ...g,
    groupBalances: balances.filter((b) => b.groupId === g.id),
  }));
}

export async function importUserBalanceFromSplitWise(
  currentUserId: number,
  splitWiseUsers: SplitwiseUser[],
) {
  const items: BatchItem<'sqlite'>[] = [];

  const importedUsers = await createUsersFromSplitwise(splitWiseUsers);

  const userMap = importedUsers.reduce<Record<string, User>>((acc, user) => {
    if (user.email) {
      acc[user.email] = user;
    }

    return acc;
  }, {});

  const currencyHelperCache: Record<string, ReturnType<typeof getCurrencyHelpers>['toSafeBigInt']> =
    {};

  for (const user of splitWiseUsers) {
    const dbUser = userMap[user.email];
    if (!dbUser) {
      // oxlint-disable-next-line no-continue
      continue;
    }

    for (const balance of user.balance) {
      const currency = balance.currency_code;

      currencyHelperCache[currency] ??= getCurrencyHelpers({
        currency: isCurrencyCode(currency) ? currency : 'USD',
      }).toSafeBigInt;

      const amount = currencyHelperCache[currency](balance.amount);
      const id = crypto.randomUUID();

      items.push(
        db.insert(expenses).values({
          id,
          name: 'Splitwise Balance Import',
          amount,
          currency,
          paidBy: currentUserId,
          splitType: SplitType.EQUAL,
          addedBy: currentUserId,
          category: DEFAULT_CATEGORY,
        }),
        ...insertParticipants(id, [
          { userId: currentUserId, amount },
          { userId: dbUser.id, amount: -amount },
        ]),
      );
    }
  }

  await runBatch(items);
}

async function createUsersFromSplitwise(splitwiseUsers: SplitwiseUser[]) {
  const userEmails = splitwiseUsers.map((u) => u.email);
  if (0 === userEmails.length) {
    return [];
  }

  const findExisting = async () =>
    (
      await Promise.all(
        chunk(userEmails, 90).map((emails) =>
          db.select().from(users).where(inArray(users.email, emails)),
        ),
      )
    ).flat();

  const existingEmails = new Set((await findExisting()).map((u) => u.email));
  const newUsers = splitwiseUsers.filter((u) => !existingEmails.has(u.email));

  // 2 bound parameters per row.
  await runBatch(
    chunk(newUsers, 45).map((rows) =>
      db
        .insert(users)
        .values(
          rows.map((u) => ({
            email: u.email,
            name: `${u.first_name}${u.last_name ? ` ${u.last_name}` : ''}`,
          })),
        )
        .onConflictDoNothing(),
    ),
  );

  return findExisting();
}

export async function importGroupFromSplitwise(
  currentUserId: number,
  splitWiseGroups: SplitwiseGroup[],
) {
  const splitwiseUserMap: Record<string, SplitwiseUser> = {};

  for (const group of splitWiseGroups) {
    for (const member of group.members) {
      splitwiseUserMap[member.id.toString()] = member;
    }
  }

  const importedUsers = await createUsersFromSplitwise(Object.values(splitwiseUserMap));

  const userMap = importedUsers.reduce<Record<string, User>>((acc, user) => {
    if (user.email) {
      acc[user.email] = user;
    }

    return acc;
  }, {});

  const missingGroups = await Promise.all(
    splitWiseGroups.map(async (group) => {
      const dbGroup = await db.query.groups.findFirst({
        where: eq(groups.splitwiseGroupId, group.id.toString()),
      });

      return dbGroup ? null : group;
    }),
  );

  const items: BatchItem<'sqlite'>[] = [];
  for (const group of missingGroups) {
    if (!group) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    const splitwiseGroupId = group.id.toString();
    const groupIdSql = sql`(SELECT ${groups.id} FROM ${groups} WHERE ${groups.splitwiseGroupId} = ${splitwiseGroupId})`;

    items.push(
      db.insert(groups).values({
        name: group.name,
        splitwiseGroupId,
        publicId: nanoid(),
        userId: currentUserId,
      }),
      // 2 bound parameters per row, plus the subquery parameter.
      ...chunk(group.members, 45).map((members) =>
        db.insert(groupUsers).values(
          members.map((member) => ({
            groupId: groupIdSql,
            userId: userMap[member.email.toString()]!.id,
          })),
        ),
      ),
    );
  }

  await runBatch(items);
}

const getNonZeroParticipants = (participants: Participant[]) =>
  participants.length > 1 ? participants.filter((p) => 0n !== p.amount) : participants;
