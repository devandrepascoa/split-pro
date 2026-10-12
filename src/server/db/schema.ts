/**
 * Drizzle schema for Cloudflare D1 (SQLite). Port of the former Prisma/Postgres schema.
 *
 * Conventions:
 * - Table and column names match the old Prisma names, so SQL stays familiar.
 * - Money amounts are stored as INTEGER (minor units) and surfaced as `bigint` in JS.
 * - Timestamps are stored as INTEGER milliseconds and surfaced as `Date`.
 */
import { relations, sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { SplitType } from './enums';

export { SplitType };
const splitTypeValues = Object.values(SplitType) as [SplitType, ...SplitType[]];

/** INTEGER column surfaced as bigint. D1 returns numbers; amounts stay well below 2^53. */
export const bigintInt = customType<{ data: bigint; driverData: number | bigint }>({
  dataType: () => 'integer',
  toDriver: (value) => Number(value),
  fromDriver: (value) => BigInt(value),
});

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const createdAt = () =>
  timestamp('createdAt')
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  timestamp('updatedAt')
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
const randomId = () => crypto.randomUUID();

export const users = sqliteTable('User', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  currency: text('currency').notNull().default('USD'),
  defaultCurrency: text('defaultCurrency'),
  preferredLanguage: text('preferredLanguage').notNull().default(''),
  bankingId: text('bankingId'),
  obapiProviderId: text('obapiProviderId'),
  hiddenFriendIds: text('hiddenFriendIds', { mode: 'json' })
    .$type<number[]>()
    .notNull()
    .default(sql`'[]'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Better-auth tables (serial ids; see src/server/auth.ts).
export const accounts = sqliteTable(
  'Account',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('Account_providerId_accountId_key').on(t.providerId, t.accountId),
    index('Account_userId_idx').on(t.userId),
  ],
);

export const sessions = sqliteTable(
  'Session',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    token: text('token').notNull().unique(),
    userId: integer('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expiresAt').notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('Session_userId_idx').on(t.userId)],
);

export const verifications = sqliteTable(
  'Verification',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('Verification_identifier_idx').on(t.identifier)],
);

export const groups = sqliteTable('Group', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('publicId').notNull().unique(),
  name: text('name').notNull(),
  image: text('image'),
  userId: integer('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  defaultCurrency: text('defaultCurrency'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  splitwiseGroupId: text('splitwiseGroupId').unique(),
  simplifyDebts: integer('simplifyDebts', { mode: 'boolean' }).notNull().default(false),
  archivedAt: timestamp('archivedAt'),
});

export const groupDefaultSplits = sqliteTable('GroupDefaultSplit', {
  groupId: integer('groupId')
    .primaryKey()
    .references(() => groups.id, { onDelete: 'cascade' }),
  splitType: text('splitType', { enum: splitTypeValues }).notNull(),
  shares: text('shares', { mode: 'json' }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const friendDefaultSplits = sqliteTable(
  'FriendDefaultSplit',
  {
    userAId: integer('userAId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userBId: integer('userBId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    splitType: text('splitType', { enum: splitTypeValues }).notNull(),
    shares: text('shares', { mode: 'json' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userAId, t.userBId] })],
);

export const groupUsers = sqliteTable(
  'GroupUser',
  {
    groupId: integer('groupId')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: integer('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('GroupUser_userId_idx').on(t.userId),
  ],
);

/** Replaces pg_cron's `cron.job`. Executed by the scheduler Workflow. */
export const jobs = sqliteTable(
  'job',
  {
    jobid: integer('jobid').primaryKey({ autoIncrement: true }),
    schedule: text('schedule').notNull(),
    command: text('command').notNull(),
    jobname: text('jobname').notNull().unique(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    nextRunAt: timestamp('nextRunAt'),
    lastRunAt: timestamp('lastRunAt'),
  },
  (t) => [index('job_active_nextRunAt_idx').on(t.active, t.nextRunAt)],
);

export const expenseRecurrences = sqliteTable('ExpenseRecurrence', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('jobId')
    .notNull()
    .unique()
    .references(() => jobs.jobid, { onDelete: 'cascade' }),
  notified: integer('notified', { mode: 'boolean' }).notNull().default(true),
});

export const expenses = sqliteTable(
  'Expense',
  {
    id: text('id').primaryKey().$defaultFn(randomId),
    paidBy: integer('paidBy')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedBy: integer('addedBy')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category').notNull(),
    amount: bigintInt('amount').notNull(),
    splitType: text('splitType', { enum: splitTypeValues }).notNull().default('EQUAL'),
    expenseDate: timestamp('expenseDate')
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    currency: text('currency').notNull(),
    fileKey: text('fileKey'),
    groupId: integer('groupId').references(() => groups.id, { onDelete: 'cascade' }),
    deletedAt: timestamp('deletedAt'),
    deletedBy: integer('deletedBy').references(() => users.id, { onDelete: 'cascade' }),
    updatedBy: integer('updatedBy').references(() => users.id, { onDelete: 'set null' }),
    transactionId: text('transactionId'),
    recurrenceId: integer('recurrenceId').references(() => expenseRecurrences.id, {
      onDelete: 'set null',
    }),
    // oxlint-disable-next-line typescript/no-explicit-any
    conversionToId: text('conversionToId')
      .unique()
      .references((): any => expenses.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('Expense_groupId_idx').on(t.groupId),
    index('Expense_paidBy_idx').on(t.paidBy),
    index('Expense_recurrenceId_idx').on(t.recurrenceId),
  ],
);

export const expenseParticipants = sqliteTable(
  'ExpenseParticipant',
  {
    expenseId: text('expenseId')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    userId: integer('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    amount: bigintInt('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.userId] }),
    index('ExpenseParticipant_userId_idx').on(t.userId),
  ],
);

export const expenseNotes = sqliteTable('ExpenseNote', {
  id: text('id').primaryKey().$defaultFn(randomId),
  note: text('note').notNull(),
  createdById: integer('createdById')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  expenseId: text('expenseId')
    .notNull()
    .references(() => expenses.id, { onDelete: 'cascade' }),
});

export const cachedCurrencyRates = sqliteTable(
  'CachedCurrencyRate',
  {
    from: text('from').notNull(),
    to: text('to').notNull(),
    date: timestamp('date').notNull(),
    rate: real('rate').notNull(),
    lastFetched: timestamp('lastFetched').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.from, t.to, t.date] })],
);

export const cachedBankData = sqliteTable('CachedBankData', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  obapiProviderId: text('obapiProviderId').notNull().unique(),
  data: text('data').notNull(),
  userId: integer('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  lastFetched: timestamp('lastFetched').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pushNotifications = sqliteTable(
  'PushNotification',
  {
    userId: integer('userId').notNull(),
    endpoint: text('endpoint').notNull(),
    subscription: text('subscription').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.endpoint] })],
);

export const appMetadata = sqliteTable('AppMetadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Balances derived from non-deleted expenses. Defined in SQL by the migration
 * `0001_balance_view_and_triggers.sql`; `.existing()` stops drizzle-kit from managing it.
 */
export const balanceView = sqliteView('BalanceView', {
  userId: integer('userId').notNull(),
  friendId: integer('friendId').notNull(),
  groupId: integer('groupId'),
  currency: text('currency').notNull(),
  amount: bigintInt('amount').notNull(),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
}).existing();

// ---------------------------------------------------------------------------
// Relations (used by db.query.*.findMany({ with }))
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  groups: many(groups),
  associatedGroups: many(groupUsers),
  expenseParticipants: many(expenseParticipants),
  expenseNotes: many(expenseNotes),
  paidExpenses: many(expenses, { relationName: 'PaidByUser' }),
  addedExpenses: many(expenses, { relationName: 'AddedByUser' }),
  deletedExpenses: many(expenses, { relationName: 'DeletedByUser' }),
  updatedExpenses: many(expenses, { relationName: 'UpdatedByUser' }),
  cachedBankData: many(cachedBankData),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  createdBy: one(users, { fields: [groups.userId], references: [users.id] }),
  groupUsers: many(groupUsers),
  expenses: many(expenses),
  groupDefaultSplit: one(groupDefaultSplits, {
    fields: [groups.id],
    references: [groupDefaultSplits.groupId],
  }),
}));

export const groupDefaultSplitsRelations = relations(groupDefaultSplits, ({ one }) => ({
  group: one(groups, { fields: [groupDefaultSplits.groupId], references: [groups.id] }),
}));

export const friendDefaultSplitsRelations = relations(friendDefaultSplits, ({ one }) => ({
  userA: one(users, { fields: [friendDefaultSplits.userAId], references: [users.id] }),
  userB: one(users, { fields: [friendDefaultSplits.userBId], references: [users.id] }),
}));

export const groupUsersRelations = relations(groupUsers, ({ one }) => ({
  group: one(groups, { fields: [groupUsers.groupId], references: [groups.id] }),
  user: one(users, { fields: [groupUsers.userId], references: [users.id] }),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
  recurrence: one(expenseRecurrences, {
    fields: [jobs.jobid],
    references: [expenseRecurrences.jobId],
  }),
}));

export const expenseRecurrencesRelations = relations(expenseRecurrences, ({ one, many }) => ({
  job: one(jobs, { fields: [expenseRecurrences.jobId], references: [jobs.jobid] }),
  expense: many(expenses),
}));

export const expensesRelations = relations(expenses, ({ one, many }) => ({
  paidByUser: one(users, {
    fields: [expenses.paidBy],
    references: [users.id],
    relationName: 'PaidByUser',
  }),
  addedByUser: one(users, {
    fields: [expenses.addedBy],
    references: [users.id],
    relationName: 'AddedByUser',
  }),
  deletedByUser: one(users, {
    fields: [expenses.deletedBy],
    references: [users.id],
    relationName: 'DeletedByUser',
  }),
  updatedByUser: one(users, {
    fields: [expenses.updatedBy],
    references: [users.id],
    relationName: 'UpdatedByUser',
  }),
  group: one(groups, { fields: [expenses.groupId], references: [groups.id] }),
  recurrence: one(expenseRecurrences, {
    fields: [expenses.recurrenceId],
    references: [expenseRecurrences.id],
  }),
  conversionTo: one(expenses, {
    fields: [expenses.conversionToId],
    references: [expenses.id],
    relationName: 'CurrencyConversion',
  }),
  conversionFrom: many(expenses, { relationName: 'CurrencyConversion' }),
  expenseParticipants: many(expenseParticipants),
  expenseNotes: many(expenseNotes),
}));

export const expenseParticipantsRelations = relations(expenseParticipants, ({ one }) => ({
  expense: one(expenses, { fields: [expenseParticipants.expenseId], references: [expenses.id] }),
  user: one(users, { fields: [expenseParticipants.userId], references: [users.id] }),
}));

export const expenseNotesRelations = relations(expenseNotes, ({ one }) => ({
  expense: one(expenses, { fields: [expenseNotes.expenseId], references: [expenses.id] }),
  createdBy: one(users, { fields: [expenseNotes.createdById], references: [users.id] }),
}));

export const cachedBankDataRelations = relations(cachedBankData, ({ one }) => ({
  user: one(users, { fields: [cachedBankData.userId], references: [users.id] }),
}));

// ---------------------------------------------------------------------------
// Row types (replacements for the former @prisma/client model types)
// ---------------------------------------------------------------------------

export type User = Omit<typeof users.$inferSelect, 'createdAt' | 'updatedAt'>;
export type Group = typeof groups.$inferSelect;
export type GroupUser = typeof groupUsers.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type ExpenseParticipant = typeof expenseParticipants.$inferSelect;
export type ExpenseNote = typeof expenseNotes.$inferSelect;
export type ExpenseRecurrence = typeof expenseRecurrences.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type BalanceView = typeof balanceView.$inferSelect;
export type Account = typeof accounts.$inferSelect;
