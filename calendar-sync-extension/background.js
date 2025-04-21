// background.js - Main Service Worker (Modularized - Concurrency Lock Added)
'use strict';

// --- Imports ---
import * as constants from './constants.js';
import { logger } from './logger.js';
import { showNotification } from './notification.js';
import { executeScriptOnTab } from './script-injection.js';
import { forceGoogleLoginAndGetToken } from './google-auth.js';
// Import the entire syncLogic module to access its exported functions
import * as syncLogic from './sync-logic.js';
// <<<<< ADDED: Import specific getter for sync state >>>>>
import { getIsSyncInProgress } from './sync-logic.js';

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
    showNotification("Critical Configuration Error", `Could not load Client ID/Scopes: ${e.message}`, 'basic', 'init-fail');
}

// ==========================================================================
// Functions DEFINED here to be Injected into MyUEL Page
// These need to be defined in this file so syncLogic can access them via refs.
// They are executed in the MAIN world of the target page.
// ==========================================================================

/** Injected function to get week options from the dropdown. */
function getContent_getWeekOptions(dropdownId) {
    // Note: console.log inside injected scripts appears in the *page's* console, not the background console.
    console.log('[UEL Sync Injected] Getting week options...');
    const weekDropdown = document.getElementById(dropdownId); // dropdownId is passed as arg
    if (!weekDropdown) {
        console.error(`[UEL Sync Injected] Dropdown ID '${dropdownId}' not found!`);
        // Return an error object which background script can check
        return { error: `Dropdown element with ID '${dropdownId}' not found on page.` };
    }
    const options = [];
    for (let i = 0; i < weekDropdown.options.length; i++) {
        const option = weekDropdown.options[i];
        // Standard filtering logic for valid week options
        if (option.value && option.value !== "-1" && option.value !== "" && option.value !== "0") {
            options.push({ value: option.value, text: option.text });
        }
    }
    console.log(`[UEL Sync Injected] Found ${options.length} valid week options.`);
    return options; // Return the array of valid options
}

/**
 * Injected function to select a week, wait for page update using MutationObserver,
 * and then return the timetable HTML and date range text.
 */
