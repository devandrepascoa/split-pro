/**
 * Recurring-expense scheduling. Replaces pg_cron.
 *
 * Each recurring expense owns one row in the `job` table. The scheduler Workflow
 * (see worker-entry.ts) runs every minute and executes jobs whose `nextRunAt` is due.
 * The `command` column keeps the old pg_cron format so `extractTemplateExpenseId`
 * and the UI keep working.
 */
import cronParser from 'cron-parser';
import { and, eq, lt, lte, sql } from 'drizzle-orm';

import { db } from '~/server/db';
import { runBatch } from '~/server/db/batch';
import { cachedBankData, cachedCurrencyRates, jobs } from '~/server/db/schema';

export const recurringJobName = (expenseId: string) => `expense_recurring_${expenseId}`;

export const recurringJobCommand = (expenseId: string) =>
  `SELECT duplicate_expense_with_participants('${expenseId}'::UUID);`;

/** Pg_cron used `$` for "last day of month"; cron-parser uses `L`. Schedules are UTC. */
export const nextRunAt = (schedule: string, from: Date = new Date()): Date =>
  cronParser
    .parseExpression(schedule.replaceAll('$', 'L'), { currentDate: from, tz: 'UTC' })
    .next()
    .toDate();

/** True when `schedule` has an occurrence inside the minute that starts at `minute`. */
export const firesInMinute = (schedule: string, minute: Date): boolean => {
  const start = new Date(Math.floor(minute.getTime() / 60_000) * 60_000);
  return nextRunAt(schedule, new Date(start.getTime() - 1)).getTime() === start.getTime();
};

/** Parses a Postgres-style interval such as "2 days" or "12 hours" into milliseconds. */
export const parseInterval = (interval: string): number => {
  const match = /^\s*(\d+)\s*(minute|hour|day|week|month)s?\s*$/i.exec(interval);
  if (!match) {
    throw new Error(`Unsupported interval: ${interval}`);
  }
  const units: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
  };
  return Number(match[1]) * units[match[2]!.toLowerCase()]!;
};

export const getDueJobs = (now: Date = new Date()) =>
  db
    .select({ jobid: jobs.jobid })
    .from(jobs)
    .where(and(eq(jobs.active, true), lte(jobs.nextRunAt, now)))
    .limit(100);

/** Deletes cached bank data and currency rates that were not fetched within `interval`. */
export const deleteStaleCache = async (interval: string, now: Date = new Date()) => {
  const cutoff = new Date(now.getTime() - parseInterval(interval));
  await runBatch([
    db.delete(cachedBankData).where(lt(cachedBankData.lastFetched, cutoff)),
    db.delete(cachedCurrencyRates).where(lt(cachedCurrencyRates.lastFetched, cutoff)),
  ]);
};

export const updateJobSchedule = (jobid: number, schedule: string) =>
  db
    .update(jobs)
    .set({ schedule, nextRunAt: nextRunAt(schedule) })
    .where(eq(jobs.jobid, jobid));

/** Deleting the job cascades to ExpenseRecurrence, which sets Expense.recurrenceId to NULL. */
export const deleteJob = (jobid: number) => db.delete(jobs).where(eq(jobs.jobid, jobid));

export const jobIdSubquery = (jobname: string) =>
  sql`(SELECT ${jobs.jobid} FROM ${jobs} WHERE ${jobs.jobname} = ${jobname})`;
