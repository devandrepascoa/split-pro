-- Port of the Postgres BalanceView. Balances are derived from non-deleted expenses.
-- Each pair of users appears twice: once from each user's perspective.
CREATE VIEW `BalanceView` AS
WITH `BaseBalance` AS (
    SELECT
        CASE WHEN ep.`userId` < e.`paidBy` THEN ep.`userId` ELSE e.`paidBy` END AS `user_id_A`,
        CASE WHEN ep.`userId` < e.`paidBy` THEN e.`paidBy` ELSE ep.`userId` END AS `user_id_B`,
        e.`groupId` AS `groupId`,
        e.`currency` AS `currency`,
        SUM(ep.`amount` * (CASE WHEN ep.`userId` < e.`paidBy` THEN 1 ELSE -1 END)) AS `net_amount`,
        MIN(e.`createdAt`) AS `createdAt`,
        MAX(e.`updatedAt`) AS `updatedAt`
    FROM `ExpenseParticipant` AS ep
    JOIN `Expense` AS e ON ep.`expenseId` = e.`id`
    WHERE ep.`userId` != e.`paidBy`
      AND e.`deletedAt` IS NULL
    GROUP BY `user_id_A`, `user_id_B`, e.`groupId`, e.`currency`
)
SELECT `user_id_A` AS `userId`, `user_id_B` AS `friendId`, `groupId`, `currency`,
       `net_amount` AS `amount`, `createdAt`, `updatedAt`
FROM `BaseBalance`
UNION ALL
SELECT `user_id_B` AS `userId`, `user_id_A` AS `friendId`, `groupId`, `currency`,
       -`net_amount` AS `amount`, `createdAt`, `updatedAt`
FROM `BaseBalance`;
--> statement-breakpoint
-- Port of the plpgsql trigger auto_unhide_friend: a new expense between two users removes
-- each user from the other's hiddenFriendIds (a JSON array of user ids).
CREATE TRIGGER `trigger_auto_unhide_friend`
AFTER INSERT ON `ExpenseParticipant`
FOR EACH ROW
BEGIN
    UPDATE `User`
    SET `hiddenFriendIds` = (
        SELECT COALESCE(json_group_array(j.value), '[]')
        FROM json_each(`User`.`hiddenFriendIds`) AS j
        WHERE j.value != (SELECT `paidBy` FROM `Expense` WHERE `id` = NEW.`expenseId`)
    )
    WHERE `id` = NEW.`userId`
      AND EXISTS (
        SELECT 1 FROM json_each(`User`.`hiddenFriendIds`) AS j
        WHERE j.value = (SELECT `paidBy` FROM `Expense` WHERE `id` = NEW.`expenseId`)
      );

    UPDATE `User`
    SET `hiddenFriendIds` = (
        SELECT COALESCE(json_group_array(j.value), '[]')
        FROM json_each(`User`.`hiddenFriendIds`) AS j
        WHERE j.value != NEW.`userId`
    )
    WHERE `id` = (SELECT `paidBy` FROM `Expense` WHERE `id` = NEW.`expenseId`)
      AND EXISTS (
        SELECT 1 FROM json_each(`User`.`hiddenFriendIds`) AS j
        WHERE j.value = NEW.`userId`
      );
END;
