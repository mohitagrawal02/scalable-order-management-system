-- AlterTable
ALTER TABLE `payments` ADD COLUMN `attempt_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `failure_reason` VARCHAR(255) NULL,
    ADD COLUMN `idempotency_key` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `payments_idempotency_key_key` ON `payments`(`idempotency_key`);
