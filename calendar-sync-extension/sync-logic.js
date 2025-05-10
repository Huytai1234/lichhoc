
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


/**
 * Initializes this module with necessary function references from the background context.
 * @param {object} refs - Object containing function references.
 * @param {Function} refs.showNotificationRef
 * @param {Function} refs.executeScriptOnTabRef
 * @param {Function} refs.getContent_getWeekOptionsRef // <-- Added
 * @param {Function} refs.getContent_selectWeekAndGetDataRef // <-- Added
 */
export function initializeSyncLogic(refs) {
    showNotificationRef = refs.showNotificationRef;
    executeScriptOnTabRef = refs.executeScriptOnTabRef;
    // Store references to the inject functions
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

// --- Internal Helper Functions ---

/**
 * Helper to safely send a response back to the calling context (e.g., popup).
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
        logger.warn(`BG [${syncId}]: Invalid duration calculated or startTime missing.`);
    }

    if (typeof sendResponse === 'function') {
        try {
            logger.info(`BG [${syncId}]: Sending final response:`, responsePayload);
            sendResponse(responsePayload);
        } catch (e) {
            logger.warn(`BG [${syncId}]: Error sending response (context likely closed):`, e.message);
        }
    } else {
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
    let offscreenWasClosed = false;

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
        offscreenWasClosed = false;

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

        // Fetch and parse the last week (only if needed)
        if (weekOptions.length > 1 && firstWeek.value !== lastWeek.value) {
            logger.debug(`BG [${initId}]: Fetching LAST week data (Value: ${lastWeek.value})...`);
            await delay(constants.INTER_WEEK_DELAY_MS);
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
            semesterEndDate = firstParseResult.weekEndDate;
            logger.debug(`BG [${initId}]: End Date derived from first week: ${semesterEndDate}`);
        }
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
        await ensureCloseOffscreenLocal();
        throw new Error(`Semester initialization failed: ${error.message}`);
    }
}

// --- Exported Main Sync Functions ---

/** Handles the synchronization process for the currently viewed week. */
export async function handleSingleWeekSync(userId, tabId, sendResponse) {
    const syncId = `weekSync-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${syncId}]: --- Starting Single Week Sync --- User: ${userId}, Tab: ${tabId}`);
    let startTime = null;
    let accessToken = null;
    const notificationTitle = "Đồng bộ Tuần";
    let finalStatus = { status: "pending", message: "Đang xử lý..." };
    let offscreenDocWasClosed = false;

    const ensureCloseOffscreen = async () => {
        if (!offscreenDocWasClosed) { await closeOffscreenDocument(); offscreenDocWasClosed = true; }
    };

    if (typeof sendResponse !== 'function') { logger.error(`BG[${syncId}] sendResponse invalid.`); return; }
    if (!tabId) { safeSendResponse(sendResponse, { status: "error", message: "No Tab ID" }, null, syncId, null); return; }

    try {
        // Step 1: Token
        logger.info(`BG [${syncId}]: Getting token...`);
        showNotificationRef(notificationTitle, "Yêu cầu Google...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, showNotificationRef);
        logger.info(`BG [${syncId}]: Token OK.`);
        startTime = Date.now();

        // Step 2: Get Data (Inject simple getter locally)
        logger.info(`BG [${syncId}]: Getting data from tab ${tabId}...`);
        showNotificationRef(notificationTitle, "Lấy dữ liệu TKB...", 'basic', `${syncId}-scrape`);
        const _getSingleWeekContent = (tableId, dateId) => { // Define locally
            const table = document.getElementById(tableId);
            const dateSpan = document.getElementById(dateId);
            if (!table) return { error: `Table not found: ${tableId}` };
            if (!dateSpan) return { error: `Date span not found: ${dateId}` };
            return { timetableHtml: table.outerHTML, dateRangeText: dateSpan.innerText.trim() };
        };
        const extractedData = await executeScriptOnTabRef(tabId, _getSingleWeekContent, [
            constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
        ]);
        if (!extractedData || extractedData.error) {
            throw new Error(`Failed to get timetable data: ${extractedData?.error || 'Invalid response'}`);
        }
        if (!extractedData.timetableHtml || !extractedData.dateRangeText) {
             throw new Error("Failed to get timetable data: Missing HTML or Date text.");
        }
        logger.info(`BG [${syncId}]: Data received successfully.`);

        // Step 3: Parse
        logger.info(`BG [${syncId}]: Parsing...`);
        showNotificationRef(notificationTitle, "Phân tích...", 'basic', `${syncId}-parse`);
        const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText);
        const { scheduleList, weekStartDate, weekEndDate } = parseResult;
        logger.info(`BG [${syncId}]: Parsed ${scheduleList.length} events for ${weekStartDate}-${weekEndDate}.`);
        await ensureCloseOffscreen();

        // Step 4: Handle No Events
        if (scheduleList.length === 0) {
            finalStatus = { status: "success", message: `Không có sự kiện tuần ${weekStartDate}-${weekEndDate}.` };
            showNotificationRef(notificationTitle + " - Xong", finalStatus.message, 'basic', `${syncId}-noev`);
            const endTime = Date.now();
            safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);
            return;
        }

        // Step 5: Fetch Existing
        logger.info(`BG [${syncId}]: Fetching existing Google events...`);
        showNotificationRef(notificationTitle, `Kiểm tra lịch (${weekStartDate}-${weekEndDate})...`, 'basic', `${syncId}-fetch`);
        const existingEventsSet = await fetchExistingCalendarEvents(weekStartDate, weekEndDate, accessToken);
        logger.info(`BG [${syncId}]: Found ${existingEventsSet.size} existing event keys.`);

        // Step 6: Filter
        logger.info(`BG [${syncId}]: Filtering events...`);
        const eventsToAdd = [];
        let skippedCount = 0;
        for (const eventData of scheduleList) {
            const eventKey = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room || '').trim()}`;
            if (!existingEventsSet.has(eventKey)) eventsToAdd.push(eventData); else skippedCount++;
        }
        logger.info(`BG [${syncId}]: Filtering done. To Add: ${eventsToAdd.length}, Skipped: ${skippedCount}`);

        // Step 7: Add Events
        let addedCount = 0; let errorCount = 0;
        if (eventsToAdd.length > 0) {
            logger.info(`BG [${syncId}]: Adding ${eventsToAdd.length} events...`);
            showNotificationRef(notificationTitle, `Đang thêm ${eventsToAdd.length} sự kiện...`, 'basic', `${syncId}-add`);
            const addResult = await addEventsToCalendar(eventsToAdd, accessToken);
            addedCount = addResult.added; errorCount = addResult.errors;
            logger.info(`BG [${syncId}]: Add result - Added: ${addedCount}, Errors: ${errorCount}`);
        } else { logger.info(`BG [${syncId}]: No new events to add.`); }

        // Step 8: Final Status
        let finalMessage = `Tuần ${weekStartDate}-${weekEndDate}: Thêm ${addedCount}, Bỏ qua ${skippedCount}, Lỗi ${errorCount}.`;
        finalStatus = { status: (errorCount > 0 ? "error" : "success"), message: finalMessage };
        showNotificationRef(notificationTitle + (errorCount > 0 ? " - Lỗi" : " - Xong"), finalMessage, 'basic', `${syncId}-done`);
        const endTime = Date.now();
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);

    } catch (error) {
        logger.error(`BG [${syncId}]: --- SINGLE WEEK SYNC FAILED ---`, error);
        let errorMsg = `Lỗi đồng bộ tuần: ${error?.message || 'Lỗi không xác định.'}`;
        if (error?.status === 401) errorMsg = "Lỗi xác thực Google (401)."; else if (error?.status === 403) errorMsg = "Lỗi quyền Google Calendar (403)."; else if (error.message.includes("Failed to get")) errorMsg = error.message; else if (error.message.includes("Offscreen")) errorMsg = `Lỗi xử lý dữ liệu: ${error.message}`;
        finalStatus = { status: "error", message: errorMsg };
        showNotificationRef(notificationTitle + " - LỖI", errorMsg, 'basic', `${syncId}-fail`);
        await ensureCloseOffscreen(); const endTime = Date.now();
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);
    } finally {
        await ensureCloseOffscreen();
        logger.info(`BG [${syncId}]: --- Ending Single Week Sync ---`);
    }
}

//handleSemesterSync
export async function handleSemesterSync(userId, sendResponse) {
    const syncId = `semSync-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${syncId}]: --- Starting Semester Sync --- User: ${userId}`);
    let startTime = null; // Timer starts AFTER random delay and token retrieval
    let accessToken = null;
    const notificationTitle = "Đồng bộ Học kỳ"; // Notification title in Vietnamese
    let overallResult = { added: 0, skipped: 0, errors: 0, weeksProcessed: 0, weeksTotal: 0, weeksWithApiError: 0 };
    let finalStatus = { status: "pending", message: "Đang xử lý..." }; // Default status
    let offscreenDocWasClosed = false; // Track offscreen document state

    // Helper function to ensure offscreen document is closed properly
    const ensureCloseOffscreen = async () => {
        if (!offscreenDocWasClosed) {
            logger.debug(`BG [${syncId}]: Ensuring offscreen is closed...`);
            await closeOffscreenDocument(); // Call helper from offscreen-helpers.js
            offscreenDocWasClosed = true;
        }
    };

    // Basic check for the sendResponse function
    if (typeof sendResponse !== 'function') {
        logger.error(`BG[${syncId}] sendResponse is invalid. Cannot report status.`);
        return; // Stop if we cannot communicate back
    }

    try {
        // ******** RANDOM START DELAY ********
        const randomDelayMs = getRandomInt(1500, 4000); // Random delay between 1.5 and 4 seconds
        logger.info(`BG [${syncId}]: Applying random start delay: ${randomDelayMs}ms`);
        // Optional: Send an initial "Preparing..." message to the popup here if needed
        await delay(randomDelayMs); // Wait for the random duration
        logger.info(`BG [${syncId}]: Random start delay finished.`);
        // ******** END RANDOM START DELAY ********

        // Step 1: Get Google OAuth2 Token (Happens AFTER random delay)
        logger.info(`BG [${syncId}]: Getting Google Auth Token...`);
        showNotificationRef(notificationTitle, "Yêu cầu Google...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, showNotificationRef); // Pass notifier ref
        logger.info(`BG [${syncId}]: Google Auth Token received.`);
        startTime = Date.now(); // Start the main operation timer NOW

        // Step 2: Find MyUEL Tab & Get Week Options from Dropdown
        logger.info(`BG [${syncId}]: Finding MyUEL tab & getting week options...`);
        showNotificationRef(notificationTitle, "Tìm tab & lấy tuần...", 'basic', `${syncId}-find`);
        const matchingTabs = await chrome.tabs.query({ url: `${constants.MYUEL_TKB_URL_PATTERN}*` });
        if (matchingTabs.length === 0) {
            throw new Error(`MyUEL Timetable tab not found. Please open it first.`);
        }
        const targetTabId = matchingTabs[0].id;
        logger.info(`BG [${syncId}]: Target Tab ID: ${targetTabId}`);

        // Use the function reference passed during initialization
        const weekOptionsResult = await executeScriptOnTabRef(targetTabId, getContent_getWeekOptions_Ref, [constants.WEEK_DROPDOWN_ID]);
        if (weekOptionsResult?.error) {
            throw new Error(`Error getting week list: ${weekOptionsResult.error}`);
        }
        if (!Array.isArray(weekOptionsResult)) {
            throw new Error(`Error getting week list: Invalid response received.`);
        }
        const weekOptions = weekOptionsResult.filter(opt => opt.value && opt.value !== "-1"); // Filter out invalid options
        if (weekOptions.length === 0) {
            throw new Error("No valid weeks found in the dropdown.");
        }
        overallResult.weeksTotal = weekOptions.length;
        logger.info(`BG [${syncId}]: Found ${weekOptions.length} valid weeks.`);

        // Step 3: Pre-select the second week (if available) to potentially prime the page state
        if (weekOptions.length > 1) {
            try {
                logger.debug(`BG [${syncId}]: Pre-selecting week 2 (Value: ${weekOptions[1].value})...`);
                // Inject a simple inline function for this action
                await executeScriptOnTabRef(targetTabId, (dropdownId, weekVal) => {
                    const dropdown = document.getElementById(dropdownId);
                    if (dropdown) {
                        dropdown.value = weekVal;
                        dropdown.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, [constants.WEEK_DROPDOWN_ID, weekOptions[1].value]);
                await delay(constants.PRESELECT_WAIT_MS); // Wait after pre-selection
                logger.info(`BG [${syncId}]: Pre-select finished.`);
            } catch (e) {
                // This is not critical, log the error and continue
                logger.error(`BG [${syncId}]: Pre-select script error:`, e);
                await delay(500); // Add a small fallback delay
            }
        } else {
            logger.info(`BG [${syncId}]: Skipping pre-select (only one week or no weeks).`);
        }

        // Step 4: Initialize Semester (Determine Date Range & Fetch Existing Events)
        await delay(500); // Add small delay before the potentially intensive initialization
        showNotificationRef(notificationTitle, "Xác định HK & kiểm tra lịch...", 'basic', `${syncId}-init`);
        const { existingEventsSemesterSet } = await _initializeSemesterSync(targetTabId, weekOptions, accessToken);

        // Step 5: Loop Through Each Week to Get Data, Parse, Filter, and Add Events
        logger.info(`BG [${syncId}]: Starting week processing loop (Inter-week delay: ${constants.INTER_WEEK_DELAY_MS}ms)...`);
        let consecutiveEmptyWeeks = 0;
        for (let i = 0; i < weekOptions.length; i++) {
            const week = weekOptions[i];
            const weekNumStr = `${i + 1}/${overallResult.weeksTotal}`;
            logger.info(`BG [${syncId}]: --- Processing Week ${weekNumStr} (${week.text} / Value: ${week.value}) ---`);
            overallResult.weeksProcessed++;
            offscreenDocWasClosed = false; // Reset offscreen flag for each week

            // Check if we should stop early due to too many consecutive empty weeks
            if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) {
                logger.warn(`BG [${syncId}]: Stopping early after ${consecutiveEmptyWeeks} consecutive empty weeks.`);
                showNotificationRef(notificationTitle, `Dừng sớm sau tuần ${i}.`); // Inform user
                break; // Exit the loop
            }

            showNotificationRef(notificationTitle, `Xử lý tuần ${weekNumStr}...`, 'basic', `sem-week-start-${i}`);

            try {
                // 5a: Get Timetable Data for the current week
                showNotificationRef(notificationTitle, `(W${weekNumStr}) Lấy dữ liệu...`, 'basic', `sem-get-${i}`);
                logger.debug(`BG [${syncId}]: W${weekNumStr} - Getting data...`);
                // Use the stored function reference for the complex injection
                const extractedData = await executeScriptOnTabRef(targetTabId, getContent_selectWeekAndGetData_Ref, [
                    constants.WEEK_DROPDOWN_ID, week.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
                ]);
                if (!extractedData || extractedData.error) {
                    throw new Error(extractedData?.error || `Failed to get data for W${weekNumStr}.`);
                }
                if (!extractedData.timetableHtml || !extractedData.dateRangeText) {
                    throw new Error(`Missing HTML/Date text for W${weekNumStr}.`);
                }
                logger.info(`BG [${syncId}]: W${weekNumStr} - Data received OK.`);

                // 5b: Parse the HTML Data via Offscreen Document
                showNotificationRef(notificationTitle, `(W${weekNumStr}) Phân tích...`, 'basic', `sem-parse-${i}`);
                logger.info(`BG [${syncId}]: W${weekNumStr} - Parsing...`);
                const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText);
                const { scheduleList: scheduleListForWeek, weekStartDate, weekEndDate } = parseResult;
                logger.info(`BG [${syncId}]: W${weekNumStr} (${weekStartDate}-${weekEndDate}) - Parsed ${scheduleListForWeek.length} events.`);
                await ensureCloseOffscreen(); // Close offscreen document after parsing

                // 5c/d: Filter & Add Events if the week is not empty
                if (scheduleListForWeek.length === 0) {
                    consecutiveEmptyWeeks++;
                    logger.info(`BG [${syncId}]: W${weekNumStr} - Empty week. Consecutive empty count: ${consecutiveEmptyWeeks}. Skipping Add.`);
                } else {
                    consecutiveEmptyWeeks = 0; // Reset counter
                    showNotificationRef(notificationTitle, `(W${weekNumStr}) Lọc ${scheduleListForWeek.length}...`, 'basic', `sem-filter-${i}`);
                    logger.info(`BG [${syncId}]: W${weekNumStr} - Filtering ${scheduleListForWeek.length} events against ${existingEventsSemesterSet.size} existing keys...`);

                    // Filter against existing events fetched for the whole semester
                    const eventsToAdd = [];
                    let currentSkipped = 0;
                    for (const eventData of scheduleListForWeek) {
                        const eventKey = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room || '').trim()}`;
                        if (!existingEventsSemesterSet.has(eventKey)) {
                            eventsToAdd.push(eventData);
                        } else {
                            currentSkipped++;
                        }
                    }
                    overallResult.skipped += currentSkipped;
                    logger.info(`BG [${syncId}]: W${weekNumStr} - Filtering done. Events to Add: ${eventsToAdd.length}, Skipped: ${currentSkipped}`);

                    // Add new events if any were found
                    if (eventsToAdd.length > 0) {
                        showNotificationRef(notificationTitle, `(W${weekNumStr}) Thêm ${eventsToAdd.length}...`, 'basic', `sem-add-${i}`);
                        logger.info(`BG [${syncId}]: W${weekNumStr} - Adding ${eventsToAdd.length} events...`);
                        const addResult = await addEventsToCalendar(eventsToAdd, accessToken); // Use batch add helper
                        overallResult.added += addResult.added;
                        overallResult.errors += addResult.errors;
                        if (addResult.errors > 0) {
                            overallResult.weeksWithApiError++;
                        }
                        logger.info(`BG [${syncId}]: W${weekNumStr} - Add result: Added ${addResult.added}, Errors ${addResult.errors}`);

                        // If events were added successfully, update the semester set to avoid duplicates if logic restarts somehow
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
                logger.error(`BG [${syncId}]: --- ERROR PROCESSING WEEK ${weekNumStr} ---`, weekError);
                overallResult.errors++; // Increment general error count for the week
                consecutiveEmptyWeeks++; // Treat error week as potentially empty
                showNotificationRef(notificationTitle + "-Lỗi Tuần", `Lỗi tuần ${weekNumStr}: ${weekError.message.substring(0, 100)}...`, 'basic', `sem-err-${i}`);
                await ensureCloseOffscreen(); // Ensure cleanup after week error

                // Check if the error is critical and should halt the entire sync
                const errorMessage = weekError?.message || '';
                const errorStatus = weekError?.status;
                let isCritical = (errorStatus === 401 || errorStatus === 403 || errorMessage.includes("Token")); // Check common critical errors
                if (isCritical) {
                    logger.warn(`BG [${syncId}]: Critical error encountered during week processing. Halting semester sync.`);
                    throw weekError; // Propagate critical error to the outer catch block
                } else {
                    // Log non-critical error and continue to the next week
                    logger.warn(`BG [${syncId}]: Non-critical week error detected. Continuing...`);
                }
            } // End catch weekError

            // Optional: Notify user about week completion
            showNotificationRef(notificationTitle, `Hoàn thành tuần ${weekNumStr}.`, 'basic', `sem-week-done-${i}`);

            // Crucial delay between processing weeks
            logger.debug(`BG [${syncId}]: Delaying ${constants.INTER_WEEK_DELAY_MS}ms before next week...`);
            await delay(constants.INTER_WEEK_DELAY_MS);

        } // End week processing loop
        logger.info(`BG [${syncId}]: Semester week processing loop finished.`);

        // Step 6: Final Summary and Response
        let processedCount = overallResult.weeksProcessed;
        let stoppedEarlyMsg = "";
        if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) {
             // Adjust count if stopped early
             processedCount = Math.max(0, overallResult.weeksProcessed - consecutiveEmptyWeeks);
             stoppedEarlyMsg = ` (Dừng sớm)`; // Add "stopped early" message
             logger.info(`BG [${syncId}]: Adjusted processed week count due to early stop: ${processedCount}`);
        }

        let finalMessage = `Đồng bộ HK xong! (${processedCount}/${overallResult.weeksTotal} tuần) Thêm: ${overallResult.added}, Bỏ qua: ${overallResult.skipped}, Lỗi: ${overallResult.errors}.`;
        if (overallResult.weeksWithApiError > 0) {
            finalMessage += ` (${overallResult.weeksWithApiError} tuần lỗi API)`;
        }
        finalMessage += stoppedEarlyMsg;
        logger.info(`BG [${syncId}]: Final Summary: ${finalMessage}`);

        // Determine final status based on errors
        if (overallResult.errors > 0 || overallResult.weeksWithApiError > 0) {
            finalStatus = { status: "error", message: finalMessage };
            showNotificationRef(notificationTitle + " - Có lỗi", finalMessage, 'basic', `sem-done-error`);
        } else {
            finalStatus = { status: "success", message: finalMessage };
            showNotificationRef(notificationTitle + " - Thành công", finalMessage, 'basic', `sem-done-ok`);
        }
        const endTime = Date.now();
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);

    } catch (error) { // Outer Catch Block for fatal errors (e.g., auth, init fail)
        logger.error(`BG [${syncId}]: --- SEMESTER SYNC FAILED (Outer Catch) ---`, error);
        let errorMsg = `Lỗi nghiêm trọng ĐB HK: ${error?.message || 'Lỗi không xác định.'}`;
        // Refine messages for common fatal errors
        if (error?.status === 401) errorMsg = "Lỗi xác thực Google (401). Vui lòng thử lại.";
        else if (error?.status === 403) errorMsg = "Lỗi quyền Google Calendar (403). Kiểm tra quyền.";
        else if (error.message.includes("Tab TKB MyUEL")) errorMsg = error.message; // Use specific message
        else if (error.message.includes("initialization failed")) errorMsg = error.message; // Use specific message

        finalStatus = { status: "error", message: errorMsg };
        showNotificationRef(notificationTitle + " - LỖI NGHIÊM TRỌNG", errorMsg, 'basic', `sem-fail-critical`);
        const endTime = Date.now();
        await ensureCloseOffscreen(); // Ensure cleanup on fatal error
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);

    } finally {
        await ensureCloseOffscreen(); // Final cleanup attempt regardless of success/failure
        logger.info(`BG [${syncId}]: --- Ending Semester Sync ---`);
    }
}
