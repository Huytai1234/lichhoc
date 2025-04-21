// sync-logic.js
'use strict';

import { logger } from './logger.js';
import * as constants from './constants.js';
import { delay, getRandomInt } from './utils.js';
import { closeOffscreenDocument, parseHtmlViaOffscreen } from './offscreen-helpers.js';
import { forceGoogleLoginAndGetToken } from './google-auth.js';
import { fetchExistingCalendarEvents, addEventsToCalendar } from './google-api.js';

// Module-level variables to store function references passed from background.js
let executeScriptOnTabRef;
let showNotificationRef;
let getContent_getWeekOptions_Ref; // <-- Reference for the injected function
let getContent_selectWeekAndGetData_Ref; // <-- Reference for the injected function

// --- Synchronization State Flag ---
/** @type {boolean} Tracks if a sync operation (week or semester) is currently running. */
let isSyncInProgress = false; // <<<<< ADDED: Concurrency lock flag

/**
 * Initializes this module with necessary function references from the background context.
 * @param {object} refs - Object containing function references.
 * @param {Function} refs.showNotificationRef
 * @param {Function} refs.executeScriptOnTabRef
 * @param {Function} refs.getContent_getWeekOptionsRef
 * @param {Function} refs.getContent_selectWeekAndGetDataRef
 */
export function initializeSyncLogic(refs) {
    showNotificationRef = refs.showNotificationRef;
    executeScriptOnTabRef = refs.executeScriptOnTabRef;
    getContent_getWeekOptions_Ref = refs.getContent_getWeekOptionsRef;
    getContent_selectWeekAndGetData_Ref = refs.getContent_selectWeekAndGetDataRef;

    // Validate that all required references are provided
    if (!showNotificationRef || !executeScriptOnTabRef || !getContent_getWeekOptions_Ref || !getContent_selectWeekAndGetData_Ref) {
        logger.error("Sync Logic initialization failed: Missing required function references.");
        // Handle error appropriately, maybe prevent further execution
    } else {
        logger.info("Sync Logic Initialized with required function references.");
    }
}

// --- State Getter ---
/**
 * Checks if a sync operation is currently in progress.
 * @returns {boolean} True if a sync is running, false otherwise.
 */
export function getIsSyncInProgress() { // <<<<< ADDED: Getter for the state flag
    return isSyncInProgress;
}

// --- State Broadcaster ---
/**
 * Sends a message to other parts of the extension (e.g., popup)
 * to inform them about the current sync state.
 */
function broadcastSyncState() { // <<<<< ADDED: Function to broadcast state changes
    const state = getIsSyncInProgress();
    logger.debug(`Broadcasting sync state: isRunning = ${state}`);
    // Use catch() to prevent errors if the receiving end (e.g., popup) is not open
    chrome.runtime.sendMessage({ action: "syncStateUpdate", isRunning: state })
        .catch(err => {
            // This specific error is expected if the popup isn't open, so we ignore it.
            if (!err.message.includes('Receiving end does not exist')) {
                logger.warn("Error broadcasting sync state:", err.message);
            }
        });
}

// --- Internal Helper Functions ---

/**
 * Helper to safely send a response back to the calling context (e.g., popup).
 * Ensures the response is sent even if errors occurred, and includes duration.
 * @param {Function} sendResponse - The sendResponse function from the message listener.
 * @param {object} status - The status object { status: 'success'|'error', message: string }.
 * @param {number|null} duration - Optional duration in seconds.
 * @param {string} syncId - Unique ID for logging context.
 * @param {number|null} startTime - The timestamp when the operation started.
 */
function safeSendResponse(sendResponse, status, duration, syncId, startTime) {
    const responsePayload = { ...status };
    if (duration !== null && !isNaN(duration)) {
        responsePayload.duration = duration;
        logger.info(`BG [${syncId}]: Sync duration: ${duration}s`);
    } else if (startTime) {
        // Log if duration calculation seems problematic but start time exists
        logger.warn(`BG [${syncId}]: Invalid duration calculated or startTime missing.`);
    }

    if (typeof sendResponse === 'function') {
        try {
            logger.info(`BG [${syncId}]: Sending final response:`, responsePayload);
            sendResponse(responsePayload);
        } catch (e) {
            // Log error if sending response fails (likely because the popup/context closed)
            logger.warn(`BG [${syncId}]: Error sending response (context likely closed):`, e.message);
        }
    } else {
        // Log if sendResponse wasn't provided correctly
        logger.warn(`BG [${syncId}]: sendResponse is not a valid function.`);
    }
}

