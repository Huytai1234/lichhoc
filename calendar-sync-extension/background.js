// background.js - Main Service Worker (Modularized - Injects defined locally)
'use strict';

// --- Imports ---
import * as constants from './constants.js';
import { logger } from './logger.js';
import { showNotification } from './notification.js';
import { executeScriptOnTab } from './script-injection.js';
import { forceGoogleLoginAndGetToken } from './google-auth.js';
import * as syncLogic from './sync-logic.js';
// Content inject functions are defined below

// --- Initialization ---
try {
    logger.debug("BG INIT: Reading manifest...");
    const manifest = chrome.runtime.getManifest();
    const clientId = manifest?.oauth2?.client_id;
    const scopes = manifest?.oauth2?.scopes?.join(' ');
    if (!clientId || !scopes || clientId.includes("YOUR_")) {
        throw new Error("Client ID/Scopes missing or invalid in manifest.json");
    }
    constants.setGoogleCredentials(clientId, scopes);
    logger.info("[BACKGROUND INIT] Loaded Client ID:", constants.GOOGLE_CLIENT_ID);
} catch (e) {
    logger.error("BG ERROR: Init manifest reading failed.", e);
    showNotification("Lỗi Cấu Hình Nghiêm Trọng", `Không thể tải cấu hình Client ID/Scopes: ${e.message}`, 'basic', 'init-fail');
}

// ==========================================================================
// Functions DEFINED here to be Injected into MyUEL Page
// These need to be in the global scope of this service worker file so that
// sync-logic.js can reference them via 'self.functionName' when calling
// executeScriptOnTabRef.
// ==========================================================================

/** Injected function to get week options from the dropdown. */
function getContent_getWeekOptions(dropdownId) {
    // Using constants directly here might fail inside injection,
    // better to pass them or use literal values if they won't change.
    // But for simplicity for now, we assume this works or is adjusted.
    console.log('[CS getContent_getWeekOptions] Running...');
    const weekDropdown = document.getElementById(dropdownId); // dropdownId is passed as arg
    if (!weekDropdown) {
        console.error(`[CS] Dropdown ID '${dropdownId}' not found!`);
        return { error: `Dropdown ID '${dropdownId}' không tìm thấy!` };
    }
    const options = [];
    for (let i = 0; i < weekDropdown.options.length; i++) {
        const option = weekDropdown.options[i];
        // Standard filtering logic
        if (option.value && option.value !== "-1" && option.value !== "" && option.value !== "0") {
            options.push({ value: option.value, text: option.text });
        }
    }
    console.log(`[CS] Found ${options.length} valid week options.`);
    return options;
}

/**
 * Injected function to select a week, wait via MutationObserver, and return data.
 */
