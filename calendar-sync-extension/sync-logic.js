// sync-logic.js
'use strict';

import { logger } from './logger.js';
import * as constants from './constants.js';
import { delay, getRandomInt } from './utils.js';
import { closeOffscreenDocument, parseHtmlViaOffscreen } from './offscreen-helpers.js';
import { forceGoogleLoginAndGetToken } from './google-auth.js';
// Thay đổi import
import {
    fetchExistingExtensionEventsWithIds, // SỬA TÊN HÀM NÀY
    addEventsToCalendar,
    deleteEventsFromCalendar // THÊM HÀM NÀY
} from './google-api.js';

// Module-level variables to store function references passed from background.js
let executeScriptOnTabRef;
let showNotificationRef;
let getContent_getWeekOptions_Ref;
let getContent_selectWeekAndGetData_Ref;


export function initializeSyncLogic(refs) {
    showNotificationRef = refs.showNotificationRef;
    executeScriptOnTabRef = refs.executeScriptOnTabRef;
    getContent_getWeekOptions_Ref = refs.getContent_getWeekOptionsRef;
    getContent_selectWeekAndGetData_Ref = refs.getContent_selectWeekAndGetDataRef;

    if (!showNotificationRef || !executeScriptOnTabRef || !getContent_getWeekOptions_Ref || !getContent_selectWeekAndGetData_Ref) {
        logger.error("Sync Logic initialization failed: Missing required function references.");
    } else {
        logger.info("Sync Logic Initialized with required function references.");
    }
}

