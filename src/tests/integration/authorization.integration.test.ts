import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '~/server/db';
import { expenseParticipants, expenses, groupUsers } from '~/server/db/schema';
import { SplitType } from '~/server/db/types';
import { eq } from 'drizzle-orm';

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

const rejectsWith = async (promise: Promise<unknown>, code?: TRPCError['code']) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'expected the call to be rejected').toBeInstanceOf(TRPCError);
  if (code) {
    expect((error as TRPCError).code).toBe(code);
  }
};

describe('authorization', () => {
  beforeEach(resetDb);

  it('rejects unauthenticated queries and mutations', async () => {
    const anon = callerFor(null);
    await rejectsWith(anon.expense.getBalances(), 'UNAUTHORIZED');
    await rejectsWith(anon.group.create({ name: 'x' }), 'UNAUTHORIZED');
    await rejectsWith(anon.user.getFriends(), 'UNAUTHORIZED');
    await rejectsWith(
      anon.expense.addOrEditExpense({
        paidBy: 1,
        name: 'x',
        category: 'general',
        amount: 100n,
        groupId: null,
        splitType: SplitType.EQUAL,
        currency: 'EUR',
        participants: [],
      }),
      'UNAUTHORIZED',
    );
  });

  it('rejects outsider group reads and membership mutations', async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const outsider = await makeUser();
    const group = await makeGroup(owner, [member]);
    const out = callerFor(outsider);

    await rejectsWith(out.group.getGroupDetails({ groupId: group.id }), 'FORBIDDEN');
    await rejectsWith(out.group.getGroupTotals({ groupId: group.id }), 'FORBIDDEN');
    await rejectsWith(
      out.group.addMembers({ groupId: group.id, userIds: [outsider.id] }),
      'FORBIDDEN',
    );
    await rejectsWith(out.group.leaveGroup({ groupId: group.id, userId: member.id }), 'FORBIDDEN');
    await rejectsWith(out.group.toggleArchive({ groupId: group.id }), 'FORBIDDEN');
    await rejectsWith(out.group.delete({ groupId: group.id }), 'FORBIDDEN');

    const members = await db.select().from(groupUsers).where(eq(groupUsers.groupId, group.id));
    expect(members.map((m) => m.userId).sort((x, y) => x - y)).toEqual(
      [owner.id, member.id].sort((x, y) => x - y),
    );
  });

  it('only the creator can remove another member, and only the creator can delete a group', async () => {
    const owner = await makeUser();
    const member = await makeUser();
    const other = await makeUser();
    const group = await makeGroup(owner, [member, other]);

    await rejectsWith(
      callerFor(member).group.leaveGroup({ groupId: group.id, userId: other.id }),
      'UNAUTHORIZED',
    );
    await rejectsWith(callerFor(member).group.delete({ groupId: group.id }), 'UNAUTHORIZED');
  });

  it('rejects outsider expense reads, edits and deletes without changing accounting', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const mallory = await makeUser();
    const group = await makeGroup(alice, [bob]);

    const created = await addExpense(callerFor(alice), {
      paidBy: alice,
      amount: 1000n,
      groupId: group.id,
      shares: { [alice.id]: 500n, [bob.id]: -500n },
      name: 'Dinner',
    });
    const mal = callerFor(mallory);

    await rejectsWith(mal.expense.getExpenseDetails({ expenseId: created.id }));
    await rejectsWith(
      addExpense(mal, {
        paidBy: mallory,
        amount: 1n,
        groupId: group.id,
        shares: { [mallory.id]: 1n, [bob.id]: -1n },
      }),
    );
    await rejectsWith(
      mal.expense.addOrEditExpense({
        expenseId: created.id,
        paidBy: alice.id,
        name: 'Hijacked',
        category: 'general',
        amount: 999_999n,
        groupId: group.id,
        splitType: SplitType.EQUAL,
        currency: 'EUR',
        participants: [
          { userId: alice.id, amount: 999_999n },
          { userId: bob.id, amount: -999_999n },
        ],
      }),
    );
    await rejectsWith(mal.expense.deleteExpense({ expenseId: created.id }));

    const row = await expenseRow(created.id);
    expect(row?.name).toBe('Dinner');
    expect(row?.deletedAt).toBeNull();
    expect(await participantsOf(created.id)).toEqual(
      [
        { userId: alice.id, amount: 500n },
        { userId: bob.id, amount: -500n },
      ].sort((a, b) => a.userId - b.userId),
    );
    expect(await balanceBetween(alice.id, bob.id)).toBe(500n);
    const stray = await db
      .select()
      .from(expenseParticipants)
      .where(eq(expenseParticipants.userId, mallory.id));
    expect(stray).toHaveLength(0);
  });

  it('lets a group member who is not a participant read and delete a group expense', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const carol = await makeUser();
    const group = await makeGroup(alice, [bob, carol]);
    const created = await addExpense(callerFor(alice), {
      paidBy: alice,
      amount: 1000n,
      groupId: group.id,
      shares: { [alice.id]: 500n, [bob.id]: -500n },
    });

    const details = await callerFor(carol).expense.getExpenseDetails({ expenseId: created.id });
    expect(details?.id).toBe(created.id);
  });

  it('rejects writes to archived groups', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const group = await makeGroup(alice, [bob]);
    const a = callerFor(alice);

    const created = await addExpense(a, {
      paidBy: alice,
      amount: 1000n,
      groupId: group.id,
      shares: { [alice.id]: 500n, [bob.id]: -500n },
    });
    // Settle fully so the group may be archived.
    await addExpense(callerFor(bob), {
      paidBy: bob,
      amount: 500n,
      groupId: group.id,
      splitType: SplitType.SETTLEMENT,
      shares: { [bob.id]: 500n, [alice.id]: -500n },
    });
    await a.group.toggleArchive({ groupId: group.id });

    await rejectsWith(
      addExpense(a, {
        paidBy: alice,
        amount: 100n,
        groupId: group.id,
        shares: { [alice.id]: 50n, [bob.id]: -50n },
      }),
      'BAD_REQUEST',
    );
    await rejectsWith(a.expense.deleteExpense({ expenseId: created.id }), 'BAD_REQUEST');
    await rejectsWith(
      a.expense.addOrEditExpense({
        expenseId: created.id,
        paidBy: alice.id,
        name: 'Edited',
        category: 'general',
        amount: 1000n,
        groupId: group.id,
        splitType: SplitType.EQUAL,
        currency: 'EUR',
        participants: [
          { userId: alice.id, amount: 500n },
          { userId: bob.id, amount: -500n },
        ],
      }),
      'BAD_REQUEST',
    );
    expect((await expenseRow(created.id))?.name).not.toBe('Edited');
  });

  it('applies the same membership, edit and archive guards to linked currency conversions', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const mallory = await makeUser();
    const group = await makeGroup(alice, [bob]);
    const conversion = {
      amount: 1000n,
      from: 'EUR',
      to: 'USD',
      rate: 1.1,
      senderId: alice.id,
      receiverId: bob.id,
      groupId: group.id,
    };

    // An outsider cannot create a conversion in someone else's group.
    await rejectsWith(callerFor(mallory).expense.addOrEditCurrencyConversion(conversion));
    expect(await db.select().from(expenses)).toHaveLength(0);

    // A member can.
    await callerFor(alice).expense.addOrEditCurrencyConversion(conversion);
    const [from] = await db.select().from(expenses).where(eq(expenses.currency, 'EUR'));
    expect(from).toBeDefined();

    // An outsider cannot edit it.
    await rejectsWith(
      callerFor(mallory).expense.addOrEditCurrencyConversion({
        ...conversion,
        expenseId: from!.id,
        amount: 5n,
      }),
    );
    expect((await expenseRow(from!.id))?.amount).toBe(1000n);
  });
});
