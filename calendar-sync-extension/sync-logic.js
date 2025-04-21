// sync-logic.js
'use strict';

import { logger } from './logger.js';
import * as constants from './constants.js';
import { delay } from './utils.js';
import { closeOffscreenDocument, parseHtmlViaOffscreen } from './offscreen-helpers.js';
import { forceGoogleLoginAndGetToken } from './google-auth.js';
import { fetchExistingCalendarEvents, addEventsToCalendar } from './google-api.js';

// We need references to the functions that will be injected
// These will be passed from background.js which imports them from content-injects.js
let _getContent_getWeekOptions;
let _getContent_selectWeekAndGetData;
let _executeScriptOnTab;
let _showNotification;


/**
 * Initializes this module with necessary function references from background context.
 * @param {object} refs
 * @param {Function} refs.showNotificationRef
 * @param {Function} refs.executeScriptOnTabRef
 * @param {Function} refs.getContent_getWeekOptionsRef
 * @param {Function} refs.getContent_selectWeekAndGetDataRef
 */
export function initializeSyncLogic(refs) {
    _showNotification = refs.showNotificationRef;
    _executeScriptOnTab = refs.executeScriptOnTabRef;
    _getContent_getWeekOptions = refs.getContent_getWeekOptionsRef;
    _getContent_selectWeekAndGetData = refs.getContent_selectWeekAndGetDataRef;
    logger.info("Sync Logic Initialized with function references.");
}