async function getContent_selectWeekAndGetData(dropdownId, weekValue, tableId, dateId) {
    // Unique prefix for console logs from this specific injection instance
    const uniqueLogPrefix = `[UEL Sync Injected MO ${Date.now().toString().slice(-5)}]`;
    console.log(`${uniqueLogPrefix} Selecting week value: ${weekValue}`);
    const weekDropdown = document.getElementById(dropdownId); // Args passed correctly
    const initialDateSpan = document.getElementById(dateId); // Args passed correctly
    if (!weekDropdown) return { error: `[UEL Sync MO] Dropdown not found: ${dropdownId}` };
    if (!initialDateSpan) return { error: `[UEL Sync MO] Initial date span not found: ${dateId}` };

    const oldDateText = initialDateSpan.innerText.trim(); // Get current date text to detect change
    console.log(`${uniqueLogPrefix} Old date text: "${oldDateText}"`);

    // Identify the element whose children will be observed for changes
    // Usually a container around the timetable/date elements is best
    const centerPanelId = "pnCenter"; // Assuming this is a stable ID containing the updated content
    let nodeToObserve = document.getElementById(centerPanelId);
    if (!nodeToObserve) {
        // Fallback if the specific container isn't found
        console.error(`${uniqueLogPrefix} Cannot find #${centerPanelId}. Falling back to observing document body.`);
        nodeToObserve = document.body;
        if (!nodeToObserve) return { error: `[UEL Sync MO] Cannot find #${centerPanelId} or document body to observe.` };
    }
    console.log(`${uniqueLogPrefix} Observing node: ${nodeToObserve.tagName}${nodeToObserve.id ? '#' + nodeToObserve.id : ''}`);

    // Use a Promise to handle the asynchronous nature of MutationObserver
    return new Promise((resolve, reject) => {
        let observer = null;
        let timeoutId = null;
        const TIMEOUT_MS = constants.MUTATION_OBSERVER_TIMEOUT_MS; // Use constant from background

        // Cleanup function to disconnect observer and clear timeout
        const cleanup = (reason) => {
            if (observer) { try { observer.disconnect(); } catch (e) { /* Ignore */ } observer = null; }
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
             console.log(`${uniqueLogPrefix} Observer cleanup (${reason}).`);
        };

        // Callback function for the MutationObserver
        const mutationCallback = (mutationsList, obs) => {
             // Check if the date span text has changed, indicating the page updated
             const currentDateSpan = document.getElementById(dateId);
             // Handle case where span might disappear during update
             if (!currentDateSpan) { console.warn(`${uniqueLogPrefix} Date span disappeared during observation.`); return; }
             const newDateText = currentDateSpan.innerText.trim();

             // If new date text is different from old, assume update is complete
             if (newDateText && newDateText !== oldDateText) {
                 console.log(`${uniqueLogPrefix} Date change detected via observer: "${newDateText}"`);
                 cleanup("Date changed (Observer)");

                 // Short delay for stability before grabbing final data
                 setTimeout(() => {
                     const finalTable = document.getElementById(tableId); // Use passed tableId
                     const finalDateSpanAfterWait = document.getElementById(dateId);
                     // Final check for elements before resolving
                     if (!finalTable || !finalDateSpanAfterWait) {
                         const missing = [!finalTable&&`Table#${tableId}`, !finalDateSpanAfterWait&&`DateSpan#${dateId}`].filter(Boolean).join(', ');
                         reject({ error: `[UEL Sync MO] Elements lost after wait (${missing}).` });
                         return;
                     }
                     // Get the final HTML and text
                     const finalTimetableHtml = finalTable.outerHTML;
                     const finalDateRangeText = finalDateSpanAfterWait.innerText.trim();
                     // Ensure data was actually retrieved
                     if (!finalTimetableHtml || !finalDateRangeText) {
                         const missingData = [!finalTimetableHtml && "HTML", !finalDateRangeText && "Date"].filter(Boolean).join('/');
                         reject({ error: `[UEL Sync MO] Failed get final ${missingData} after mutation detected.` });
                         return;
                     }
                     console.log(`${uniqueLogPrefix} Final data extraction successful (via Observer).`);
                     // Resolve the promise with the extracted data
                     resolve({ timetableHtml: finalTimetableHtml, dateRangeText: finalDateRangeText });
                 }, 150); // Small stabilization delay
             }
         };

        // Create the observer instance
        try { observer = new MutationObserver(mutationCallback); }
        catch (error) { reject({ error: `[UEL Sync MO] Failed to create MutationObserver: ${error.message}` }); return; }

        // Configuration for the observer (watch for changes in the node's children list and subtree)
        const observerConfig = { childList: true, subtree: true };

        // Start observing
        try {
            observer.observe(nodeToObserve, observerConfig);
            console.log(`${uniqueLogPrefix} MutationObserver started.`);
        } catch (error) {
            cleanup("Observe Start Fail");
            reject({ error: `[UEL Sync MO] Failed to start MutationObserver: ${error.message}` });
            return;
        }

        // Set a timeout to prevent waiting indefinitely if no mutation occurs
        timeoutId = setTimeout(() => {
            console.warn(`${uniqueLogPrefix} MutationObserver timed out (${TIMEOUT_MS}ms) for week value ${weekValue}.`);
            cleanup("Timeout (Observer)");
            // As a last resort, check the date *after* timeout
             const lastDateSpan = document.getElementById(dateId);
             const lastTable = document.getElementById(tableId);
             if (lastDateSpan && lastTable) {
                 const lastDateText = lastDateSpan.innerText.trim();
                 // If date changed *sometime* before timeout finished, try to resolve
                 if (lastDateText && lastDateText !== oldDateText) {
                     console.log(`${uniqueLogPrefix} [Timeout Check] Date change was detected before timeout finished! Resolving.`);
                     resolve({ timetableHtml: lastTable.outerHTML, dateRangeText: lastDateText });
                     return;
                 }
             }
            // If no change detected even after timeout, reject
            reject({ error: `[UEL Sync MO] Timeout (${TIMEOUT_MS / 1000}s) waiting for page update for week ${weekValue}. MutationObserver failed.` });
        }, TIMEOUT_MS);

        // Trigger the change on the dropdown *after* the observer is set up
        console.log(`${uniqueLogPrefix} Dispatching 'change' event for week ${weekValue}...`);
        try {
            weekDropdown.value = weekValue; // Set the value
            // Dispatch a 'change' event that the page's JavaScript likely listens for
            weekDropdown.dispatchEvent(new Event('change', { bubbles: true }));
            console.log(`${uniqueLogPrefix} 'change' event dispatched. Observer is waiting...`);
        } catch (error) {
            cleanup("Dispatch Error");
            reject({ error: `[UEL Sync MO] Failed to dispatch change event: ${error.message}` });
        }
    }); // End Promise
}