async function getContent_selectWeekAndGetData(dropdownId, weekValue, tableId, dateId) {
    const uniqueLogPrefix = `[CS MO ${Date.now().toString().slice(-5)}]`;
    console.log(`${uniqueLogPrefix} Selecting week value: ${weekValue}`);
    const weekDropdown = document.getElementById(dropdownId); // Args passed correctly
    const initialDateSpan = document.getElementById(dateId); // Args passed correctly
    if (!weekDropdown) return { error: `[CS MO] Dropdown not found: ${dropdownId}` };
    if (!initialDateSpan) return { error: `[CS MO] Initial date span not found: ${dateId}` };

    const oldDateText = initialDateSpan.innerText.trim();
    console.log(`${uniqueLogPrefix} Old date text: "${oldDateText}"`);

    // Use literal ID or pass it if necessary, constants aren't available in injection scope easily
    const centerPanelId = "pnCenter";
    let nodeToObserve = document.getElementById(centerPanelId);
    if (!nodeToObserve) {
        console.error(`${uniqueLogPrefix} Cannot find #${centerPanelId}. Falling back to body.`);
        nodeToObserve = document.body;
        if (!nodeToObserve) return { error: `[CS MO] Cannot find #${centerPanelId} or body.` };
    }
    console.log(`${uniqueLogPrefix} Observing node: ${nodeToObserve.tagName}${nodeToObserve.id ? '#' + nodeToObserve.id : ''}`);

    return new Promise((resolve, reject) => {
        let observer = null;
        let timeoutId = null;
        const TIMEOUT_MS = 18000; // Use literal or pass as argument

        const cleanup = (reason) => {
            if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        };

        const mutationCallback = (mutationsList, obs) => {
            const currentDateSpan = document.getElementById(dateId);
            if (!currentDateSpan) { console.warn(`${uniqueLogPrefix} Date span disappeared.`); return; }
            const newDateText = currentDateSpan.innerText.trim();
            if (newDateText && newDateText !== oldDateText) {
                console.log(`${uniqueLogPrefix} Date change detected via observer: "${newDateText}"`);
                cleanup("Date changed (Observer)");
                setTimeout(() => { // Stabilization delay
                    const finalTable = document.getElementById(tableId); // Use passed tableId
                    const finalDateSpan = document.getElementById(dateId);
                    if (!finalTable || !finalDateSpan) {
                        const missing = [!finalTable&&`Table#${tableId}`, !finalDateSpan&&`DateSpan#${dateId}`].filter(Boolean).join(', ');
                        reject({ error: `[CS MO] Elements lost (${missing}).` }); return;
                    }
                    const finalTimetableHtml = finalTable.outerHTML;
                    const finalDateRangeText = finalDateSpan.innerText.trim();
                    if (!finalTimetableHtml || !finalDateRangeText) {
                        const missingData = [!finalTimetableHtml && "HTML", !finalDateRangeText && "Date"].filter(Boolean).join('/');
                        reject({ error: `[CS MO] Failed get final ${missingData}.` }); return;
                    }
                    console.log(`${uniqueLogPrefix} Final extraction OK (via Observer).`);
                    resolve({ timetableHtml: finalTimetableHtml, dateRangeText: finalDateRangeText });
                }, 150);
            }
        };

        try { observer = new MutationObserver(mutationCallback); }
        catch (error) { reject({ error: `[CS MO] Create Observer fail: ${error.message}` }); return; }

        const observerConfig = { childList: true, subtree: true };
        try { observer.observe(nodeToObserve, observerConfig); console.log(`${uniqueLogPrefix} Observer started.`); }
        catch (error) { cleanup("Observe Start Fail"); reject({ error: `[CS MO] Observer start fail: ${error.message}` }); return; }

        timeoutId = setTimeout(() => {
            console.warn(`${uniqueLogPrefix} Timeout (${TIMEOUT_MS}ms) week ${weekValue}.`);
            cleanup("Timeout (Observer)");
            const lastDateSpan = document.getElementById(dateId);
            const lastTable = document.getElementById(tableId);
            if (lastDateSpan && lastTable) {
                const lastDateText = lastDateSpan.innerText.trim();
                if (lastDateText && lastDateText !== oldDateText) {
                    console.log(`${uniqueLogPrefix} [Timeout Check] Change detected!`);
                    resolve({ timetableHtml: lastTable.outerHTML, dateRangeText: lastDateText }); return;
                }
            }
            reject({ error: `[CS MO] Timeout (${TIMEOUT_MS / 1000}s) week ${weekValue}. Observer failed.` });
        }, TIMEOUT_MS);

        console.log(`${uniqueLogPrefix} Dispatching 'change' event week ${weekValue}...`);
        try {
            weekDropdown.value = weekValue;
            weekDropdown.dispatchEvent(new Event('change', { bubbles: true }));
            console.log(`${uniqueLogPrefix} 'change' dispatched. Waiting...`);
        } catch (error) {
            cleanup("Dispatch Error");
            reject({ error: `[CS MO] Dispatch event fail: ${error.message}` });
        }
    }); // End Promise
}


// --- Inject Dependencies into Sync Logic Module ---
// Pass references to the functions defined ABOVE
syncLogic.initializeSyncLogic({
    showNotificationRef: showNotification,
    executeScriptOnTabRef: executeScriptOnTab,
    getContent_getWeekOptionsRef: getContent_getWeekOptions,       // Pass the actual function defined above
    getContent_selectWeekAndGetDataRef: getContent_selectWeekAndGetData // Pass the actual function defined above
});


// ==========================================================================
// Event Listeners
// ==========================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen') return false; // Not for us

    logger.info(`BG Listener: Received action='${message.action}'`);

    switch (message.action) {
        case "startSync": {
            logger.debug('[Msg Listener] Dispatching to syncLogic.handleSingleWeekSync');
            const { userId, tabId } = message;
            if (!userId || !tabId) {
                logger.error('[Msg Listener] Missing args for startSync.');
                if (sendResponse) try { sendResponse({ status: "error", message: "Thiếu User ID/Tab ID." }); } catch (e) {}
                return false; // Don't keep message channel open
            }
            syncLogic.handleSingleWeekSync(userId, tabId, sendResponse);
            return true; // YES, keep message channel open for async response
        }
        case "startSemesterSync": {
            logger.debug('[Msg Listener] Dispatching to syncLogic.handleSemesterSync');
            const { userId } = message;
            if (!userId) {
                logger.error('[Msg Listener] Missing userId for startSemesterSync.');
                if (sendResponse) try { sendResponse({ status: "error", message: "Thiếu User ID." }); } catch (e) {}
                return false; // Don't keep message channel open
            }
            syncLogic.handleSemesterSync(userId, sendResponse);
            return true; // YES, keep message channel open for async response
        }
        default:
            logger.warn("BG Listener: Received unknown action:", message.action);
            return false; // No handler for this action
    }
});

// ==========================================================================
// Service Worker Initialization Log
// ==========================================================================

logger.info("Background service worker started (Modularized - Injects defined locally).");
logger.info("Features: MutationObserver Wait, Batch API Additions");