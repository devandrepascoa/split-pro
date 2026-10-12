import { expect, login, test, trpc } from './fixtures';
import { USERS } from './users.mjs';

/** Superjson input with BigInt fields: `bigints` lists the dotted paths that hold bigints. */
const sj = (json: unknown, bigints: string[] = []) => ({
  json,
  meta: bigints.length
    ? { values: Object.fromEntries(bigints.map((p) => [p, ['bigint']])) }
    : undefined,
});

const expenseInput = (opts: {
  paidBy: number;
  other: number;
  amount: number;
  groupId?: number | null;
  name?: string;
  splitType?: string;
  cronExpression?: string;
}) =>
  sj(
    {
      paidBy: opts.paidBy,
      name: opts.name ?? 'E2E dinner',
      category: 'food',
      amount: String(opts.amount),
      groupId: opts.groupId ?? null,
      splitType: opts.splitType ?? 'EQUAL',
      currency: 'EUR',
      participants: [
        { userId: opts.paidBy, amount: String(opts.amount / 2) },
        { userId: opts.other, amount: String(-opts.amount / 2) },
      ],
      cronExpression: opts.cronExpression,
    },
    ['amount', 'participants.0.amount', 'participants.1.amount'],
  );

// oxlint-disable-next-line typescript/no-explicit-any
const data = (result: { body: unknown }): any =>
  // oxlint-disable-next-line typescript/no-explicit-any
  (result.body as { result: { data: { json: any } } }[])[0].result.data.json;

// Tests share one database but never share rows: each one works on its own group or expense,
// So they can run in parallel.

test.describe('auth', () => {
  test('redirects visitors to sign in, which offers Google only', async ({ page }) => {
    await page.goto('/balances');
    await expect(page).toHaveURL(/\/auth\/signin/);
    await expect(page.getByText('Continue with Google')).toBeVisible();
  });

  test('a signed-in user sees the app instead of the sign-in page', async ({
    page,
    context,
    baseURL,
  }) => {
    await login(context, 'alice', baseURL!);
    await page.goto('/balances');
    await expect(page).toHaveURL(/\/balances/);
    await expect(page.getByText('Continue with Google')).toHaveCount(0);
  });

  test('tRPC rejects anonymous calls and serves signed-in ones', async ({ context, baseURL }) => {
    expect((await trpc(context, baseURL!, 'query', 'user.me')).status).toBe(401);
    await login(context, 'alice', baseURL!);
    const me = await trpc(context, baseURL!, 'query', 'user.me');
    expect(me.status).toBe(200);
    expect(data(me)).toMatchObject({ id: USERS.alice.id, email: USERS.alice.email });
  });
});

test.describe('groups, expenses and balances', () => {
  test('creates a group and an expense, shows both in the UI, and settles up', async ({
    page,
    context,
    baseURL,
  }) => {
    await login(context, 'alice', baseURL!);
    const groupName = `Trip ${Date.now()}`;

    const created = await trpc(
      context,
      baseURL!,
      'mutation',
      'group.create',
      sj({ name: groupName }),
    );
    expect(created.status).toBe(200);
    const group = data(created);
    await trpc(
      context,
      baseURL!,
      'mutation',
      'group.addMembers',
      sj({ groupId: group.id, userIds: [USERS.bob.id] }),
    );

    // BigInt + Date round trip through the real tRPC endpoint.
    const add = await trpc(
      context,
      baseURL!,
      'mutation',
      'expense.addOrEditExpense',
      expenseInput({
        paidBy: USERS.alice.id,
        other: USERS.bob.id,
        amount: 1000,
        groupId: group.id,
      }),
    );
    expect(add.status).toBe(200);

    await page.goto(`/groups/${group.id}`);
    await expect(page.getByText(groupName).first()).toBeVisible();
    await expect(page.getByText('E2E dinner').first()).toBeVisible();

    const groupBalances = async (): Promise<
      { userId: number; friendId: number; amount: string }[]
    > =>
      data(
        await trpc(context, baseURL!, 'query', 'group.getGroupDetails', sj({ groupId: group.id })),
      ).groupBalances;
    const before = (await groupBalances()).find(
      (b) => b.userId === USERS.alice.id && b.friendId === USERS.bob.id,
    );
    expect(before?.amount).toBe('500');

    await page.goto('/balances');
    await expect(page.getByText(USERS.bob.name).first()).toBeVisible();

    // Bob settles up; the group balance goes back to zero.
    await context.clearCookies();
    await login(context, 'bob', baseURL!);
    const settle = await trpc(
      context,
      baseURL!,
      'mutation',
      'expense.addOrEditExpense',
      expenseInput({
        paidBy: USERS.bob.id,
        other: USERS.alice.id,
        amount: 1000,
        groupId: group.id,
        splitType: 'SETTLEMENT',
        name: 'Settle up',
      }),
    );
    expect(settle.status).toBe(200);
    expect((await groupBalances()).every((b) => '0' === b.amount)).toBe(true);
  });

  test('a stranger cannot read or delete someone else’s expense', async ({ context, baseURL }) => {
    await login(context, 'alice', baseURL!);
    const add = await trpc(
      context,
      baseURL!,
      'mutation',
      'expense.addOrEditExpense',
      expenseInput({ paidBy: USERS.alice.id, other: USERS.bob.id, amount: 400, name: 'Private' }),
    );
    const expenseId = data(add)[0].id as string;

    await context.clearCookies();
    await login(context, 'mallory', baseURL!);
    const read = await trpc(
      context,
      baseURL!,
      'query',
      'expense.getExpenseDetails',
      sj({ expenseId }),
    );
    expect(read.status).toBe(404);
    const del = await trpc(
      context,
      baseURL!,
      'mutation',
      'expense.deleteExpense',
      sj({ expenseId }),
    );
    expect(del.status).toBeGreaterThanOrEqual(400);

    await context.clearCookies();
    await login(context, 'alice', baseURL!);
    const still = await trpc(
      context,
      baseURL!,
      'query',
      'expense.getExpenseDetails',
      sj({ expenseId }),
    );
    expect(still.status).toBe(200);
    expect(data(still).deletedAt).toBeNull();
  });

  test('creates a recurring expense and lists it (cron parsing works in the production bundle)', async ({
    context,
    baseURL,
  }) => {
    await login(context, 'alice', baseURL!);
    const name = `Monthly rent ${Date.now()}`;
    const add = await trpc(
      context,
      baseURL!,
      'mutation',
      'expense.addOrEditExpense',
      expenseInput({
        paidBy: USERS.alice.id,
        other: USERS.bob.id,
        amount: 800,
        name,
        cronExpression: '0 9 1 * *',
      }),
    );
    expect(add.status).toBe(200);
    const recurring = data(await trpc(context, baseURL!, 'query', 'expense.getRecurringExpenses'));
    expect(JSON.stringify(recurring)).toContain(name);
  });
});