function safeSendResponse(sendResponse, status, duration, syncId, startTime) {
    const responsePayload = { ...status };
    if (duration !== null && !isNaN(duration)) {
        responsePayload.duration = duration;
        logger.info(`BG [${syncId}]: Sync duration: ${duration}s`);
    } else if (startTime) {
        // logger.warn(`BG [${syncId}]: Invalid duration calculated or startTime missing.`); // Giảm bớt log warning
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

        const firstWeekOpt = weekOptions[0];
        const lastWeekOpt = weekOptions[weekOptions.length - 1];
        offscreenWasClosed = false;

        logger.debug(`BG [${initId}]: Fetching FIRST week data (Value: ${firstWeekOpt.value})...`);
        const firstWeekData = await executeScriptOnTabRef(targetTabId, getContent_selectWeekAndGetData_Ref, [
            constants.WEEK_DROPDOWN_ID, firstWeekOpt.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
        ]);
        if (!firstWeekData || firstWeekData.error) {
            throw new Error(`Failed to get first week data: ${firstWeekData?.error || 'Invalid response'}`);
        }
        if (!firstWeekData.timetableHtml || !firstWeekData.dateRangeText) {
             throw new Error(`Missing HTML/Date text for first week.`);
        }
        const firstParseResult = await parseHtmlViaOffscreen(firstWeekData.timetableHtml, firstWeekData.dateRangeText);
        if (firstParseResult.error) throw new Error(`Error parsing first week: ${firstParseResult.error}`);
        semesterStartDate = firstParseResult.weekStartDate;
        logger.debug(`BG [${initId}]: Parsed first week. Start Date: ${semesterStartDate}`);

        if (weekOptions.length > 1 && firstWeekOpt.value !== lastWeekOpt.value) {
            logger.debug(`BG [${initId}]: Fetching LAST week data (Value: ${lastWeekOpt.value})...`);
            await delay(constants.INTER_WEEK_DELAY_MS);
            const lastWeekData = await executeScriptOnTabRef(targetTabId, getContent_selectWeekAndGetData_Ref, [
                constants.WEEK_DROPDOWN_ID, lastWeekOpt.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
            ]);
            if (!lastWeekData || lastWeekData.error) {
                throw new Error(`Failed to get last week data: ${lastWeekData?.error || 'Invalid response'}`);
            }
             if (!lastWeekData.timetableHtml || !lastWeekData.dateRangeText) {
                 throw new Error(`Missing HTML/Date text for last week.`);
             }
            const lastWeekParseResult = await parseHtmlViaOffscreen(lastWeekData.timetableHtml, lastWeekData.dateRangeText);
            if (lastWeekParseResult.error) throw new Error(`Error parsing last week: ${lastWeekParseResult.error}`);
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

        logger.info(`BG [${initId}]: Fetching all existing EXTENSION Google Calendar events for the semester...`);
        // Sử dụng hàm mới để chỉ lấy sự kiện của extension
        const existingEventsSemesterMap = await fetchExistingExtensionEventsWithIds(semesterStartDate, semesterEndDate, accessToken);
        logger.info(`BG [${initId}]: Found ${existingEventsSemesterMap.size} existing EXTENSION event keys for the semester.`);

        return { semesterStartDate, semesterEndDate, existingEventsSemesterMap }; // Trả về Map thay vì Set

    } catch (error) {
        logger.error(`BG [${initId}]: ERROR during semester initialization:`, error);
        await ensureCloseOffscreenLocal();
        throw new Error(`Semester initialization failed: ${error.message}`);
    }
}


export async function handleSingleWeekSync(userId, tabId, sendResponse) {
    const syncId = `weekSync-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${syncId}]: --- Starting Single Week Sync (with delete old) --- User: ${userId}, Tab: ${tabId}`);
    let startTime = null;
    let accessToken = null;
    const notificationTitle = "Đồng bộ Tuần";
    let finalStatus = { status: "pending", message: "Đang xử lý..." };
    let offscreenDocWasClosed = false;
    let deletedEventCount = 0;
    let GCalAPIErrorsDuringDelete = 0;

    const ensureCloseOffscreen = async () => {
        if (!offscreenDocWasClosed) { await closeOffscreenDocument(); offscreenDocWasClosed = true; }
    };

    if (typeof sendResponse !== 'function') { logger.error(`BG[${syncId}] sendResponse invalid.`); return; }
    if (!tabId) { safeSendResponse(sendResponse, { status: "error", message: "No Tab ID" }, null, syncId, null); return; }

    try {
        logger.info(`BG [${syncId}]: Getting token...`);
        showNotificationRef(notificationTitle, "Yêu cầu Google...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, showNotificationRef);
        logger.info(`BG [${syncId}]: Token OK.`);
        startTime = Date.now();

        logger.info(`BG [${syncId}]: Getting data from tab ${tabId}...`);
        showNotificationRef(notificationTitle, "Lấy dữ liệu TKB...", 'basic', `${syncId}-scrape`);
        const _getSingleWeekContent = (tableId, dateId) => {
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
            throw new Error(`Lỗi lấy dữ liệu TKB: ${extractedData?.error || 'Không rõ'}`);
        }
        if (!extractedData.timetableHtml || !extractedData.dateRangeText) {
             throw new Error("Lỗi lấy dữ liệu TKB: Thiếu HTML hoặc Chuỗi ngày.");
        }
        logger.info(`BG [${syncId}]: Data received successfully.`);

        logger.info(`BG [${syncId}]: Parsing...`);
        showNotificationRef(notificationTitle, "Phân tích...", 'basic', `${syncId}-parse`);
        const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText);
        if (parseResult.error) {
            throw new Error(`Lỗi phân tích dữ liệu: ${parseResult.error}`);
        }
        const { scheduleList, weekStartDate, weekEndDate } = parseResult; // scheduleList là từ MyUEL
        logger.info(`BG [${syncId}]: Parsed ${scheduleList.length} events from MyUEL for ${weekStartDate}-${weekEndDate}.`);
        await ensureCloseOffscreen();

        if (!weekStartDate || !weekEndDate) {
            throw new Error("Không thể xác định ngày BĐ/KT của tuần để xóa sự kiện cũ.");
        }

        logger.info(`BG [${syncId}]: Fetching existing EXTENSION events for deletion in range ${weekStartDate} - ${weekEndDate}...`);
        showNotificationRef(notificationTitle, `Kiểm tra lịch cũ (${weekStartDate}-${weekEndDate})...`, 'basic', `${syncId}-fetch-old`);

        const existingExtensionEventsMap = await fetchExistingExtensionEventsWithIds(weekStartDate, weekEndDate, accessToken);
        const eventIdsToDelete = Array.from(existingExtensionEventsMap.values());

        if (eventIdsToDelete.length > 0) {
            logger.info(`BG [${syncId}]: Found ${eventIdsToDelete.length} old extension events to delete for this week.`);
            showNotificationRef(notificationTitle, `Đang xóa ${eventIdsToDelete.length} lịch cũ...`, 'basic', `${syncId}-delete`);
            const deleteResult = await deleteEventsFromCalendar(eventIdsToDelete, accessToken);
            deletedEventCount = deleteResult.deleted;
            GCalAPIErrorsDuringDelete = deleteResult.errors;
            logger.info(`BG [${syncId}]: Deletion result - Deleted: ${deleteResult.deleted}, Errors: ${deleteResult.errors}`);

            if (GCalAPIErrorsDuringDelete > 0) {
                showNotificationRef(notificationTitle, `Lỗi khi xóa ${GCalAPIErrorsDuringDelete} lịch cũ. Tiếp tục thêm mới...`, 'basic', `${syncId}-delete-err`);
            } else if (deletedEventCount > 0) {
                 // Không cần thông báo riêng, sẽ gộp vào thông báo cuối
            }
        } else {
            logger.info(`BG [${syncId}]: No old extension events found in GCal for this week to delete.`);
        }

        if (scheduleList.length === 0) {
            let msg = `Tuần ${weekStartDate}-${weekEndDate}: Không có sự kiện mới từ MyUEL.`;
            if (deletedEventCount > 0) msg += ` Đã xóa ${deletedEventCount} lịch cũ.`;
            if (GCalAPIErrorsDuringDelete > 0) msg += ` Lỗi xóa ${GCalAPIErrorsDuringDelete} lịch cũ.`;
            finalStatus = { status: "success", message: msg };
            showNotificationRef(notificationTitle + (GCalAPIErrorsDuringDelete > 0 ? " - Có lỗi" : " - Xong"), finalStatus.message, 'basic', `${syncId}-no-new-ev`);
            const endTime = Date.now();
            safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);
            return;
        }

        // Sau khi xóa, fetch lại những sự kiện còn lại của extension trong tuần đó
        // để đảm bảo không thêm trùng nếu có lỗi xóa hoặc lịch không đổi
        logger.info(`BG [${syncId}]: (Post-delete) Re-fetching current EXTENSION events to determine what to add...`);
        const currentEventsAfterPotentialDeleteMap = await fetchExistingExtensionEventsWithIds(weekStartDate, weekEndDate, accessToken);
        logger.info(`BG [${syncId}]: Found ${currentEventsAfterPotentialDeleteMap.size} EXTENSION events remaining after delete attempt.`);

        const eventsToAdd = [];
        let skippedDueToExistenceCount = 0;

        for (const eventDataFromMyUEL of scheduleList) { // eventDataFromMyUEL không có prefix
            const eventKeyForComparison = `${eventDataFromMyUEL.subject}|${eventDataFromMyUEL.start_datetime_iso}|${eventDataFromMyUEL.end_datetime_iso}|${(eventDataFromMyUEL.room || '').trim()}`;
            if (!currentEventsAfterPotentialDeleteMap.has(eventKeyForComparison)) {
                eventsToAdd.push(eventDataFromMyUEL);
            } else {
                skippedDueToExistenceCount++;
            }
        }
        logger.info(`BG [${syncId}]: (Post-delete) Filtering done. Events To Add: ${eventsToAdd.length}, Skipped (already exists/failed delete): ${skippedDueToExistenceCount}`);

        let addedCount = 0; let GCalAPIErrorsDuringAdd = 0;
        if (eventsToAdd.length > 0) {
            logger.info(`BG [${syncId}]: Adding ${eventsToAdd.length} events...`);
            showNotificationRef(notificationTitle, `Đang thêm ${eventsToAdd.length} sự kiện mới...`, 'basic', `${syncId}-add`);
            const addResult = await addEventsToCalendar(eventsToAdd, accessToken);
            addedCount = addResult.added;
            GCalAPIErrorsDuringAdd = addResult.errors;
            logger.info(`BG [${syncId}]: Add result - Added: ${addedCount}, Errors: ${GCalAPIErrorsDuringAdd}`);
        } else {
            logger.info(`BG [${syncId}]: No new events to add after deletion and filtering.`);
        }

        let finalMessage = `Tuần ${weekStartDate}-${weekEndDate}: `;
        if (deletedEventCount > 0 || GCalAPIErrorsDuringDelete > 0) {
            finalMessage += `Xóa ${deletedEventCount} (lỗi ${GCalAPIErrorsDuringDelete}). `;
        }
        finalMessage += `Thêm ${addedCount} (lỗi ${GCalAPIErrorsDuringAdd}). Bỏ qua ${skippedDueToExistenceCount}.`;

        const totalErrors = GCalAPIErrorsDuringDelete + GCalAPIErrorsDuringAdd;
        finalStatus = { status: (totalErrors > 0 ? "error" : "success"), message: finalMessage };
        showNotificationRef(notificationTitle + (totalErrors > 0 ? " - Có lỗi" : " - Hoàn thành"), finalMessage, 'basic', `${syncId}-done`);
        const endTime = Date.now();
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);

    } catch (error) {
        logger.error(`BG [${syncId}]: --- SINGLE WEEK SYNC FAILED ---`, error);
        let errorMsg = `Lỗi đồng bộ tuần: ${error?.message || 'Lỗi không xác định.'}`;
        if (error?.status === 401) errorMsg = "Lỗi xác thực Google (401).";
        else if (error?.status === 403) errorMsg = "Lỗi quyền Google Calendar (403).";
        finalStatus = { status: "error", message: errorMsg };
        showNotificationRef(notificationTitle + " - LỖI", errorMsg, 'basic', `${syncId}-fail`);
        await ensureCloseOffscreen();
        const endTime = Date.now();
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);
    } finally {
        await ensureCloseOffscreen();
        logger.info(`BG [${syncId}]: --- Ending Single Week Sync ---`);
    }
}


