// background.js - Main Service Worker (Modularized)
'use strict';

// --- Imports ---
import * as constants from './constants.js';
import { logger } from './logger.js';
import { showNotification } from './notification.js'; // Assuming notification moved
import { executeScriptOnTab } from './script-injection.js'; // Assuming injection moved
import { forceGoogleLoginAndGetToken } from './google-auth.js';
import * as syncLogic from './sync-logic.js';
import * as contentInjects from './content-injects.js'; // Import functions to be injected

// --- Initialization ---

// Load Manifest Config and Set Globals in constants.js
try {
    logger.debug("BG INIT: Reading manifest...");
    const manifest = chrome.runtime.getManifest();
    const clientId = manifest?.oauth2?.client_id;
    const scopes = manifest?.oauth2?.scopes?.join(' ');
    logger.debug("BG INIT: ClientID from manifest:", clientId);
    logger.debug("BG INIT: Scopes from manifest:", scopes);
    if (!clientId || !scopes || clientId.includes("YOUR_")) {
        throw new Error("Client ID/Scopes chưa cấu hình đúng trong manifest.json");
    }
    // Set the imported globals
    constants.setGoogleCredentials(clientId, scopes);
    logger.info("[BACKGROUND INIT] Loaded Client ID:", constants.GOOGLE_CLIENT_ID);
} catch (e) {
    logger.error("BG ERROR: Init manifest reading failed.", e);
    // Optional: Show a notification about the fatal configuration error
    showNotification("Lỗi Cấu Hình Nghiêm Trọng", `Không thể tải cấu hình Client ID/Scopes: ${e.message}`, 'basic', 'init-fail');
}

// --- Inject Dependencies into Modules ---
// Pass function references needed by other modules
syncLogic.initializeSyncLogic({
     showNotificationRef: showNotification, // Pass the function itself
     executeScriptOnTabRef: executeScriptOnTab, // Pass the function itself
     getContent_getWeekOptionsRef: contentInjects.getContent_getWeekOptions, // Pass imported ref
     getContent_selectWeekAndGetDataRef: contentInjects.getContent_selectWeekAndGetData // Pass imported ref
});
// Note: google-auth.js also needs showNotification, passed as arg when called

// ==========================================================================
// Core Background Functions (Kept here or move to own modules if preferred)
// ==========================================================================

/** Shows a Chrome notification. (Moved to notification.js) */
// function showNotification(...) { ... } // Code removed, imported instead

/** Executes a script (function or file) on a specific tab. (Moved to script-injection.js)*/
// async function executeScriptOnTab(...) { ... } // Code removed, imported instead


// ==========================================================================
// Event Listeners
// ==========================================================================

/** Main listener for messages from popup or other parts of the extension. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen') return false; // Ignore offscreen messages

    logger.info(`BG Listener: Received action='${message.action}' from sender=`, sender?.tab?.id || sender?.id);

    switch (message.action) {
        case "startSync": {
            logger.debug('[Msg Listener] Dispatching to syncLogic.handleSingleWeekSync');
            const { userId, tabId } = message;
            if (!userId || !tabId) {
                logger.error('[Msg Listener] Missing userId or tabId for startSync.');
                if (typeof sendResponse === 'function') try { sendResponse({ status: "error", message: "Thiếu User ID hoặc Tab ID." }); } catch (e) {}
                return false;
            }
            // Call the imported function from sync-logic
            syncLogic.handleSingleWeekSync(userId, tabId, sendResponse);
            return true; // Indicate async response
        }
        case "startSemesterSync": {
            logger.debug('[Msg Listener] Dispatching to syncLogic.handleSemesterSync');
            const { userId } = message;
            if (!userId) {
                logger.error('[Msg Listener] Missing userId for startSemesterSync.');
                if (typeof sendResponse === 'function') try { sendResponse({ status: "error", message: "Thiếu User ID." }); } catch (e) {}
                return false;
            }
             // Call the imported function from sync-logic
            syncLogic.handleSemesterSync(userId, sendResponse);
            return true; // Indicate async response
        }
        default:
            logger.warn("BG Listener: Received unknown action:", message.action);
            return false;
    }
});

// ==========================================================================
// Service Worker Initialization Log
// ==========================================================================

logger.info("Background service worker started and modules imported.");
logger.info("Features: Modularized, MutationObserver Wait, Batch API Additions");