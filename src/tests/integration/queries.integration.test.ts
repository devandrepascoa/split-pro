import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getCompleteGroupDetails } from '~/server/api/services/splitService';
import { db } from '~/server/db';
import { users } from '~/server/db/schema';
import { SplitType } from '~/server/db/types';

import { addExpense, callerFor, makeGroup, makeUser, resetDb } from './helpers';

/**
 * Regression tests for the Drizzle/D1 query layer: every one of these ran real SQL against D1.
 * `getFriend` and `getCompleteGroupDetails` once failed in production with
 * "no such column: User.id" (correlated subquery against an aliased table).
 */
describe('query layer on D1', () => {
  beforeEach(resetDb);

  it('getFriend returns a friend only when a balance relationship exists', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const stranger = await makeUser();
    await addExpense(callerFor(alice), {
      paidBy: alice,
      amount: 1000n,
      shares: { [alice.id]: 500n, [bob.id]: -500n },
    });

    const friend = await callerFor(alice).user.getFriend({ friendId: bob.id });
    expect(friend?.id).toBe(bob.id);
    expect((await callerFor(bob).user.getFriend({ friendId: alice.id }))?.id).toBe(alice.id);
    expect(await callerFor(alice).user.getFriend({ friendId: stranger.id })).toBeFalsy();
  });

  it('getCompleteGroupDetails only returns the groups the user belongs to', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const carol = await makeUser();
    const shared = await makeGroup(alice, [bob], 'Shared');
    await makeGroup(carol, [], 'Private');
    await addExpense(callerFor(alice), {
      paidBy: alice,
      amount: 1000n,
      groupId: shared.id,
      shares: { [alice.id]: 500n, [bob.id]: -500n },
    });

    const aliceGroups = await getCompleteGroupDetails(alice.id);
    expect(aliceGroups.map((g) => g.id)).toEqual([shared.id]);
    expect(aliceGroups[0]!.groupBalances.some((b) => 0n !== b.amount)).toBe(true);
    expect((await getCompleteGroupDetails(carol.id)).map((g) => g.name)[0]).toContain('Private');
    expect(await getCompleteGroupDetails((await makeUser()).id)).toEqual([]);
  });

  it('deleteFriend refuses while a balance is outstanding, then hides the friend once', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await addExpense(callerFor(alice), {
      paidBy: alice,
      amount: 1000n,
      shares: { [alice.id]: 500n, [bob.id]: -500n },
    });
    await expect(callerFor(alice).user.deleteFriend({ friendId: bob.id })).rejects.toThrow(
      /outstanding balances/,
    );

    await addExpense(callerFor(bob), {
      paidBy: bob,
      amount: 500n,
      splitType: SplitType.SETTLEMENT,
      shares: { [bob.id]: 500n, [alice.id]: -500n },
    });
    await callerFor(alice).user.deleteFriend({ friendId: bob.id });
    await callerFor(alice).user.deleteFriend({ friendId: bob.id });

    const [row] = await db.select().from(users).where(eq(users.id, alice.id));
    expect(row!.hiddenFriendIds).toEqual([bob.id]);
  });

  it('a new shared expense un-hides the friend on both sides (trigger)', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const carol = await makeUser();
    await db
      .update(users)
      .set({ hiddenFriendIds: [bob.id, carol.id] })
      .where(eq(users.id, alice.id));
    await db
      .update(users)
      .set({ hiddenFriendIds: [alice.id] })
      .where(eq(users.id, bob.id));

    await addExpense(callerFor(bob), {
      paidBy: bob,
      amount: 1000n,
      shares: { [bob.id]: 500n, [alice.id]: -500n },
    });

    const [a] = await db.select().from(users).where(eq(users.id, alice.id));
    const [b] = await db.select().from(users).where(eq(users.id, bob.id));
    expect(a!.hiddenFriendIds).toEqual([carol.id]);
    expect(b!.hiddenFriendIds).toEqual([]);
  });

  it('every read procedure runs valid SQL against a populated database', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const group = await makeGroup(alice, [bob]);
    const a = callerFor(alice);
    const expense = await addExpense(a, {
      paidBy: alice,
      amount: 1000n,
      groupId: group.id,
      shares: { [alice.id]: 500n, [bob.id]: -500n },
      cronExpression: '0 9 * * *',
    });

    await expect(a.user.me()).resolves.toBeDefined();
    await expect(a.user.getFriends()).resolves.toBeDefined();
    await expect(a.user.getOwnExpenses()).resolves.toHaveLength(1);
    await expect(a.user.getBalancesWithFriend({ friendId: bob.id })).resolves.toBeDefined();
    await expect(a.user.getUserDetails({ userId: bob.id })).resolves.toBeDefined();
    await expect(a.user.downloadData()).resolves.toBeDefined();
    await expect(a.expense.getBalances()).resolves.toBeDefined();
    await expect(a.expense.getCumulatedBalances()).resolves.toBeDefined();
    await expect(a.expense.getExpensesWithFriend({ friendId: bob.id })).resolves.toBeDefined();
    await expect(a.expense.getGroupExpenses({ groupId: group.id })).resolves.toHaveLength(1);
    await expect(a.expense.getExpenseDetails({ expenseId: expense.id })).resolves.toMatchObject({
      id: expense.id,
    });
    await expect(a.expense.getAllExpenses()).resolves.toBeDefined();
    await expect(a.expense.getRecurringExpenses()).resolves.toHaveLength(1);
    await expect(a.group.getAllGroups()).resolves.toHaveLength(1);
    await expect(a.group.getAllGroupsWithBalances()).resolves.toBeDefined();
    await expect(a.group.getGroupDetails({ groupId: group.id })).resolves.toBeDefined();
    await expect(a.group.getGroupTotals({ groupId: group.id })).resolves.toBeDefined();
  });
});
