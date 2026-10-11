import { beforeEach, describe, expect, it } from 'vitest';

import { SplitType } from '~/server/db/types';

import {
  addExpense,
  balanceBetween,
  callerFor,
  expenseRow,
  makeGroup,
  makeUser,
  participantsOf,
  resetDb,
} from './helpers';

describe('expense lifecycle', () => {
  beforeEach(resetDb);

  it.each([false, true])(
    'creates, edits and soft-deletes an expense with exact bidirectional balances (group: %s)',
    async (inGroup) => {
      const alice = await makeUser();
      const bob = await makeUser();
      const groupId = inGroup ? (await makeGroup(alice, [bob])).id : null;
      const a = callerFor(alice);

      const created = await addExpense(a, {
        paidBy: alice,
        amount: 1000n,
        groupId,
        name: 'Dinner',
        shares: { [alice.id]: 500n, [bob.id]: -500n },
      });
      expect(await balanceBetween(alice.id, bob.id)).toBe(500n);
      expect(await balanceBetween(bob.id, alice.id)).toBe(-500n);

      await a.expense.addOrEditExpense({
        expenseId: created.id,
        paidBy: alice.id,
        name: 'Dinner + drinks',
        category: 'food',
        amount: 1200n,
        groupId,
        splitType: SplitType.EQUAL,
        currency: 'EUR',
        participants: [
          { userId: alice.id, amount: 600n },
          { userId: bob.id, amount: -600n },
        ],
      });
      expect((await expenseRow(created.id))?.name).toBe('Dinner + drinks');
      expect((await expenseRow(created.id))?.updatedBy).toBe(alice.id);
      expect(await balanceBetween(alice.id, bob.id)).toBe(600n);
      expect(await balanceBetween(bob.id, alice.id)).toBe(-600n);

      await callerFor(bob).expense.deleteExpense({ expenseId: created.id });
      const deleted = await expenseRow(created.id);
      expect(deleted?.deletedAt).toBeInstanceOf(Date);
      expect(deleted?.deletedBy).toBe(bob.id);
      expect(await balanceBetween(alice.id, bob.id)).toBe(0n);
      expect(await balanceBetween(bob.id, alice.id)).toBe(0n);
    },
  );

  it('preserves the original expense if an edit transaction fails', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const a = callerFor(alice);
    const created = await addExpense(a, {
      paidBy: alice,
      amount: 1000n,
      name: 'Original',
      shares: { [alice.id]: 500n, [bob.id]: -500n },
    });

    // The last statement of the edit batch references a user that does not exist, so the
    // Foreign key fails. Atomicity means none of the earlier statements may stay applied.
    const missingUserId = 999_999;
    await expect(
      a.expense.addOrEditExpense({
        expenseId: created.id,
        paidBy: alice.id,
        name: 'Should not persist',
        category: 'food',
        amount: 5000n,
        groupId: null,
        splitType: SplitType.EQUAL,
        currency: 'EUR',
        participants: [
          { userId: alice.id, amount: 2500n },
          { userId: missingUserId, amount: -2500n },
        ],
      }),
    ).rejects.toThrow();

    const row = await expenseRow(created.id);
    expect(row?.name).toBe('Original');
    expect(row?.amount).toBe(1000n);
    expect(await participantsOf(created.id)).toEqual(
      [
        { userId: alice.id, amount: 500n },
        { userId: bob.id, amount: -500n },
      ].sort((x, y) => x.userId - y.userId),
    );
    expect(await balanceBetween(alice.id, bob.id)).toBe(500n);
  });

  it('does not create a half-written expense when creation fails', async () => {
    const alice = await makeUser();
    await expect(
      callerFor(alice).expense.addOrEditExpense({
        paidBy: alice.id,
        name: 'Broken',
        category: 'food',
        amount: 100n,
        groupId: null,
        splitType: SplitType.EQUAL,
        currency: 'EUR',
        participants: [
          { userId: alice.id, amount: 50n },
          { userId: 999_999, amount: -50n },
        ],
      }),
    ).rejects.toThrow();

    const { expenses } = await import('~/server/db/schema');
    const { db } = await import('~/server/db');
    expect(await db.select().from(expenses)).toHaveLength(0);
  });
});

describe('settlement accounting', () => {
  beforeEach(resetDb);

  it.each([false, true])(
    'partially then fully settles a debt, editing and deleting the settlement (group: %s)',
    async (inGroup) => {
      const alice = await makeUser();
      const bob = await makeUser();
      const groupId = inGroup ? (await makeGroup(alice, [bob])).id : null;

      // Bob owes Alice 500.
      await addExpense(callerFor(alice), {
        paidBy: alice,
        amount: 1000n,
        groupId,
        shares: { [alice.id]: 500n, [bob.id]: -500n },
      });
      expect(await balanceBetween(bob.id, alice.id)).toBe(-500n);

      const settle = (amount: bigint) =>
        addExpense(callerFor(bob), {
          paidBy: bob,
          amount,
          groupId,
          splitType: SplitType.SETTLEMENT,
          name: 'Settle up',
          shares: { [bob.id]: amount, [alice.id]: -amount },
        });

      const partial = await settle(200n);
      expect(await balanceBetween(bob.id, alice.id)).toBe(-300n);
      expect(await balanceBetween(alice.id, bob.id)).toBe(300n);

      await settle(300n);
      expect(await balanceBetween(bob.id, alice.id)).toBe(0n);
      expect(await balanceBetween(alice.id, bob.id)).toBe(0n);

      // Undo the partial settlement: the debt comes back by exactly that amount.
      await callerFor(alice).expense.deleteExpense({ expenseId: partial.id });
      expect(await balanceBetween(alice.id, bob.id)).toBe(200n);
    },
  );
});
