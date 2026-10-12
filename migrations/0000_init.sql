CREATE TABLE `Account` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Account_providerId_accountId_key` ON `Account` (`providerId`,`accountId`);--> statement-breakpoint
CREATE INDEX `Account_userId_idx` ON `Account` (`userId`);--> statement-breakpoint
CREATE TABLE `AppMetadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `CachedBankData` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`obapiProviderId` text NOT NULL,
	`data` text NOT NULL,
	`userId` integer NOT NULL,
	`lastFetched` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `CachedBankData_obapiProviderId_unique` ON `CachedBankData` (`obapiProviderId`);--> statement-breakpoint
CREATE TABLE `CachedCurrencyRate` (
	`from` text NOT NULL,
	`to` text NOT NULL,
	`date` integer NOT NULL,
	`rate` real NOT NULL,
	`lastFetched` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`from`, `to`, `date`)
);
--> statement-breakpoint
CREATE TABLE `ExpenseNote` (
	`id` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`createdById` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`expenseId` text NOT NULL,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`expenseId`) REFERENCES `Expense`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ExpenseParticipant` (
	`expenseId` text NOT NULL,
	`userId` integer NOT NULL,
	`amount` integer NOT NULL,
	PRIMARY KEY(`expenseId`, `userId`),
	FOREIGN KEY (`expenseId`) REFERENCES `Expense`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ExpenseParticipant_userId_idx` ON `ExpenseParticipant` (`userId`);--> statement-breakpoint
CREATE TABLE `ExpenseRecurrence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jobId` integer NOT NULL,
	`notified` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`jobId`) REFERENCES `job`(`jobid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ExpenseRecurrence_jobId_unique` ON `ExpenseRecurrence` (`jobId`);--> statement-breakpoint
CREATE TABLE `Expense` (
	`id` text PRIMARY KEY NOT NULL,
	`paidBy` integer NOT NULL,
	`addedBy` integer NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`splitType` text DEFAULT 'EQUAL' NOT NULL,
	`expenseDate` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`currency` text NOT NULL,
	`fileKey` text,
	`groupId` integer,
	`deletedAt` integer,
	`deletedBy` integer,
	`updatedBy` integer,
	`transactionId` text,
	`recurrenceId` integer,
	`conversionToId` text,
	FOREIGN KEY (`paidBy`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`addedBy`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`groupId`) REFERENCES `Group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deletedBy`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updatedBy`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recurrenceId`) REFERENCES `ExpenseRecurrence`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversionToId`) REFERENCES `Expense`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Expense_conversionToId_unique` ON `Expense` (`conversionToId`);--> statement-breakpoint
CREATE INDEX `Expense_groupId_idx` ON `Expense` (`groupId`);--> statement-breakpoint
CREATE INDEX `Expense_paidBy_idx` ON `Expense` (`paidBy`);--> statement-breakpoint
CREATE INDEX `Expense_recurrenceId_idx` ON `Expense` (`recurrenceId`);--> statement-breakpoint
CREATE TABLE `FriendDefaultSplit` (
	`userAId` integer NOT NULL,
	`userBId` integer NOT NULL,
	`splitType` text NOT NULL,
	`shares` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userAId`, `userBId`),
	FOREIGN KEY (`userAId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userBId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `GroupDefaultSplit` (
	`groupId` integer PRIMARY KEY NOT NULL,
	`splitType` text NOT NULL,
	`shares` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`groupId`) REFERENCES `Group`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `GroupUser` (
	`groupId` integer NOT NULL,
	`userId` integer NOT NULL,
	PRIMARY KEY(`groupId`, `userId`),
	FOREIGN KEY (`groupId`) REFERENCES `Group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `GroupUser_userId_idx` ON `GroupUser` (`userId`);--> statement-breakpoint
CREATE TABLE `Group` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`publicId` text NOT NULL,
	`name` text NOT NULL,
	`image` text,
	`userId` integer NOT NULL,
	`defaultCurrency` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`splitwiseGroupId` text,
	`simplifyDebts` integer DEFAULT false NOT NULL,
	`archivedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Group_publicId_unique` ON `Group` (`publicId`);--> statement-breakpoint
CREATE UNIQUE INDEX `Group_splitwiseGroupId_unique` ON `Group` (`splitwiseGroupId`);--> statement-breakpoint
CREATE TABLE `job` (
	`jobid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`schedule` text NOT NULL,
	`command` text NOT NULL,
	`jobname` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`nextRunAt` integer,
	`lastRunAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_jobname_unique` ON `job` (`jobname`);--> statement-breakpoint
CREATE INDEX `job_active_nextRunAt_idx` ON `job` (`active`,`nextRunAt`);--> statement-breakpoint
CREATE TABLE `PushNotification` (
	`userId` integer NOT NULL,
	`endpoint` text NOT NULL,
	`subscription` text NOT NULL,
	PRIMARY KEY(`userId`, `endpoint`)
);
--> statement-breakpoint
CREATE TABLE `Session` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`userId` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `Session_token_unique` ON `Session` (`token`);--> statement-breakpoint
CREATE INDEX `Session_userId_idx` ON `Session` (`userId`);--> statement-breakpoint
CREATE TABLE `User` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`email` text,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`defaultCurrency` text,
	`preferredLanguage` text DEFAULT '' NOT NULL,
	`bankingId` text,
	`obapiProviderId` text,
	`hiddenFriendIds` text DEFAULT '[]' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `User_email_unique` ON `User` (`email`);--> statement-breakpoint
CREATE TABLE `Verification` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `Verification_identifier_idx` ON `Verification` (`identifier`);