// --- Inject Dependencies into Sync Logic Module ---
// Pass references to the functions needed by syncLogic
syncLogic.initializeSyncLogic({
    showNotificationRef: showNotification,
    executeScriptOnTabRef: executeScriptOnTab,
    getContent_getWeekOptionsRef: getContent_getWeekOptions,       // Pass the actual function defined above
    getContent_selectWeekAndGetDataRef: getContent_selectWeekAndGetData // Pass the actual function defined above
});


// ==========================================================================
// Event Listeners
// ==========================================================================

// Listener for messages from other parts of the extension (e.g., popup)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Ignore messages intended for the offscreen document
    if (message.target === 'offscreen') return false; // Indicates not handled here

    logger.info(`BG Listener: Received action='${message.action}'`);

    switch (message.action) {
        case "startSync": {
            logger.debug('[Msg Listener] Dispatching to syncLogic.handleSingleWeekSync');
            const { userId, tabId } = message;
            // Basic validation
            if (!userId || !tabId) {
                logger.error('[Msg Listener] Missing args for startSync.');
                // Send error response immediately if possible
                if (sendResponse) try { sendResponse({ status: "error", message: "Missing User ID or Tab ID." }); } catch (e) {/*ignore*/}
                return false; // Don't keep message channel open
            }
            // Delegate to the handler in syncLogic. It now handles the concurrency check.
            syncLogic.handleSingleWeekSync(userId, tabId, sendResponse);
            // Return true HERE to keep the message channel open for the *asynchronous* response from handleSingleWeekSync
            return true;
        }
        case "startSemesterSync": {
            logger.debug('[Msg Listener] Dispatching to syncLogic.handleSemesterSync');
            const { userId } = message;
            // Basic validation
            if (!userId) {
                logger.error('[Msg Listener] Missing userId for startSemesterSync.');
                if (sendResponse) try { sendResponse({ status: "error", message: "Missing User ID." }); } catch (e) {/*ignore*/}
                return false; // Don't keep message channel open
            }
            // Delegate to the handler in syncLogic. It now handles the concurrency check.
            syncLogic.handleSemesterSync(userId, sendResponse);
            // Return true HERE to keep the message channel open for the *asynchronous* response from handleSemesterSync
            return true;
        }
        // <<<<< ADDED: Handler for popup requesting current sync state >>>>>
        case "getSyncState": {
            logger.debug('[Msg Listener] Responding to getSyncState request.');
            try {
                // Call the exported getter function from syncLogic
                const isRunning = getIsSyncInProgress(); // Use the imported function
                // Send the current state back synchronously
                sendResponse({ isRunning: isRunning });
            } catch (e) {
                logger.error("Error getting sync state:", e);
                // Send a default state or error indicator if retrieval fails
                sendResponse({ isRunning: false, error: "Could not retrieve sync state." });
            }
            // Return false because the response is sent synchronously within the handler
            return false;
        }
        // <<<<< END ADDED Handler >>>>>
        default:
            // Handle unknown actions
            logger.warn("BG Listener: Received unknown action:", message.action);
            // Return false as we are not handling this action and don't need to keep the channel open
            return false;
    }
});

// ==========================================================================
// Service Worker Initialization Log
// ==========================================================================

logger.info("Background service worker started (Modularized - Concurrency Lock Added).");
logger.info("Features: MutationObserver Wait, Batch API Additions");