/**
 * Fetches and parses the first and last weeks to determine the semester's date range
 * and fetches all existing Google Calendar events within that range.
 * @param {number} targetTabId - The ID of the MyUEL tab.
 * @param {Array<object>} weekOptions - Array of { value, text } for weeks.
 * @param {string} accessToken - Google OAuth2 access token.
 * @returns {Promise<{semesterStartDate: string, semesterEndDate: string, existingEventsSemesterSet: Set<string>}>}
 * @throws {Error} If initialization fails at any step.
 */
async function _initializeSemesterSync(targetTabId, weekOptions, accessToken) {
    const initId = `semInit-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${initId}]: Initializing semester sync...`);
    let semesterStartDate = null;
    let semesterEndDate = null;
    let offscreenWasClosed = false; // Track closing per initialization attempt

    // Helper to ensure the offscreen document is closed at most once during init
    const ensureCloseOffscreenLocal = async () => {
        if (!offscreenWasClosed) {
            await closeOffscreenDocument();
            offscreenWasClosed = true;
        }
    };

    try {
        if (!weekOptions || weekOptions.length === 0) {
            throw new Error("Cannot initialize: No valid week options provided.");
        }

        const firstWeek = weekOptions[0];
        const lastWeek = weekOptions[weekOptions.length - 1];
        offscreenWasClosed = false; // Reset flag for this attempt

        // Fetch and parse the first week
        logger.debug(`BG [${initId}]: Fetching FIRST week data (Value: ${firstWeek.value})...`);
        // *** Use the stored function reference ***
        const firstWeekData = await executeScriptOnTabRef(targetTabId, getContent_selectWeekAndGetData_Ref, [
            constants.WEEK_DROPDOWN_ID, firstWeek.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
        ]);
        if (!firstWeekData || firstWeekData.error) {
            throw new Error(`Failed to get first week data: ${firstWeekData?.error || 'Invalid response'}`);
        }
        if (!firstWeekData.timetableHtml || !firstWeekData.dateRangeText) {
             throw new Error(`Missing HTML/Date text for first week.`);
        }
        const firstParseResult = await parseHtmlViaOffscreen(firstWeekData.timetableHtml, firstWeekData.dateRangeText);
        semesterStartDate = firstParseResult.weekStartDate;
        logger.debug(`BG [${initId}]: Parsed first week. Start Date: ${semesterStartDate}`);

        // Fetch and parse the last week (only if different from the first)
        if (weekOptions.length > 1 && firstWeek.value !== lastWeek.value) {
            logger.debug(`BG [${initId}]: Fetching LAST week data (Value: ${lastWeek.value})...`);
            await delay(constants.INTER_WEEK_DELAY_MS); // Wait between week requests
            // *** Use the stored function reference ***
            const lastWeekData = await executeScriptOnTabRef(targetTabId, getContent_selectWeekAndGetData_Ref, [
                constants.WEEK_DROPDOWN_ID, lastWeek.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
            ]);
            if (!lastWeekData || lastWeekData.error) {
                throw new Error(`Failed to get last week data: ${lastWeekData?.error || 'Invalid response'}`);
            }
             if (!lastWeekData.timetableHtml || !lastWeekData.dateRangeText) {
                 throw new Error(`Missing HTML/Date text for last week.`);
             }
            const lastWeekParseResult = await parseHtmlViaOffscreen(lastWeekData.timetableHtml, lastWeekData.dateRangeText);
            semesterEndDate = lastWeekParseResult.weekEndDate;
            logger.debug(`BG [${initId}]: Parsed last week. End Date: ${semesterEndDate}`);
        } else {
            // If only one week, use its end date
            semesterEndDate = firstParseResult.weekEndDate;
            logger.debug(`BG [${initId}]: End Date derived from first week: ${semesterEndDate}`);
        }
        // Ensure offscreen is closed after potential parsing
        await ensureCloseOffscreenLocal();

        if (!semesterStartDate || !semesterEndDate) {
            throw new Error("Could not determine semester start or end date.");
        }
        logger.info(`BG [${initId}]: Determined semester range: ${semesterStartDate} to ${semesterEndDate}`);

        // Fetch all existing events for the determined range
        logger.info(`BG [${initId}]: Fetching all existing Google Calendar events for the semester...`);
        const existingEventsSemesterSet = await fetchExistingCalendarEvents(semesterStartDate, semesterEndDate, accessToken);
        logger.info(`BG [${initId}]: Found ${existingEventsSemesterSet.size} existing event keys for the semester.`);

        return { semesterStartDate, semesterEndDate, existingEventsSemesterSet };

    } catch (error) {
        logger.error(`BG [${initId}]: ERROR during semester initialization:`, error);
        await ensureCloseOffscreenLocal(); // Ensure cleanup on error
        // Rethrow a more specific error message
        throw new Error(`Semester initialization failed: ${error.message}`);
    }
}

