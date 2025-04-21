// notification.js
'use strict';

import { logger } from './logger.js';
import { NOTIFICATION_ICON_URL } from './constants.js';

/** Shows a Chrome notification. */
export function showNotification(title, message, type = 'basic', idSuffix = Date.now().toString()) {
    const notificationId = `uel-sync-notif-${idSuffix}`;
    logger.debug(`BG Notif [${idSuffix}]: Showing: Title='${title}', Msg='${message.substring(0, 100)}...'`);

    chrome.notifications.create(notificationId, {
        type: type,
        iconUrl: NOTIFICATION_ICON_URL,
        title: title,
        message: message,
        priority: 1
    }, (createdId) => {
        if (chrome.runtime.lastError) {
            logger.error(`BG Notif [${idSuffix}]: Create Error:`, chrome.runtime.lastError?.message);
        }
    });
}