import { beforeEach, describe, expect, it } from 'vitest';

import { SplitType } from '~/server/db/types';

import { addExpense, balanceBetween, callerFor, makeGroup, makeUser, resetDb } from './helpers';

describe('balance isolation and simplification', () => {
  beforeEach(resetDb);

  it('isolates groups and currencies and hides deleted expenses', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const g1 = await makeGroup(alice, [bob]);
    const g2 = await makeGroup(alice, [bob]);
    const a = callerFor(alice);
    const split = (n: bigint) => ({ [alice.id]: n, [bob.id]: -n });

    await addExpense(a, { paidBy: alice, amount: 2000n, groupId: g1.id, shares: split(1000n) });
    await addExpense(a, { paidBy: alice, amount: 600n, groupId: g2.id, shares: split(300n) });
    await addExpense(a, { paidBy: alice, amount: 400n, currency: 'USD', shares: split(200n) });
    const doomed = await addExpense(a, {
      paidBy: alice,
      amount: 10_000n,
      groupId: g1.id,
      shares: split(5000n),
    });

    expect(await balanceBetween(alice.id, bob.id, { groupId: g1.id, currency: 'EUR' })).toBe(6000n);

    await a.expense.deleteExpense({ expenseId: doomed.id });

    expect(await balanceBetween(alice.id, bob.id, { groupId: g1.id, currency: 'EUR' })).toBe(1000n);
    expect(await balanceBetween(alice.id, bob.id, { groupId: g2.id, currency: 'EUR' })).toBe(300n);
    expect(await balanceBetween(alice.id, bob.id, { groupId: null, currency: 'USD' })).toBe(200n);
    expect(await balanceBetween(bob.id, alice.id, { groupId: g1.id, currency: 'EUR' })).toBe(
      -1000n,
    );

    // GetBalances aggregates per friend and currency across groups.
    const { balances } = await a.expense.getBalances();
    const withBob = balances.find((b) => b.friendId === bob.id)!;
    const amountOf = (currency: string) =>
      withBob.currencies.find((c) => c.currency === currency)?.amount;
    expect(amountOf('EUR')).toBe(1300n);
    expect(amountOf('USD')).toBe(200n);
  });

  it('simplifies a three-member chain while preserving every member net balance', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const carol = await makeUser();
    const group = await makeGroup(alice, [bob, carol]);

    // Alice paid for Bob (100); Bob paid for Carol (100).
    await addExpense(callerFor(alice), {
      paidBy: alice,
      amount: 100n,
      groupId: group.id,
      shares: { [alice.id]: 100n, [bob.id]: -100n },
    });
    await addExpense(callerFor(bob), {
      paidBy: bob,
      amount: 100n,
      groupId: group.id,
      shares: { [bob.id]: 100n, [carol.id]: -100n },
    });
    await callerFor(alice).group.toggleSimplifyDebts({ groupId: group.id });

    const details = await callerFor(alice).group.getGroupDetails({ groupId: group.id });
    const balances = details?.groupBalances ?? [];

    // The chain collapses to one edge: Carol owes Alice 100, Bob is out of it.
    expect(balances.filter((b) => 0n !== b.amount)).toHaveLength(2);
    expect(balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: alice.id, friendId: carol.id, amount: 100n }),
        expect.objectContaining({ userId: carol.id, friendId: alice.id, amount: -100n }),
      ]),
    );

    // Every member's net position is preserved (and the whole group nets to zero).
    const netOf = (userId: number) =>
      balances.filter((b) => b.userId === userId).reduce((sum, b) => sum + b.amount, 0n);
    expect(netOf(alice.id)).toBe(100n);
    expect(netOf(bob.id)).toBe(0n);
    expect(netOf(carol.id)).toBe(-100n);
    expect(balances.reduce((sum, b) => sum + b.amount, 0n)).toBe(0n);
  });

  it('keeps a plain two-person balance symmetric', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await addExpense(callerFor(alice), {
      paidBy: alice,
      amount: 1234n,
      splitType: SplitType.EXACT,
      shares: { [alice.id]: 700n, [bob.id]: -700n },
    });
    expect(await balanceBetween(alice.id, bob.id)).toBe(700n);
    expect(await balanceBetween(bob.id, alice.id)).toBe(-700n);
  });
});