export async function handleSemesterSync(userId, sendResponse) {
    const syncId = `semSync-${Date.now().toString().slice(-6)}`;
    logger.info(`BG [${syncId}]: --- Starting Semester Sync --- User: ${userId}`);
    let startTime = null;
    let accessToken = null;
    const notificationTitle = "Đồng bộ Học kỳ";
    let overallResult = { added: 0, skipped: 0, errors: 0, weeksProcessed: 0, weeksTotal: 0, weeksWithApiError: 0, deleted: 0, errorsDuringDelete: 0 };
    let finalStatus = { status: "pending", message: "Đang xử lý..." };
    let offscreenDocWasClosed = false;

    const ensureCloseOffscreen = async () => {
        if (!offscreenDocWasClosed) {
            await closeOffscreenDocument();
            offscreenDocWasClosed = true;
        }
    };

    if (typeof sendResponse !== 'function') { /* ... */ return; }

    try {
        const randomDelayMs = getRandomInt(1500, 4000);
        logger.info(`BG [${syncId}]: Applying random start delay: ${randomDelayMs}ms`);
        await delay(randomDelayMs);
        logger.info(`BG [${syncId}]: Random start delay finished.`);

        logger.info(`BG [${syncId}]: Getting Google Auth Token...`);
        showNotificationRef(notificationTitle, "Yêu cầu Google...", 'basic', `${syncId}-auth`);
        accessToken = await forceGoogleLoginAndGetToken(userId, showNotificationRef);
        logger.info(`BG [${syncId}]: Google Auth Token received.`);
        startTime = Date.now();

        logger.info(`BG [${syncId}]: Finding MyUEL tab & getting week options...`);
        showNotificationRef(notificationTitle, "Tìm tab & lấy tuần...", 'basic', `${syncId}-find`);
        const matchingTabs = await chrome.tabs.query({ url: `${constants.MYUEL_TKB_URL_PATTERN}*` });
        if (matchingTabs.length === 0) throw new Error(`Không tìm thấy tab TKB MyUEL. Vui lòng mở tab đó trước.`);
        const targetTabId = matchingTabs[0].id;
        logger.info(`BG [${syncId}]: Target Tab ID: ${targetTabId}`);

        const weekOptionsResult = await executeScriptOnTabRef(targetTabId, getContent_getWeekOptions_Ref, [constants.WEEK_DROPDOWN_ID]);
        if (weekOptionsResult?.error || !Array.isArray(weekOptionsResult)) {
            throw new Error(`Lỗi lấy danh sách tuần: ${weekOptionsResult?.error || 'Dữ liệu không hợp lệ.'}`);
        }
        const weekOptions = weekOptionsResult.filter(opt => opt.value && opt.value !== "-1" && opt.value !== "" && opt.value !== "0");
        if (weekOptions.length === 0) throw new Error("Không tìm thấy tuần hợp lệ trong dropdown.");
        overallResult.weeksTotal = weekOptions.length;
        logger.info(`BG [${syncId}]: Found ${weekOptions.length} valid weeks.`);

        if (weekOptions.length > 1) {
            try {
                logger.debug(`BG [${syncId}]: Pre-selecting week 2 (Value: ${weekOptions[1].value})...`);
                await executeScriptOnTabRef(targetTabId, (dropdownId, weekVal) => {
                    const dropdown = document.getElementById(dropdownId);
                    if (dropdown) { dropdown.value = weekVal; dropdown.dispatchEvent(new Event('change', { bubbles: true }));}
                }, [constants.WEEK_DROPDOWN_ID, weekOptions[1].value]);
                await delay(constants.PRESELECT_WAIT_MS);
                logger.info(`BG [${syncId}]: Pre-select finished.`);
            } catch (e) { logger.error(`BG [${syncId}]: Pre-select script error:`, e); await delay(500); }
        } else { logger.info(`BG [${syncId}]: Skipping pre-select.`); }

        await delay(500);
        showNotificationRef(notificationTitle, "Xác định HK & kiểm tra lịch...", 'basic', `${syncId}-init`);
        // `existingEventsSemesterMap` chứa các sự kiện CỦA EXTENSION trong cả học kỳ
        const { existingEventsSemesterMap, semesterStartDate, semesterEndDate } = await _initializeSemesterSync(targetTabId, weekOptions, accessToken);
        logger.info(`BG [${syncId}]: Semester Init OK. Range: ${semesterStartDate}-${semesterEndDate}. Existing Ext. Events: ${existingEventsSemesterMap.size}`);

        // >>> LOGIC XÓA TOÀN BỘ SỰ KIỆN CŨ CỦA EXTENSION TRONG HỌC KỲ (NẾU MUỐN) <<<
        // Quyết định: Xóa toàn bộ sự kiện (do extension tạo) trong phạm vi học kỳ trước khi xử lý từng tuần.
        // Điều này đảm bảo trạng thái "sạch" nhất.
        const allExtensionEventIdsInSemester = Array.from(existingEventsSemesterMap.values());
        if (allExtensionEventIdsInSemester.length > 0) {
            logger.info(`BG [${syncId}]: Deleting ALL ${allExtensionEventIdsInSemester.length} old EXTENSION events for the entire semester range...`);
            showNotificationRef(notificationTitle, `Đang xóa ${allExtensionEventIdsInSemester.length} lịch cũ của HK...`, 'basic', `${syncId}-del-sem-all`);
            const semesterDeleteResult = await deleteEventsFromCalendar(allExtensionEventIdsInSemester, accessToken);
            overallResult.deleted += semesterDeleteResult.deleted;
            overallResult.errorsDuringDelete += semesterDeleteResult.errors;
            logger.info(`BG [${syncId}]: Semester-wide deletion: Deleted ${semesterDeleteResult.deleted}, Errors ${semesterDeleteResult.errors}`);
            if (semesterDeleteResult.errors > 0) {
                showNotificationRef(notificationTitle, `Lỗi xóa ${semesterDeleteResult.errors} lịch cũ HK. Tiếp tục...`, 'basic', `${syncId}-del-sem-err`);
            }
            // Sau khi xóa toàn bộ, map này không còn giá trị để kiểm tra trùng nữa (vì mọi thứ đã bị xóa)
            // Ta sẽ không dùng existingEventsSemesterMap để lọc nữa, mà coi như mọi sự kiện từ MyUEL đều mới.
            existingEventsSemesterMap.clear(); // Làm rỗng map này
        } else {
             logger.info(`BG [${syncId}]: No old extension events found for the semester range to delete initially.`);
        }
        // >>> KẾT THÚC LOGIC XÓA TOÀN BỘ <<<


        logger.info(`BG [${syncId}]: Starting week processing loop (Inter-week delay: ${constants.INTER_WEEK_DELAY_MS}ms)...`);
        let consecutiveEmptyWeeks = 0;
        for (let i = 0; i < weekOptions.length; i++) {
            const week = weekOptions[i];
            const weekNumStr = `${i + 1}/${overallResult.weeksTotal}`;
            logger.info(`BG [${syncId}]: --- Processing Week ${weekNumStr} (${week.text} / Value: ${week.value}) ---`);
            overallResult.weeksProcessed++;
            offscreenDocWasClosed = false;

            if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) {
                logger.warn(`BG [${syncId}]: Stopping early after ${consecutiveEmptyWeeks} consecutive empty weeks.`);
                showNotificationRef(notificationTitle, `Dừng sớm sau tuần ${i}.`);
                break;
            }
            showNotificationRef(notificationTitle, `Xử lý tuần ${weekNumStr}...`, 'basic', `sem-week-start-${i}`);

            try {
                showNotificationRef(notificationTitle, `(W${weekNumStr}) Lấy dữ liệu...`, 'basic', `sem-get-${i}`);
                logger.debug(`BG [${syncId}]: W${weekNumStr} - Getting data...`);
                const extractedData = await executeScriptOnTabRef(targetTabId, getContent_selectWeekAndGetData_Ref, [
                    constants.WEEK_DROPDOWN_ID, week.value, constants.TIMETABLE_TABLE_ID_STRING, constants.DATE_SPAN_ID_STRING
                ]);
                if (!extractedData || extractedData.error) { throw new Error(extractedData?.error || `Lỗi lấy dữ liệu W${weekNumStr}.`); }
                if (!extractedData.timetableHtml || !extractedData.dateRangeText) { throw new Error(`Thiếu HTML/Date W${weekNumStr}.`); }
                logger.info(`BG [${syncId}]: W${weekNumStr} - Data received OK.`);

                showNotificationRef(notificationTitle, `(W${weekNumStr}) Phân tích...`, 'basic', `sem-parse-${i}`);
                logger.info(`BG [${syncId}]: W${weekNumStr} - Parsing...`);
                const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText);
                if (parseResult.error) throw new Error(`Lỗi phân tích W${weekNumStr}: ${parseResult.error}`);
                const { scheduleList: scheduleListForWeek, weekStartDate: currentWeekStart, weekEndDate: currentWeekEnd } = parseResult;
                logger.info(`BG [${syncId}]: W${weekNumStr} (${currentWeekStart}-${currentWeekEnd}) - Parsed ${scheduleListForWeek.length} events.`);
                await ensureCloseOffscreen();

                if (scheduleListForWeek.length === 0) {
                    consecutiveEmptyWeeks++;
                    logger.info(`BG [${syncId}]: W${weekNumStr} - Tuần trống. Empty streak: ${consecutiveEmptyWeeks}.`);
                } else {
                    consecutiveEmptyWeeks = 0;
                    // Vì đã xóa toàn bộ sự kiện của extension ở đầu học kỳ,
                    // nên mọi sự kiện trong scheduleListForWeek bây giờ đều được coi là cần thêm.
                    const eventsToAdd = scheduleListForWeek; // Không cần lọc lại với existingEventsSemesterMap nữa
                    overallResult.skipped += 0; // Không có gì để skip dựa trên logic cũ nữa.

                    logger.info(`BG [${syncId}]: W${weekNumStr} - Events To Add (after semester-wide delete): ${eventsToAdd.length}`);

                    if (eventsToAdd.length > 0) {
                        showNotificationRef(notificationTitle, `(W${weekNumStr}) Thêm ${eventsToAdd.length}...`, 'basic', `sem-add-${i}`);
                        logger.info(`BG [${syncId}]: W${weekNumStr} - Adding ${eventsToAdd.length} events...`);
                        const addResult = await addEventsToCalendar(eventsToAdd, accessToken);
                        overallResult.added += addResult.added;
                        overallResult.errors += addResult.errors; // Gộp lỗi thêm vào lỗi chung
                        if (addResult.errors > 0) overallResult.weeksWithApiError++;
                        logger.info(`BG [${syncId}]: W${weekNumStr} - Add result: Added ${addResult.added}, Errors ${addResult.errors}`);
                    } else {
                        logger.info(`BG [${syncId}]: W${weekNumStr} - No new events to add.`);
                    }
                }
            } catch (weekError) {
                logger.error(`BG [${syncId}]: --- ERROR PROCESSING WEEK ${weekNumStr} ---`, weekError);
                overallResult.errors++;
                consecutiveEmptyWeeks++;
                showNotificationRef(notificationTitle + "-Lỗi Tuần", `Lỗi tuần ${weekNumStr}: ${weekError.message.substring(0, 100)}...`, 'basic', `sem-err-${i}`);
                await ensureCloseOffscreen();
                const errorMessage = weekError?.message || ''; const errorStatus = weekError?.status;
                if (errorStatus === 401 || errorStatus === 403 || errorMessage.includes("Token")) {
                    logger.warn(`BG [${syncId}]: Critical error. Halting semester sync.`); throw weekError;
                } else { logger.warn(`BG [${syncId}]: Non-critical week error. Continuing...`);}
            }
            // showNotificationRef(notificationTitle, `Hoàn thành tuần ${weekNumStr}.`, 'basic', `sem-week-done-${i}`); // Có thể bỏ bớt thông báo này
            logger.debug(`BG [${syncId}]: Delaying ${constants.INTER_WEEK_DELAY_MS}ms before next week...`);
            await delay(constants.INTER_WEEK_DELAY_MS);
        }
        logger.info(`BG [${syncId}]: Semester week processing loop finished.`);

        let processedCount = overallResult.weeksProcessed;
        let stoppedEarlyMsg = "";
        if (consecutiveEmptyWeeks >= constants.CONSECUTIVE_EMPTY_WEEKS_LIMIT) {
             processedCount = Math.max(0, overallResult.weeksProcessed - consecutiveEmptyWeeks);
             stoppedEarlyMsg = ` (Dừng sớm)`;
        }

        let finalMessage = `Đồng bộ HK xong! (${processedCount}/${overallResult.weeksTotal} tuần). `;
        if(overallResult.deleted > 0 || overallResult.errorsDuringDelete > 0) {
            finalMessage += `Xóa ${overallResult.deleted} (lỗi ${overallResult.errorsDuringDelete}) lịch cũ toàn HK. `;
        }
        finalMessage += `Thêm: ${overallResult.added}. Lỗi thêm/tuần: ${overallResult.errors}.`; // Gộp lỗi thêm/tuần vào chung
        // Bỏ qua: ${overallResult.skipped} đã bị loại bỏ
        if (overallResult.weeksWithApiError > 0) finalMessage += ` (${overallResult.weeksWithApiError} tuần lỗi API)`;
        finalMessage += stoppedEarlyMsg;
        logger.info(`BG [${syncId}]: Final Summary: ${finalMessage}`);

        const totalAllErrors = overallResult.errors + overallResult.errorsDuringDelete;
        if (totalAllErrors > 0) {
            finalStatus = { status: "error", message: finalMessage };
            showNotificationRef(notificationTitle + " - Có lỗi", finalMessage, 'basic', `sem-done-error`);
        } else {
            finalStatus = { status: "success", message: finalMessage };
            showNotificationRef(notificationTitle + " - Thành công", finalMessage, 'basic', `sem-done-ok`);
        }
        const endTime = Date.now();
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);

    } catch (error) {
        logger.error(`BG [${syncId}]: --- SEMESTER SYNC FAILED (Outer Catch) ---`, error);
        let errorMsg = `Lỗi nghiêm trọng ĐB HK: ${error?.message || 'Lỗi không xác định.'}`;
        if (error?.status === 401) errorMsg = "Lỗi xác thực Google (401). Vui lòng thử lại.";
        else if (error?.status === 403) errorMsg = "Lỗi quyền Google Calendar (403). Kiểm tra quyền.";
        else if (error.message.includes("Tab TKB MyUEL")) errorMsg = error.message;
        else if (error.message.includes("initialization failed")) errorMsg = error.message;

        finalStatus = { status: "error", message: errorMsg };
        showNotificationRef(notificationTitle + " - LỖI NGHIÊM TRỌNG", errorMsg, 'basic', `sem-fail-critical`);
        const endTime = Date.now();
        await ensureCloseOffscreen();
        safeSendResponse(sendResponse, finalStatus, startTime ? ((endTime - startTime) / 1000).toFixed(1) : null, syncId, startTime);

    } finally {
        await ensureCloseOffscreen();
        logger.info(`BG [${syncId}]: --- Ending Semester Sync ---`);
    }
}