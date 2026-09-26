import { NotificationType } from '@prisma/client';

/** Notification module response shapes. */

export interface NotificationResponse {
  id: number;
  /** Order this notification refers to; null for non-order notifications. */
  orderId: number | null;
  type: NotificationType;
  message: string;
  isRead: boolean;
  createdAt: Date;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedNotifications {
  data: NotificationResponse[];
  pagination: PaginationMeta;
}

/** Validated query string for GET /api/notifications. */
export interface ListNotificationsParams {
  page: number;
  limit: number;
}
