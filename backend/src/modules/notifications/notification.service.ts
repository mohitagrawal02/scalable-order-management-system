import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

/**
 * Notification service.
 *
 * Two distinct kinds of operations:
 *
 * 1. `create*` - called from INSIDE a caller's transaction (the payment
 *    service passes its `tx` client) so the notification commits atomically
 *    with the payment/order state it describes. A notification can therefore
 *    never exist for a payment that rolled back, or vice versa.
 *
 * 2. `list*` - read path; the userId always comes from the JWT identity via
 *    the controller, never from the request.
 */

type Db = Prisma.TransactionClient;

const notificationInclude = {
  order: { select: { id: true, orderNumber: true, status: true } },
} as const;

function toNotificationResponse(row: {
  id: number;
  type: string;
  message: string;
  /** Prisma column is `isRead`; the API shape exposes it as `read`. */
  isRead: boolean;
  createdAt: Date;
  orderId: number | null;
  order: { id: number; orderNumber: string; status: string } | null;
}) {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    read: row.isRead,
    createdAt: row.createdAt,
    order:
      row.order === null
        ? null
        : {
            id: row.order.id,
            orderNumber: row.order.orderNumber,
            status: row.order.status,
          },
  };
}

export type NotificationResponse = ReturnType<typeof toNotificationResponse>;

/** Records a payment-succeeded notification (inside a transaction). */
export async function createPaymentSucceededNotification(
  db: Db,
  input: { userId: number; orderId: number; orderNumber: string }
): Promise<void> {
  await db.notification.create({
    data: {
      userId: input.userId,
      orderId: input.orderId,
      type: 'PAYMENT_SUCCEEDED',
      message: `Payment received for order ${input.orderNumber}.`,
    },
  });
}

/** Records a payment-failed notification (inside a transaction). */
export async function createPaymentFailedNotification(
  db: Db,
  input: { userId: number; orderId: number; orderNumber: string; reason: string }
): Promise<void> {
  await db.notification.create({
    data: {
      userId: input.userId,
      orderId: input.orderId,
      type: 'PAYMENT_FAILED',
      message: `Payment failed for order ${input.orderNumber}: ${input.reason}`,
    },
  });
}

/**
 * GET /api/notifications - newest first for the authenticated user only.
 * Offset pagination matches the products endpoint conventions.
 */
export async function listNotifications(
  userId: number,
  page: number,
  limit: number
): Promise<{
  data: NotificationResponse[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: notificationInclude,
    }),
    prisma.notification.count({ where: { userId } }),
  ]);

  return {
    data: rows.map(toNotificationResponse),
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
}