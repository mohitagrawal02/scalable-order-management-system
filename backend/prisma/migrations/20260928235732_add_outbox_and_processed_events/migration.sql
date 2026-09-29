-- CreateTable
CREATE TABLE `outbox_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `event_id` VARCHAR(36) NOT NULL,
    `topic` VARCHAR(120) NOT NULL,
    `event_type` VARCHAR(80) NOT NULL,
    `aggregate_type` VARCHAR(40) NOT NULL,
    `aggregate_id` VARCHAR(64) NOT NULL,
    `partition_key` VARCHAR(64) NOT NULL,
    `envelope` JSON NOT NULL,
    `status` ENUM('PENDING', 'PUBLISHED', 'DEAD') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(500) NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `outbox_events_event_id_key`(`event_id`),
    INDEX `idx_outbox_status_id`(`status`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `processed_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `consumer_group` VARCHAR(80) NOT NULL,
    `event_id` VARCHAR(36) NOT NULL,
    `event_type` VARCHAR(80) NOT NULL,
    `processed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_processed_events_processed_at`(`processed_at`),
    UNIQUE INDEX `uq_processed_events_group_event`(`consumer_group`, `event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