/** Handles the synchronization process for the currently viewed week. */
export async function handleSingleWeekSync(userId, tabId, sendResponse) {
    // ... (code for handleSingleWeekSync - unchanged logic) ...
    // Replace calls to executeScriptOnTab with _executeScriptOnTab
    // Replace calls to showNotification with _showNotification
    // Replace calls to forceGoogleLoginAndGetToken with passing _showNotification
    // Use constants via constants.WEEK_DROPDOWN_ID etc.
     const syncId = `weekSync-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${syncId}]: --- Starting Single Week Sync --- User: ${userId}, Tab: ${tabId}`);
    let startTime = null; let accessToken = null; const notificationTitle = "Đồng bộ Tuần";
    let finalStatus = { status: "pending", message: "Đang xử lý..." }; let offscreenDocWasClosed = false;
    const ensureCloseOffscreen = async () => { if (!offscreenDocWasClosed) { await closeOffscreenDocument(); offscreenDocWasClosed = true; } };
    const safeSendResponse = (status, duration = null) => { /* ... (unchanged) ... */
         const responsePayload = { ...status };
        if (duration !== null && !isNaN(duration)) { responsePayload.duration = duration; logger.info(`BG [${syncId}]: Sync duration: ${duration}s`); }
        else if (startTime) { logger.warn(`BG [${syncId}]: Invalid duration.`); }
        if (typeof sendResponse === 'function') { try { logger.info(`BG [${syncId}]: Sending final response:`, responsePayload); sendResponse(responsePayload); } catch (e) { logger.warn(`BG [${syncId}]: Error sending response:`, e); } }
        else { logger.warn(`BG [${syncId}]: sendResponse invalid.`); }
     };

    if (typeof sendResponse !== 'function') { logger.error(`BG[${syncId}] sendResponse invalid`); return; }
    if (!tabId) { safeSendResponse({ status: "error", message: "No Tab ID" }); return; }

    try {
        // Step 1: Token
        logger.info(`BG [${syncId}]: Getting token...`); _showNotification(notificationTitle, "Yêu cầu Google...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, _showNotification); // Pass reference
        logger.info(`BG [${syncId}]: Token OK.`); startTime = Date.now();

        // Step 2: Get Data (Inject simple getter)
        logger.info(`BG [${syncId}]: Getting data tab ${tabId}...`); _showNotification(notificationTitle, "Lấy dữ liệu TKB...", 'basic', `${syncId}-scrape`);
        const getContentData = (tableId, dateId) => { const t=document.getElementById(tableId), d=document.getElementById(dateId); return !t?{e:`No table ${tableId}`}:!d?{e:`No date ${dateId}`}:{h:t.outerHTML,t:d.innerText.trim()} };
        const extractedDataRaw = await _executeScriptOnTab(tabId, getContentData, [constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING]);
        if (!extractedDataRaw || extractedDataRaw.e) throw new Error(`Lỗi lấy TKB: ${extractedDataRaw?.e || 'No data'}`);
        const extractedData = { timetableHtml: extractedDataRaw.h, dateRangeText: extractedDataRaw.t }; // Adapt structure
        if (!extractedData.timetableHtml || !extractedData.dateRangeText) throw new Error("Lỗi lấy TKB: HTML/Ngày thiếu.");
        logger.info(`BG [${syncId}]: Data OK.`);

        // Step 3: Parse
        logger.info(`BG [${syncId}]: Parsing...`); _showNotification(notificationTitle, "Phân tích...", 'basic', `${syncId}-parse`);
        const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText);
        const { scheduleList, weekStartDate, weekEndDate } = parseResult;
        logger.info(`BG [${syncId}]: Parsed ${scheduleList.length} events.`); await ensureCloseOffscreen();

        if (scheduleList.length === 0) {
            finalStatus = { status: "success", message: `Không có sự kiện tuần ${weekStartDate}-${weekEndDate}.` };
            _showNotification(notificationTitle + " - Xong", finalStatus.message, 'basic', `${syncId}-noev`);
            const endTime = Date.now(); safeSendResponse(finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null); return;
        }

        // Step 4: Fetch Existing
        logger.info(`BG [${syncId}]: Fetching existing...`); _showNotification(notificationTitle, `Kiểm tra lịch...`, 'basic', `${syncId}-fetch`);
        const existingEventsSet = await fetchExistingCalendarEvents(weekStartDate, weekEndDate, accessToken);
        logger.info(`BG [${syncId}]: Found ${existingEventsSet.size} existing keys.`);

        // Step 5: Filter
        logger.info(`BG [${syncId}]: Filtering...`); const eventsToAdd = []; let skippedCount = 0;
        for (const eventData of scheduleList) {
            const eventKey = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room || '').trim()}`;
            if (!existingEventsSet.has(eventKey)) eventsToAdd.push(eventData); else skippedCount++;
        }
        logger.info(`BG [${syncId}]: Filter done. Add: ${eventsToAdd.length}, Skip: ${skippedCount}`);

        // Step 6: Add
        let addedCount = 0; let errorCount = 0;
        if (eventsToAdd.length > 0) {
            logger.info(`BG [${syncId}]: Adding ${eventsToAdd.length}...`); _showNotification(notificationTitle, `Đang thêm ${eventsToAdd.length}...`, 'basic', `${syncId}-add`);
            const addResult = await addEventsToCalendar(eventsToAdd, accessToken);
            addedCount = addResult.added; errorCount = addResult.errors;
            logger.info(`BG [${syncId}]: Add result - Added: ${addedCount}, Errors: ${errorCount}`);
        } else { logger.info(`BG [${syncId}]: No new events.`); }

        // Step 7: Final Status
        let finalMessage = `Tuần ${weekStartDate}-${weekEndDate}: Thêm ${addedCount}, Bỏ qua ${skippedCount}, Lỗi ${errorCount}.`;
        finalStatus = { status: (errorCount > 0 ? "error" : "success"), message: finalMessage };
        _showNotification(notificationTitle + (errorCount > 0 ? " - Lỗi" : " - Xong"), finalMessage, 'basic', `${syncId}-done`);
        const endTime = Date.now(); safeSendResponse(finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null);

    } catch (error) {
        logger.error(`BG [${syncId}]: --- SINGLE WEEK SYNC FAILED ---`, error);
        let errorMsg = `Lỗi ĐB tuần: ${error?.message || 'Lỗi KXD.'}`;
        if (error?.status === 401) errorMsg = "Lỗi xác thực Google (401). Thử lại."; else if (error?.status === 403) errorMsg = "Lỗi quyền Google Cal (403).";
        finalStatus = { status: "error", message: errorMsg }; _showNotification(notificationTitle + " - LỖI", errorMsg, 'basic', `${syncId}-fail`);
        await ensureCloseOffscreen(); const endTime = Date.now(); safeSendResponse(finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null);
    } finally { await ensureCloseOffscreen(); logger.info(`BG [${syncId}]: --- Ending Single Week Sync ---`); }
}

/** Helper to get semester boundaries and existing events - Stays Internal */
async function _initializeSemesterSync(targetTabId, weekOptions, accessToken) {
    // ... (code for _initializeSemesterSync - unchanged logic) ...
    // Replace calls to executeScriptOnTab with _executeScriptOnTab etc.
     const initId = `semInit-${Date.now().toString().slice(-6)}`; logger.info(`BG [${initId}]: Initializing...`);
    let semesterStartDate = null; let semesterEndDate = null; let existingEventsSemesterSet = new Set();
    let offscreenWasClosed = false; const ensureCloseOffscreenLocal = async () => { if (!offscreenWasClosed) { await closeOffscreenDocument(); offscreenWasClosed = true;} }

    try {
        if (!weekOptions || weekOptions.length === 0) throw new Error("No weeks.");
        const firstWeek = weekOptions[0]; const lastWeek = weekOptions[weekOptions.length - 1]; offscreenWasClosed = false;
        logger.debug(`BG [${initId}]: Fetching FIRST week (${firstWeek.value})...`);
        const firstWeekData = await _executeScriptOnTab(targetTabId, _getContent_selectWeekAndGetData, [constants.WEEK_DROPDOWN_ID, firstWeek.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING]);
        if (!firstWeekData || firstWeekData.error) throw new Error(`Err get week 1: ${firstWeekData?.error||'Invalid'}`);
        const firstParse = await parseHtmlViaOffscreen(firstWeekData.timetableHtml, firstWeekData.dateRangeText); semesterStartDate = firstParse.weekStartDate;
        logger.debug(`BG [${initId}]: Start Date: ${semesterStartDate}`);
        if (weekOptions.length > 1 && firstWeek.value !== lastWeek.value) {
            logger.debug(`BG [${initId}]: Fetching LAST week (${lastWeek.value})...`); await delay(constants.INTER_WEEK_DELAY_MS);
            const lastWeekData = await _executeScriptOnTab(targetTabId, _getContent_selectWeekAndGetData, [constants.WEEK_DROPDOWN_ID, lastWeek.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING]);
            if (!lastWeekData || lastWeekData.error) throw new Error(`Err get last week: ${lastWeekData?.error||'Invalid'}`);
            const lastParse = await parseHtmlViaOffscreen(lastWeekData.timetableHtml, lastWeekData.dateRangeText); semesterEndDate = lastParse.weekEndDate;
            logger.debug(`BG [${initId}]: End Date: ${semesterEndDate}`);
        } else { semesterEndDate = firstParse.weekEndDate; logger.debug(`BG [${initId}]: End Date (from first): ${semesterEndDate}`); }
        await ensureCloseOffscreenLocal();
        if (!semesterStartDate || !semesterEndDate) throw new Error("Cannot determine start/end dates.");
        logger.info(`BG [${initId}]: Range: ${semesterStartDate} to ${semesterEndDate}`);
        logger.info(`BG [${initId}]: Fetching existing events...`);
        existingEventsSemesterSet = await fetchExistingCalendarEvents(semesterStartDate, semesterEndDate, accessToken);
        logger.info(`BG [${initId}]: Found ${existingEventsSemesterSet.size} existing keys.`);
        return { semesterStartDate, semesterEndDate, existingEventsSemesterSet };
    } catch (error) { logger.error(`BG [${initId}]: ERROR init semester:`, error); await ensureCloseOffscreenLocal(); throw new Error(`Lỗi khởi tạo HK: ${error.message}`); }
}

/** Handles the synchronization process for the entire semester. */
export async function handleSemesterSync(userId, sendResponse) {
    // ... (code for handleSemesterSync - unchanged logic) ...
    // Replace calls with _ versions and use constants.*
    const syncId = `semSync-${Date.now().toString().slice(-6)}`; logger.info(`BG [${syncId}]: --- Starting Semester Sync --- User: ${userId}`);
    let startTime = null; let accessToken = null; const notificationTitle="Đồng bộ Học kỳ";
    let overallResult = { added:0, skipped:0, errors:0, weeksProcessed:0, weeksTotal:0, weeksWithApiError:0 };
    let finalStatus = { status:"pending", message:"Đang xử lý..."}; let offscreenDocWasClosed = false;
    const ensureCloseOffscreen = async () => { if (!offscreenDocWasClosed) { await closeOffscreenDocument(); offscreenDocWasClosed = true; } };
    const safeSendResponse = (status, duration = null) => { /* ... (unchanged, uses logger) ... */
         const responsePayload = { ...status };
        if (duration !== null && !isNaN(duration)) { responsePayload.duration = duration; logger.info(`BG [${syncId}]: Sync duration: ${duration}s`); }
        else if (startTime) { logger.warn(`BG [${syncId}]: Invalid duration.`); }
        if (typeof sendResponse === 'function') { try { logger.info(`BG [${syncId}]: Sending final response:`, responsePayload); sendResponse(responsePayload); } catch (e) { logger.warn(`BG [${syncId}]: Error sending response:`, e); } }
        else { logger.warn(`BG [${syncId}]: sendResponse invalid.`); }
    };
    if (typeof sendResponse !== 'function') { logger.error(`BG[${syncId}] sendResponse invalid.`); return; }

    try {
        // Step 1: Token
        logger.info(`BG [${syncId}]: Getting token...`); _showNotification(notificationTitle, "Yêu cầu Google...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, _showNotification); logger.info(`BG [${syncId}]: Token OK.`); startTime = Date.now();

        // Step 2 & 3: Find Tab, Weeks, Pre-select
        logger.info(`BG [${syncId}]: Finding tab & getting weeks...`); _showNotification(notificationTitle, "Tìm tab & lấy tuần...", 'basic', `${syncId}-find`);
        const matchingTabs = await chrome.tabs.query({ url: `${constants.MYUEL_TKB_URL_PATTERN}*` }); if (matchingTabs.length === 0) throw new Error(`Tab TKB không tìm thấy.`);
        const targetTabId = matchingTabs[0].id; logger.info(`BG [${syncId}]: Target Tab: ${targetTabId}`);
        const weekOptionsResult = await _executeScriptOnTab(targetTabId, _getContent_getWeekOptions, [constants.WEEK_DROPDOWN_ID]);
        if (weekOptionsResult?.error) throw new Error(`Lỗi lấy tuần: ${weekOptionsResult.error}`); if (!Array.isArray(weekOptionsResult)) throw new Error(`Lỗi lấy tuần: Invalid response.`);
        const weekOptions = weekOptionsResult.filter(opt=>opt.value && opt.value!=="-1"); if (weekOptions.length === 0) throw new Error("Không có tuần hợp lệ.");
        overallResult.weeksTotal = weekOptions.length; logger.info(`BG [${syncId}]: Found ${weekOptions.length} weeks.`);
        if (weekOptions.length > 1) {
            try { logger.debug(`BG [${syncId}]: Pre-selecting week 2 (${weekOptions[1].value})...`);
                await _executeScriptOnTab(targetTabId, (ddId,wVal)=>{const d=document.getElementById(ddId);if(d)d.value=wVal;d.dispatchEvent(new Event('change',{bubbles:true}));}, [constants.WEEK_DROPDOWN_ID, weekOptions[1].value]);
                await delay(constants.PRESELECT_WAIT_MS); logger.info(`BG [${syncId}]: Pre-select finished.`);
            } catch (preSelectError) { logger.error(`BG [${syncId}]: Pre-select error:`, preSelectError); await delay(500); }
        } else { logger.info(`BG [${syncId}]: Skipping pre-select.`); }

        // Step 4: Initialize (Get range, fetch existing)
        _showNotification(notificationTitle, "Xác định HK & kiểm tra lịch...", 'basic', `${syncId}-init`);
        const { existingEventsSemesterSet } = await _initializeSemesterSync(targetTabId, weekOptions, accessToken);

        // Step 5: Week Loop
        logger.info(`BG [${syncId}]: Starting week loop (Delay: ${constants.INTER_WEEK_DELAY_MS}ms)...`);
        let consecutiveEmptyWeeks=0;
        for (let i = 0; i < weekOptions.length; i++) {
            const week = weekOptions[i]; const weekNumStr = `${i+1}/${overallResult.weeksTotal}`;
            logger.info(`BG [${syncId}]: --- Processing Week ${weekNumStr} (${week.text}) ---`); overallResult.weeksProcessed++; offscreenDocWasClosed = false;
            if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) { logger.warn(`BG [${syncId}]: Stopping early...`); _showNotification(notificationTitle, `Dừng sớm sau ${consecutiveEmptyWeeks} tuần trống.`); break; }
            _showNotification(notificationTitle, `Xử lý tuần ${weekNumStr}...`, 'basic', `sem-week-start-${i}`);
            try {
                 // 5a: Get Data
                 _showNotification(notificationTitle, `(W${weekNumStr}) Lấy dữ liệu...`, 'basic', `sem-get-${i}`); logger.debug(`BG [${syncId}]: W${weekNumStr} - Getting data...`);
                 const extractedData = await _executeScriptOnTab(targetTabId, _getContent_selectWeekAndGetData, [constants.WEEK_DROPDOWN_ID, week.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING]);
                 if (!extractedData || extractedData.error) throw new Error(extractedData?.error || `Lỗi lấy data W${weekNumStr}.`); if (!extractedData.timetableHtml || !extractedData.dateRangeText) throw new Error(`Thiếu HTML/Ngày W${weekNumStr}.`);
                 logger.info(`BG [${syncId}]: W${weekNumStr} - Data OK.`);
                 // 5b: Parse
                 _showNotification(notificationTitle, `(W${weekNumStr}) Phân tích...`, 'basic', `sem-parse-${i}`); logger.info(`BG [${syncId}]: W${weekNumStr} - Parsing...`);
                 const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText); const { scheduleList: scheduleListForWeek, weekStartDate, weekEndDate } = parseResult;
                 logger.info(`BG [${syncId}]: W${weekNumStr} (${weekStartDate}-${weekEndDate}) - Parsed ${scheduleListForWeek.length} events.`); await ensureCloseOffscreen();
                 if (scheduleListForWeek.length === 0) { consecutiveEmptyWeeks++; logger.info(`BG [${syncId}]: W${weekNumStr} - Empty week. Consecutive: ${consecutiveEmptyWeeks}`); }
                 else { consecutiveEmptyWeeks = 0;
                      // 5c: Filter
                      _showNotification(notificationTitle, `(W${weekNumStr}) Lọc ${scheduleListForWeek.length}...`, 'basic', `sem-filter-${i}`); logger.info(`BG [${syncId}]: W${weekNumStr} - Filtering ${scheduleListForWeek.length} vs ${existingEventsSemesterSet.size} keys...`);
                      const eventsToAdd = []; let currentSkipped=0;
                      for (const eventData of scheduleListForWeek) { const key = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room||'').trim()}`; if (!existingEventsSemesterSet.has(key)) eventsToAdd.push(eventData); else currentSkipped++; }
                      overallResult.skipped += currentSkipped; logger.info(`BG [${syncId}]: W${weekNumStr} - Filter done. Add: ${eventsToAdd.length}, Skip: ${currentSkipped}`);
                      // 5d: Add
                     if (eventsToAdd.length > 0) {
                          _showNotification(notificationTitle, `(W${weekNumStr}) Thêm ${eventsToAdd.length}...`, 'basic', `sem-add-${i}`); logger.info(`BG [${syncId}]: W${weekNumStr} - Adding ${eventsToAdd.length}...`);
                          const addResult = await addEventsToCalendar(eventsToAdd, accessToken); overallResult.added += addResult.added; overallResult.errors += addResult.errors; if (addResult.errors > 0) overallResult.weeksWithApiError++; logger.info(`BG [${syncId}]: W${weekNumStr} - Add result: Added ${addResult.added}, Errors ${addResult.errors}`);
                          if (addResult.added > 0 && addResult.errors === 0) { for (const addedEvent of eventsToAdd) { const key = `${addedEvent.subject}|${addedEvent.start_datetime_iso}|${addedEvent.end_datetime_iso}|${(addedEvent.room||'').trim()}`; existingEventsSemesterSet.add(key); } logger.debug(`BG [${syncId}]: Updated semester set +${addResult.added}. Size: ${existingEventsSemesterSet.size}`); }
                     } else { logger.info(`BG [${syncId}]: W${weekNumStr} - No new events.`); }
                 }
            } catch (weekError) { logger.error(`BG [${syncId}]: --- ERROR WEEK ${weekNumStr} ---`, weekError); overallResult.errors++; consecutiveEmptyWeeks++; _showNotification(notificationTitle + "-Lỗi Tuần", `Lỗi tuần ${weekNumStr}: ${weekError.message.substring(0,100)}...`, 'basic', `sem-err-${i}`); await ensureCloseOffscreen();
                const errMsg = weekError?.message||''; const errStatus = weekError?.status; let isCritical = false;
                if (errStatus === 401 || errStatus === 403 || errMsg.includes("Token")) isCritical = true;
                if (isCritical) { logger.warn(`BG [${syncId}]: Critical week error.`); throw weekError; }
                else { logger.warn(`BG [${syncId}]: Non-critical week error.`); }
            }
            _showNotification(notificationTitle, `Hoàn thành tuần ${weekNumStr}.`, 'basic', `sem-week-done-${i}`); logger.debug(`BG [${syncId}]: Delaying ${constants.INTER_WEEK_DELAY_MS}ms...`); await delay(constants.INTER_WEEK_DELAY_MS);
        } logger.info(`BG [${syncId}]: Semester loop finished.`);

        // Step 6: Final Summary
        let processedCount = overallResult.weeksProcessed; let stoppedEarlyMsg = "";
        if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) { processedCount = Math.max(0, overallResult.weeksProcessed - consecutiveEmptyWeeks); stoppedEarlyMsg = ` (Dừng sớm)`; logger.info(`BG [${syncId}]: Adjusted count: ${processedCount}`); }
        let finalMessage = `Đồng bộ HK xong! (${processedCount}/${overallResult.weeksTotal} tuần) Thêm: ${overallResult.added}, Bỏ qua: ${overallResult.skipped}, Lỗi: ${overallResult.errors}.`; if (overallResult.weeksWithApiError > 0) finalMessage += ` (${overallResult.weeksWithApiError} tuần lỗi API)`; finalMessage += stoppedEarlyMsg; logger.info(`BG [${syncId}]: Final Summary: ${finalMessage}`);
        finalStatus = { status: (overallResult.errors > 0 || overallResult.weeksWithApiError > 0 ? "error" : "success"), message: finalMessage };
        _showNotification(notificationTitle + (finalStatus.status === "error" ? " - Có lỗi" : " - Thành công"), finalMessage, 'basic', `sem-done-${finalStatus.status}`);
        const endTime = Date.now(); safeSendResponse(finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null);

    } catch (error) { logger.error(`BG [${syncId}]: --- SEMESTER SYNC FAILED ---`, error);
        let errorMsg = `Lỗi nghiêm trọng ĐB HK: ${error?.message || 'Lỗi KXD.'}`; if (error?.status===401) errorMsg="Lỗi xác thực Google (401)."; else if (error?.status===403) errorMsg="Lỗi quyền Google Cal (403)."; else if (error.message.includes("Tab TKB")) errorMsg = "Lỗi: Không tìm thấy tab TKB.";
        finalStatus = { status: "error", message: errorMsg }; _showNotification(notificationTitle + " - LỖI NGHIÊM TRỌNG", errorMsg, 'basic', `sem-fail-critical`);
        const endTime = Date.now(); await ensureCloseOffscreen(); safeSendResponse(finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null);
    } finally { await ensureCloseOffscreen(); logger.info(`BG [${syncId}]: --- Ending Semester Sync ---`); }
}