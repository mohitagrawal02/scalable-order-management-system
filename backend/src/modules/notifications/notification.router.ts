import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { listNotificationsHandler } from './notification.controller';

/** Notification routes. Everything here requires a valid JWT. */
export const notificationRouter: Router = Router();

notificationRouter.get('/', requireAuth, listNotificationsHandler);