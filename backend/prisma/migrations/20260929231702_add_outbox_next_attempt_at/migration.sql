-- AlterTable
ALTER TABLE `outbox_events` ADD COLUMN `next_attempt_at` DATETIME(3) NULL;