// --- Exported Main Sync Functions ---

/** Handles the synchronization process for the currently viewed week. */
export async function handleSingleWeekSync(userId, tabId, sendResponse) {
    const syncId = `weekSync-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${syncId}]: --- Try Starting Single Week Sync --- User: ${userId}, Tab: ${tabId}`);

    // <<<<< MODIFIED: Concurrency Check >>>>>
    if (isSyncInProgress) {
        const busyMsg = "Another sync operation is already running. Please wait.";
        logger.warn(`BG [${syncId}]: Denied. Sync already in progress.`);
        // Send immediate response indicating busy state
        safeSendResponse(sendResponse, { status: "error", message: busyMsg }, null, syncId, null);
        return; // Stop execution
    }
    // <<<<< END Concurrency Check >>>>>

    let startTime = null;
    let accessToken = null;
    const notificationTitle = "Đồng bộ Tuần"; // Week Sync
    let finalStatus = { status: "pending", message: "Processing..." }; // Default status
    let offscreenDocWasClosed = false;

    // Helper to close offscreen document if needed for this specific operation
    const ensureCloseOffscreen = async () => {
        if (!offscreenDocWasClosed) { await closeOffscreenDocument(); offscreenDocWasClosed = true; }
    };

    // Validate essentials before proceeding
    if (typeof sendResponse !== 'function') { logger.error(`BG[${syncId}] sendResponse invalid.`); return; }
    if (!tabId) { safeSendResponse(sendResponse, { status: "error", message: "No Tab ID provided." }, null, syncId, null); return; }

    try {
        // <<<<< MODIFIED: Set Lock and Broadcast >>>>>
        isSyncInProgress = true;
        broadcastSyncState(); // Notify popup (if open) that sync has started
        logger.info(`BG [${syncId}]: Set isSyncInProgress = true`);
        // <<<<< END Set Lock >>>>>

        // Step 1: Get Google OAuth2 Token
        logger.info(`BG [${syncId}]: Getting token...`);
        showNotificationRef(notificationTitle, "Requesting Google authorization...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, showNotificationRef);
        logger.info(`BG [${syncId}]: Token OK.`);
        startTime = Date.now(); // Start timer after potentially waiting for auth

        // Step 2: Get Timetable Data from the Active Tab
        logger.info(`BG [${syncId}]: Getting data from tab ${tabId}...`);
        showNotificationRef(notificationTitle, "Fetching timetable data...", 'basic', `${syncId}-scrape`);
        // Define simple inline function to get current page content
        const _getSingleWeekContent = (tableId, dateId) => {
            const table = document.getElementById(tableId);
            const dateSpan = document.getElementById(dateId);
            if (!table) return { error: `Table element not found: ${tableId}` };
            if (!dateSpan) return { error: `Date span element not found: ${dateId}` };
            return { timetableHtml: table.outerHTML, dateRangeText: dateSpan.innerText.trim() };
        };
        // Execute the function on the target tab
        const extractedData = await executeScriptOnTabRef(tabId, _getSingleWeekContent, [
            constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
        ]);
        // Validate the result
        if (!extractedData || extractedData.error) {
            throw new Error(`Failed to get timetable data: ${extractedData?.error || 'Invalid response'}`);
        }
        if (!extractedData.timetableHtml || !extractedData.dateRangeText) {
             throw new Error("Failed to get timetable data: Missing HTML or Date text.");
        }
        logger.info(`BG [${syncId}]: Timetable data received successfully.`);

        // Step 3: Parse HTML using Offscreen Document
        logger.info(`BG [${syncId}]: Parsing timetable HTML...`);
        showNotificationRef(notificationTitle, "Analyzing schedule...", 'basic', `${syncId}-parse`);
        const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText);
        const { scheduleList, weekStartDate, weekEndDate } = parseResult;
        logger.info(`BG [${syncId}]: Parsed ${scheduleList.length} events for ${weekStartDate}-${weekEndDate}.`);
        await ensureCloseOffscreen(); // Close offscreen document after parsing

        // Step 4: Handle Case of No Events Found for the Week
        if (scheduleList.length === 0) {
            finalStatus = { status: "success", message: `No events found for week ${weekStartDate}-${weekEndDate}.` };
            showNotificationRef(notificationTitle + " - Done", finalStatus.message, 'basic', `${syncId}-noev`);
            // The final response is sent in the 'finally' block
            return; // Exit try block early, 'finally' will still execute
        }

        // Step 5: Fetch Existing Google Calendar Events for the Week Range
        logger.info(`BG [${syncId}]: Fetching existing Google Calendar events...`);
        showNotificationRef(notificationTitle, `Checking calendar (${weekStartDate}-${weekEndDate})...`, 'basic', `${syncId}-fetch`);
        const existingEventsSet = await fetchExistingCalendarEvents(weekStartDate, weekEndDate, accessToken);
        logger.info(`BG [${syncId}]: Found ${existingEventsSet.size} existing event keys for this week.`);

        // Step 6: Filter Parsed Events Against Existing Events
        logger.info(`BG [${syncId}]: Filtering events to find new ones...`);
        const eventsToAdd = [];
        let skippedCount = 0;
        for (const eventData of scheduleList) {
            // Create a unique key for comparison
            const eventKey = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room || '').trim()}`;
            if (!existingEventsSet.has(eventKey)) {
                eventsToAdd.push(eventData); // Add if key doesn't exist
            } else {
                skippedCount++; // Increment skipped count if key exists
            }
        }
        logger.info(`BG [${syncId}]: Filtering done. Events to Add: ${eventsToAdd.length}, Skipped: ${skippedCount}`);

        // Step 7: Add New Events to Google Calendar (if any)
        let addedCount = 0;
        let errorCount = 0;
        if (eventsToAdd.length > 0) {
            logger.info(`BG [${syncId}]: Adding ${eventsToAdd.length} new events to Google Calendar...`);
            showNotificationRef(notificationTitle, `Adding ${eventsToAdd.length} events...`, 'basic', `${syncId}-add`);
            // Use the batch API helper function for efficiency
            const addResult = await addEventsToCalendar(eventsToAdd, accessToken);
            addedCount = addResult.added;
            errorCount = addResult.errors;
            logger.info(`BG [${syncId}]: Add result - Added: ${addedCount}, Errors: ${errorCount}`);
        } else {
            logger.info(`BG [${syncId}]: No new events to add for this week.`);
        }

        // Step 8: Prepare Final Status Message (Response sent in 'finally')
        let finalMessage = `Week ${weekStartDate}-${weekEndDate}: Added ${addedCount}, Skipped ${skippedCount}, Errors ${errorCount}.`;
        // Determine overall status based on errors
        finalStatus = { status: (errorCount > 0 ? "error" : "success"), message: finalMessage };
        // Show final notification
        showNotificationRef(notificationTitle + (errorCount > 0 ? " - Error" : " - Done"), finalMessage, 'basic', `${syncId}-done`);

    } catch (error) {
        // Handle errors occurring during the sync process
        logger.error(`BG [${syncId}]: --- SINGLE WEEK SYNC FAILED ---`, error);
        // Create a user-friendly error message
        let errorMsg = `Week sync error: ${error?.message || 'Unknown error.'}`;
        if (error?.status === 401) errorMsg = "Google Authentication Error (401). Please try again.";
        else if (error?.status === 403) errorMsg = "Google Calendar Permission Error (403). Check permissions.";
        else if (error.message.includes("Failed to get timetable data")) errorMsg = error.message; // Use specific message
        else if (error.message.includes("Offscreen")) errorMsg = `Data processing error: ${error.message}`; // Use specific message
        // Set final status to error
        finalStatus = { status: "error", message: errorMsg };
        // Show error notification
        showNotificationRef(notificationTitle + " - ERROR", errorMsg, 'basic', `${syncId}-fail`);
        // Cleanup (like closing offscreen) is handled in finally
    } finally {
        // <<<<< MODIFIED: Release Lock, Send Response, Broadcast State >>>>>
        // This block executes regardless of whether the try block succeeded or failed.
        isSyncInProgress = false; // Release the lock
        logger.info(`BG [${syncId}]: Set isSyncInProgress = false`);
        const endTime = Date.now();
        // Send the final response back to the original caller (popup)
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);
        // Ensure the offscreen document is closed if it was used
        await ensureCloseOffscreen();
        // Broadcast the updated state (sync finished) to any open popups
        broadcastSyncState();
        logger.info(`BG [${syncId}]: --- Ending Single Week Sync ---`);
        // <<<<< END Finally Block >>>>>
    }
}

/** Handles the synchronization process for the entire semester. */
export async function handleSemesterSync(userId, sendResponse) {
    const syncId = `semSync-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${syncId}]: --- Try Starting Semester Sync --- User: ${userId}`);

    // <<<<< MODIFIED: Concurrency Check >>>>>
    if (isSyncInProgress) {
        const busyMsg = "Another sync operation is already running. Please wait.";
        logger.warn(`BG [${syncId}]: Denied. Sync already in progress.`);
        safeSendResponse(sendResponse, { status: "error", message: busyMsg }, null, syncId, null);
        return; // Stop execution
    }
    // <<<<< END Concurrency Check >>>>>

    let startTime = null; // Timer starts AFTER random delay and token retrieval
    let accessToken = null;
    const notificationTitle = "Đồng bộ Học kỳ"; // Semester Sync
    let overallResult = { added: 0, skipped: 0, errors: 0, weeksProcessed: 0, weeksTotal: 0, weeksWithApiError: 0 };
    let finalStatus = { status: "pending", message: "Processing..." }; // Default status
    let offscreenDocWasClosed = false; // Track offscreen document state per week

    // Helper to close offscreen document if needed for the current week's operation
    const ensureCloseOffscreen = async () => {
        if (!offscreenDocWasClosed) {
            logger.debug(`BG [${syncId}]: Ensuring offscreen is closed for the week...`);
            await closeOffscreenDocument(); // Call helper from offscreen-helpers.js
            offscreenDocWasClosed = true;
        }
    };

    // Validate sendResponse function
    if (typeof sendResponse !== 'function') {
        logger.error(`BG[${syncId}] sendResponse is invalid. Cannot report status.`);
        return; // Stop if we cannot communicate back
    }

    try {
        // <<<<< MODIFIED: Set Lock and Broadcast >>>>>
        isSyncInProgress = true;
        broadcastSyncState(); // Notify popup (if open) that sync has started
        logger.info(`BG [${syncId}]: Set isSyncInProgress = true`);
        // <<<<< END Set Lock >>>>>

        // ******** RANDOM START DELAY ********
        // Introduce a random delay to stagger requests if multiple users sync simultaneously
        const randomDelayMs = getRandomInt(1500, 4000); // Random delay between 1.5 and 4 seconds
        logger.info(`BG [${syncId}]: Applying random start delay: ${randomDelayMs}ms`);
        await delay(randomDelayMs); // Wait for the random duration
        logger.info(`BG [${syncId}]: Random start delay finished.`);
        // ******** END RANDOM START DELAY ********

        // Step 1: Get Google OAuth2 Token (Happens AFTER random delay)
        logger.info(`BG [${syncId}]: Getting Google Auth Token...`);
        showNotificationRef(notificationTitle, "Requesting Google authorization...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, showNotificationRef); // Pass notifier ref
        logger.info(`BG [${syncId}]: Google Auth Token received.`);
        startTime = Date.now(); // Start the main operation timer NOW

        // Step 2: Find MyUEL Tab & Get Week Options from Dropdown
        logger.info(`BG [${syncId}]: Finding MyUEL tab & getting week options...`);
        showNotificationRef(notificationTitle, "Finding tab & fetching week list...", 'basic', `${syncId}-find`);
        const matchingTabs = await chrome.tabs.query({ url: `${constants.MYUEL_TKB_URL_PATTERN}*` });
        if (matchingTabs.length === 0) {
            throw new Error(`MyUEL Timetable tab not found. Please open it first.`);
        }
        const targetTabId = matchingTabs[0].id;
        logger.info(`BG [${syncId}]: Target Tab ID: ${targetTabId}`);

        // Use the injected function reference to get week options
        const weekOptionsResult = await executeScriptOnTabRef(targetTabId, getContent_getWeekOptions_Ref, [constants.WEEK_DROPDOWN_ID]);
        if (weekOptionsResult?.error) {
            throw new Error(`Error getting week list: ${weekOptionsResult.error}`);
        }
        if (!Array.isArray(weekOptionsResult)) {
            throw new Error(`Error getting week list: Invalid response received.`);
        }
        // Filter out potentially invalid options
        const weekOptions = weekOptionsResult.filter(opt => opt.value && opt.value !== "-1");
        if (weekOptions.length === 0) {
            throw new Error("No valid weeks found in the dropdown.");
        }
        overallResult.weeksTotal = weekOptions.length;
        logger.info(`BG [${syncId}]: Found ${weekOptions.length} valid weeks.`);

        // Step 3: Pre-select the second week (if available) - This might help prime the page state
        if (weekOptions.length > 1) {
            try {
                logger.debug(`BG [${syncId}]: Pre-selecting week 2 (Value: ${weekOptions[1].value})...`);
                // Inject a simple inline function for this action
                await executeScriptOnTabRef(targetTabId, (dropdownId, weekVal) => {
                    const dropdown = document.getElementById(dropdownId);
                    if (dropdown) {
                        dropdown.value = weekVal;
                        // Trigger the 'change' event which the page likely listens to
                        dropdown.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, [constants.WEEK_DROPDOWN_ID, weekOptions[1].value]);
                await delay(constants.PRESELECT_WAIT_MS); // Wait after pre-selection for page to potentially react
                logger.info(`BG [${syncId}]: Pre-select finished.`);
            } catch (e) {
                // This pre-selection is not critical, log the error and continue
                logger.error(`BG [${syncId}]: Pre-select script error:`, e);
                await delay(500); // Add a small fallback delay just in case
            }
        } else {
            logger.info(`BG [${syncId}]: Skipping pre-select (only one week or no weeks).`);
        }

        // Step 4: Initialize Semester (Determine Date Range & Fetch Existing Events for the *entire* semester)
        await delay(500); // Add small delay before the potentially intensive initialization
        showNotificationRef(notificationTitle, "Determining semester range & checking calendar...", 'basic', `${syncId}-init`);
        // Call the helper function which fetches first/last week and all events in between
        const { existingEventsSemesterSet } = await _initializeSemesterSync(targetTabId, weekOptions, accessToken);

        // Step 5: Loop Through Each Week to Get Data, Parse, Filter, and Add Events
        logger.info(`BG [${syncId}]: Starting week processing loop (Inter-week delay: ${constants.INTER_WEEK_DELAY_MS}ms)...`);
        let consecutiveEmptyWeeks = 0; // Counter for consecutive weeks with no events
        for (let i = 0; i < weekOptions.length; i++) {
            const week = weekOptions[i];
            const weekNumStr = `${i + 1}/${overallResult.weeksTotal}`; // For logging/notifications
            logger.info(`BG [${syncId}]: --- Processing Week ${weekNumStr} (${week.text} / Value: ${week.value}) ---`);
            overallResult.weeksProcessed++;
            offscreenDocWasClosed = false; // Reset offscreen flag for each week

            // Check if we should stop early due to too many consecutive empty weeks
            if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) {
                logger.warn(`BG [${syncId}]: Stopping early after ${consecutiveEmptyWeeks} consecutive empty weeks.`);
                showNotificationRef(notificationTitle, `Stopping early after week ${i}.`); // Inform user
                break; // Exit the loop
            }

            showNotificationRef(notificationTitle, `Processing week ${weekNumStr}...`, 'basic', `sem-week-start-${i}`);

            // Inner try/catch block for handling errors specific to a single week
            try {
                // 5a: Get Timetable Data for the current week using the MutationObserver approach
                showNotificationRef(notificationTitle, `(W${weekNumStr}) Fetching data...`, 'basic', `sem-get-${i}`);
                logger.debug(`BG [${syncId}]: W${weekNumStr} - Getting data...`);
                // Use the stored function reference for the complex injection
                const extractedData = await executeScriptOnTabRef(targetTabId, getContent_selectWeekAndGetData_Ref, [
                    constants.WEEK_DROPDOWN_ID, week.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
                ]);
                // Validate response from injected script
                if (!extractedData || extractedData.error) {
                    throw new Error(extractedData?.error || `Failed to get data for W${weekNumStr}.`);
                }
                if (!extractedData.timetableHtml || !extractedData.dateRangeText) {
                    throw new Error(`Missing HTML/Date text for W${weekNumStr}.`);
                }
                logger.info(`BG [${syncId}]: W${weekNumStr} - Data received OK.`);

                // 5b: Parse the HTML Data via Offscreen Document
                showNotificationRef(notificationTitle, `(W${weekNumStr}) Analyzing...`, 'basic', `sem-parse-${i}`);
                logger.info(`BG [${syncId}]: W${weekNumStr} - Parsing...`);
                const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText);
                const { scheduleList: scheduleListForWeek, weekStartDate, weekEndDate } = parseResult;
                logger.info(`BG [${syncId}]: W${weekNumStr} (${weekStartDate}-${weekEndDate}) - Parsed ${scheduleListForWeek.length} events.`);
                await ensureCloseOffscreen(); // Close offscreen document after parsing this week

                // 5c/d: Filter & Add Events if the week is not empty
                if (scheduleListForWeek.length === 0) {
                    consecutiveEmptyWeeks++; // Increment empty week counter
                    logger.info(`BG [${syncId}]: W${weekNumStr} - Empty week. Consecutive empty count: ${consecutiveEmptyWeeks}. Skipping Add.`);
                } else {
                    consecutiveEmptyWeeks = 0; // Reset counter if week has events
                    showNotificationRef(notificationTitle, `(W${weekNumStr}) Filtering ${scheduleListForWeek.length} events...`, 'basic', `sem-filter-${i}`);
                    logger.info(`BG [${syncId}]: W${weekNumStr} - Filtering ${scheduleListForWeek.length} events against ${existingEventsSemesterSet.size} existing semester keys...`);

                    // Filter against existing events fetched for the whole semester
                    const eventsToAdd = [];
                    let currentSkipped = 0;
                    for (const eventData of scheduleListForWeek) {
                        const eventKey = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room || '').trim()}`;
                        if (!existingEventsSemesterSet.has(eventKey)) {
                            eventsToAdd.push(eventData); // Add if not found in semester set
                        } else {
                            currentSkipped++;
                        }
                    }
                    overallResult.skipped += currentSkipped; // Update overall skipped count
                    logger.info(`BG [${syncId}]: W${weekNumStr} - Filtering done. Events to Add: ${eventsToAdd.length}, Skipped: ${currentSkipped}`);

                    // Add new events if any were found for this week
                    if (eventsToAdd.length > 0) {
                        showNotificationRef(notificationTitle, `(W${weekNumStr}) Adding ${eventsToAdd.length} events...`, 'basic', `sem-add-${i}`);
                        logger.info(`BG [${syncId}]: W${weekNumStr} - Adding ${eventsToAdd.length} events...`);
                        const addResult = await addEventsToCalendar(eventsToAdd, accessToken); // Use batch add helper
                        // Update overall results
                        overallResult.added += addResult.added;
                        overallResult.errors += addResult.errors;
                        if (addResult.errors > 0) {
                            overallResult.weeksWithApiError++; // Track weeks that had API errors during add
                        }
                        logger.info(`BG [${syncId}]: W${weekNumStr} - Add result: Added ${addResult.added}, Errors ${addResult.errors}`);

                        // If events were added successfully, update the semester set to avoid duplicates
                        // This prevents re-adding if the process is interrupted and restarted.
                        if (addResult.added > 0 && addResult.errors === 0) {
                            for (const addedEvent of eventsToAdd) {
                                const eventKey = `${addedEvent.subject}|${addedEvent.start_datetime_iso}|${addedEvent.end_datetime_iso}|${(addedEvent.room || '').trim()}`;
                                existingEventsSemesterSet.add(eventKey);
                            }
                            logger.debug(`BG [${syncId}]: Updated semester set with ${addResult.added} new keys. New size: ${existingEventsSemesterSet.size}`);
                        }
                    } else {
                        logger.info(`BG [${syncId}]: W${weekNumStr} - No new events to add.`);
                    }
                } // End else (week not empty)

            } catch (weekError) {
                // Handle errors specific to processing this week
                logger.error(`BG [${syncId}]: --- ERROR PROCESSING WEEK ${weekNumStr} ---`, weekError);
                overallResult.errors++; // Increment general error count for the week
                consecutiveEmptyWeeks++; // Treat error week as potentially empty for early stopping
                showNotificationRef(notificationTitle + " - Week Error", `Error week ${weekNumStr}: ${weekError.message.substring(0, 100)}...`, 'basic', `sem-err-${i}`);
                await ensureCloseOffscreen(); // Ensure cleanup after week error

                // Check if the error is critical (e.g., auth failure) and should halt the entire sync
                const errorMessage = weekError?.message || '';
                const errorStatus = weekError?.status; // HTTP status if available
                // Check for common critical errors (Auth, Forbidden, potentially others)
                let isCritical = (errorStatus === 401 || errorStatus === 403 || errorMessage.includes("Token"));
                if (isCritical) {
                    logger.warn(`BG [${syncId}]: Critical error encountered during week processing. Halting semester sync.`);
                    throw weekError; // Propagate critical error to the outer catch block
                } else {
                    // Log non-critical error and continue to the next week
                    logger.warn(`BG [${syncId}]: Non-critical week error detected. Continuing...`);
                    // Optionally delay slightly after a non-critical error
                    await delay(500);
                }
            } // End catch weekError

            // Notify user about week completion (optional, can be noisy)
            // showNotificationRef(notificationTitle, `Completed week ${weekNumStr}.`, 'basic', `sem-week-done-${i}`);

            // Crucial delay between processing weeks to avoid overwhelming the server
            logger.debug(`BG [${syncId}]: Delaying ${constants.INTER_WEEK_DELAY_MS}ms before next week...`);
            await delay(constants.INTER_WEEK_DELAY_MS);

        } // End week processing loop
        logger.info(`BG [${syncId}]: Semester week processing loop finished.`);

        // Step 6: Prepare Final Summary and Response (Response sent in 'finally')
        let processedCount = overallResult.weeksProcessed;
        let stoppedEarlyMsg = "";
        // Adjust count and message if stopped early
        if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) {
             // Adjust processed count if stopped early (subtract the empty weeks that triggered the stop)
             processedCount = Math.max(0, overallResult.weeksProcessed - consecutiveEmptyWeeks);
             stoppedEarlyMsg = ` (Stopped early)`; // Add "stopped early" message
             logger.info(`BG [${syncId}]: Adjusted processed week count due to early stop: ${processedCount}`);
        }

        // Construct final summary message
        let finalMessage = `Semester sync finished! (${processedCount}/${overallResult.weeksTotal} weeks processed${stoppedEarlyMsg}) Added: ${overallResult.added}, Skipped: ${overallResult.skipped}, Errors: ${overallResult.errors}.`;
        if (overallResult.weeksWithApiError > 0) {
            finalMessage += ` (${overallResult.weeksWithApiError} weeks with API errors)`;
        }
        logger.info(`BG [${syncId}]: Final Summary: ${finalMessage}`);

        // Determine final status based on errors
        if (overallResult.errors > 0 || overallResult.weeksWithApiError > 0) {
            finalStatus = { status: "error", message: finalMessage };
            showNotificationRef(notificationTitle + " - Completed with Errors", finalMessage, 'basic', `sem-done-error`);
        } else {
            finalStatus = { status: "success", message: finalMessage };
            showNotificationRef(notificationTitle + " - Success", finalMessage, 'basic', `sem-done-ok`);
        }
        // Response sent in 'finally' block

    } catch (error) { // Outer Catch Block for fatal errors (e.g., auth, init fail, critical week error)
        logger.error(`BG [${syncId}]: --- SEMESTER SYNC FAILED (Outer Catch) ---`, error);
        let errorMsg = `Critical Semester Sync Error: ${error?.message || 'Unknown critical error.'}`;
        // Refine messages for common fatal errors
        if (error?.status === 401) errorMsg = "Google Authentication Error (401). Please try again.";
        else if (error?.status === 403) errorMsg = "Google Calendar Permission Error (403). Check permissions.";
        else if (error.message.includes("MyUEL Timetable tab not found")) errorMsg = error.message; // Use specific message from step 2
        else if (error.message.includes("initialization failed")) errorMsg = error.message; // Use specific message from step 4

        finalStatus = { status: "error", message: errorMsg };
        showNotificationRef(notificationTitle + " - CRITICAL ERROR", errorMsg, 'basic', `sem-fail-critical`);
        // Cleanup is handled in finally

    } finally {
        // <<<<< MODIFIED: Release Lock, Send Response, Broadcast State >>>>>
        // This block executes regardless of success or failure of the try block.
        isSyncInProgress = false; // Release the lock
        logger.info(`BG [${syncId}]: Set isSyncInProgress = false`);
        const endTime = Date.now();
        // Send the final response back to the original caller (popup)
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);
        // Ensure the offscreen document is closed (especially if loop finished/broke early)
        await ensureCloseOffscreen();
        // Broadcast the updated state (sync finished)
        broadcastSyncState();
        logger.info(`BG [${syncId}]: --- Ending Semester Sync ---`);
        // <<<<< END Finally Block >>>>>
    }
}