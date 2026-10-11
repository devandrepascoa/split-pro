import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDueJobs } from '~/server/api/services/scheduleService';
import { runRecurringJob } from '~/server/api/services/splitService';
import { db } from '~/server/db';
import { expenseRecurrences, expenses, jobs } from '~/server/db/schema';

import {
  addExpense,
  balanceBetween,
  callerFor,
  expenseRow,
  makeUser,
  participantsOf,
  resetDb,
} from './helpers';

const copiesOf = async (recurrenceId: number, templateId: string) =>
  (await db.select().from(expenses).where(eq(expenses.recurrenceId, recurrenceId))).filter(
    (e) => e.id !== templateId,
  );

describe('recurrence lifecycle', () => {
  beforeEach(resetDb);

  const setup = async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const a = callerFor(alice);
    const template = await addExpense(a, {
      paidBy: alice,
      amount: 1000n,
      name: 'Rent',
      shares: { [alice.id]: 500n, [bob.id]: -500n },
      cronExpression: '0 9 * * *',
    });
    const recurrenceId = (await expenseRow(template.id))!.recurrenceId!;
    const [job] = await db.select().from(jobs);
    return { alice, bob, a, template, recurrenceId, job: job! };
  };

  it('creates a job linked to the template expense', async () => {
    const { template, job, recurrenceId } = await setup();
    expect(recurrenceId).toBeGreaterThan(0);
    expect(job.jobname).toBe(`expense_recurring_${template.id}`);
    expect(job.command).toContain(template.id);
    expect(job.active).toBe(true);
    expect(job.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const [recurrence] = await db.select().from(expenseRecurrences);
    expect(recurrence?.jobId).toBe(job.jobid);
  });

  it('duplicates participants and balances once per slot, even if the step is retried', async () => {
    const { alice, bob, template, recurrenceId, job } = await setup();
    const slot1 = job.nextRunAt!;
    const now1 = new Date(slot1.getTime() + 60_000);

    expect((await getDueJobs(new Date(slot1.getTime() - 1))).map((j) => j.jobid)).not.toContain(
      job.jobid,
    );
    expect((await getDueJobs(now1)).map((j) => j.jobid)).toContain(job.jobid);

    const first = await runRecurringJob(job.jobid, now1);
    expect(first.skipped).toBe(false);
    let copies = await copiesOf(recurrenceId, template.id);
    expect(copies).toHaveLength(1);
    expect(await participantsOf(copies[0]!.id)).toEqual(await participantsOf(template.id));
    expect(await balanceBetween(alice.id, bob.id)).toBe(1000n); // Template + one copy

    const [afterFirst] = await db.select().from(jobs);
    expect(afterFirst!.nextRunAt!.getTime()).toBeGreaterThan(slot1.getTime());
    expect(afterFirst!.lastRunAt).toBeInstanceOf(Date);
    expect((await db.select().from(expenseRecurrences))[0]?.notified).toBe(false);

    // Same slot again: nothing is due, nothing is duplicated.
    expect((await runRecurringJob(job.jobid, now1)).skipped).toBe(true);

    // A retry after the job row was rolled back to the old slot must not create a second copy.
    await db.update(jobs).set({ nextRunAt: slot1 }).where(eq(jobs.jobid, job.jobid));
    await runRecurringJob(job.jobid, now1);
    copies = await copiesOf(recurrenceId, template.id);
    expect(copies).toHaveLength(1);
    expect(await balanceBetween(alice.id, bob.id)).toBe(1000n);

    // The next slot produces a second, distinct copy.
    const [afterRetry] = await db.select().from(jobs);
    await runRecurringJob(job.jobid, new Date(afterRetry!.nextRunAt!.getTime() + 60_000));
    copies = await copiesOf(recurrenceId, template.id);
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((c) => c.id)).size).toBe(2);
    expect(await balanceBetween(alice.id, bob.id)).toBe(1500n);
  });

  it('edits the schedule and stops only when the template is deleted', async () => {
    const { a, alice, template, recurrenceId, job } = await setup();

    await a.expense.updateRecurrence({ recurrenceId, cronExpression: '30 18 * * *' });
    const [edited] = await db.select().from(jobs);
    expect(edited!.schedule).toBe('30 18 * * *');
    expect(edited!.nextRunAt!.getUTCHours()).toBe(18);
    expect(edited!.nextRunAt!.getUTCMinutes()).toBe(30);

    // Deleting a generated copy keeps the recurrence running.
    await runRecurringJob(job.jobid, new Date(edited!.nextRunAt!.getTime() + 60_000));
    const [copy] = await copiesOf(recurrenceId, template.id);
    await a.expense.deleteExpense({ expenseId: copy!.id });
    expect(await db.select().from(jobs)).toHaveLength(1);

    // Deleting the template stops it.
    await a.expense.deleteExpense({ expenseId: template.id });
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect(await db.select().from(expenseRecurrences)).toHaveLength(0);
    expect((await expenseRow(template.id))?.recurrenceId).toBeNull();
    void alice;
  });

  it('deleteRecurrence removes the job but keeps the expenses', async () => {
    const { a, template, recurrenceId } = await setup();
    await a.expense.deleteRecurrence({ recurrenceId });
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect((await expenseRow(template.id))?.deletedAt).toBeNull();
    expect((await expenseRow(template.id))?.recurrenceId).toBeNull();
  });

  it("does not let a stranger change someone else's recurrence", async () => {
    const { recurrenceId } = await setup();
    const stranger = await makeUser();
    await expect(
      callerFor(stranger).expense.updateRecurrence({ recurrenceId, cronExpression: '0 0 * * *' }),
    ).rejects.toThrow();
    await expect(callerFor(stranger).expense.deleteRecurrence({ recurrenceId })).rejects.toThrow();
    expect(await db.select().from(jobs)).toHaveLength(1);
  });
});
