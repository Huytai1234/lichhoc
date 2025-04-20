// background.js - V4.2.1 - Restore Working Base + Reduced Delay ONLY

// Constants
const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId=';
const WEEK_DROPDOWN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan";
const TIMETABLE_TABLE_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu";
const DATE_SPAN_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate";
let GOOGLE_CLIENT_ID = '';
let GOOGLE_SCOPES = '';
const AVAILABLE_EVENT_COLORS = ["1", "2", "3", "4", "5", "6", "7", "9", "10", "11"];
const GOOGLE_API_BASE = 'https://www.googleapis.com';
const CALENDAR_API_BASE = `${GOOGLE_API_BASE}/calendar/v3`;
const VIETNAM_TIMEZONE_OFFSET = "+07:00";
const VIETNAM_TIMEZONE_IANA = "Asia/Ho_Chi_Minh";
const OFFSCRREN_DOCUMENT_PATH = 'offscreen.html';
const INTER_WEEK_DELAY_MS = 250; // <<< CHỈ TỐI ƯU DELAY NÀY <<<
const CONSECUTIVE_EMPTY_WEEKS_LIMIT = 4;

// Logger setup
const logger = {
    info: (...args) => console.log("[BACKGROUND INFO]", new Date().toISOString(), ...args),
    warn: (...args) => console.warn("[BACKGROUND WARN]", new Date().toISOString(), ...args),
    error: (...args) => console.error("[BACKGROUND ERROR]", new Date().toISOString(), ...args),
    debug: (...args) => console.debug("[BACKGROUND DEBUG]", new Date().toISOString(), ...args)
};

// Load Manifest Config
try {
    logger.debug("BG INIT: Reading manifest...");
    const manifest = chrome.runtime.getManifest();
    logger.debug("BG INIT: Manifest read.");
    GOOGLE_CLIENT_ID = manifest?.oauth2?.client_id;
    GOOGLE_SCOPES = manifest?.oauth2?.scopes?.join(' ');
    logger.debug("BG INIT: ClientID from manifest:", GOOGLE_CLIENT_ID);
    logger.debug("BG INIT: Scopes from manifest:", GOOGLE_SCOPES);
    if (!GOOGLE_CLIENT_ID || !GOOGLE_SCOPES || GOOGLE_CLIENT_ID.includes("YOUR_")) {
        logger.error("BG INIT: Invalid/Missing Client ID or Scopes in manifest.");
        throw new Error("Client ID/Scopes chưa cấu hình đúng trong manifest.json");
    }
    logger.info("[BACKGROUND INIT] Loaded Client ID:", GOOGLE_CLIENT_ID);
} catch (e) {
    logger.error("BG ERROR: Init manifest reading failed.", e);
}

// --- Offscreen Document Helpers ---
let creatingOffscreenDocument = null;
async function hasOffscreenDocument() { try { const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCRREN_DOCUMENT_PATH)] }); return !!contexts?.length; } catch (err) { logger.error("BG Offscreen: Error checking contexts:", err); return false; } }
async function setupOffscreenDocument() { if (await hasOffscreenDocument()) { logger.debug("BG Offscreen: Doc exists."); return; } if (creatingOffscreenDocument) { logger.debug("BG Offscreen: Waiting create promise..."); try { await creatingOffscreenDocument; } catch(err){} return; } logger.info("BG Offscreen: Creating document..."); creatingOffscreenDocument = chrome.offscreen.createDocument({ url: OFFSCRREN_DOCUMENT_PATH, reasons: [chrome.offscreen.Reason.DOM_PARSER], justification: 'Parse timetable HTML' }); try { await creatingOffscreenDocument; logger.info("BG Offscreen: Doc created."); } catch (error) { logger.error("BG Offscreen: Create failed:", error); } finally { creatingOffscreenDocument = null; } }
 async function closeOffscreenDocument() { if (!(await hasOffscreenDocument())) { logger.debug("BG Offscreen: No doc to close."); return; } try { logger.info("BG Offscreen: Closing document..."); await chrome.offscreen.closeDocument(); logger.info("BG Offscreen: Close attempt finished."); } catch (err) { logger.error("BG Offscreen: Error closing doc:", err); } }
 async function parseHtmlViaOffscreen(timetableHtml, dateRangeText) { const offscreenParseId = `offParse-${Date.now()}`; logger.debug(`BG Offscreen [${offscreenParseId}]: Requesting parse...`); await setupOffscreenDocument(); const TIMEOUT_MS = 15000; let response = null; let timeoutId = null; try { response = await Promise.race([ chrome.runtime.sendMessage({ type: 'parse-html-offscreen', target: 'offscreen', data: { timetableHtml, dateRangeText } }), new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error(`Timeout (${TIMEOUT_MS}ms)`)), TIMEOUT_MS); }) ]); clearTimeout(timeoutId); logger.debug(`BG Offscreen [${offscreenParseId}]: Received response:`, response); if (response?.error) throw new Error(`Offscreen Parser Error: ${response.error}`); if (!response?.scheduleList || !response.weekStartDate || !response.weekEndDate) throw new Error("Invalid response structure from Offscreen Parser."); return response; } catch (error) { clearTimeout(timeoutId); logger.error(`BG Offscreen [${offscreenParseId}]: Error during parseHtmlViaOffscreen:`, error); throw new Error(`Offscreen Comm/Parse Error: ${error.message}`); } }

// --- Notification Function ---
function showNotification(title, message, type = 'basic', idSuffix = Date.now().toString()) { const notificationId = `uel-sync-notif-${idSuffix}`; let iconUrl = 'icon.png'; logger.debug(`BG Notif [${idSuffix}]: Showing: Title='${title}', Msg='${message.substring(0, 100)}...'`); chrome.notifications.create(notificationId, { type: 'basic', iconUrl: iconUrl, title: title, message: message, priority: 1 }, (createdId) => { if (chrome.runtime.lastError) logger.error(`BG Notif [${idSuffix}]: Create Error:`, chrome.runtime.lastError?.message); }); }

// --- Google Auth Function (forceGoogleLoginAndGetToken - V3) ---
function forceGoogleLoginAndGetToken(userIdHint) { /* ... (Giữ nguyên phiên bản V3 đã hoạt động tốt) ... */ const authUniqueId = `auth-${Date.now()}`; logger.info(`BG AUTH [${authUniqueId}]: --- ENTERING forceGoogleLoginAndGetToken V3 ---`); logger.debug(`BG AUTH [${authUniqueId}]: Hint: ${userIdHint}`); return new Promise((resolve, reject) => { logger.debug(`BG AUTH [${authUniqueId}]: Inside Promise V3.`); if (!GOOGLE_CLIENT_ID || !GOOGLE_SCOPES || GOOGLE_CLIENT_ID.includes("YOUR_")) { const errorMsg = "BG AUTH FATAL V3: Client ID/Scopes invalid/missing."; logger.error(`BG AUTH [${authUniqueId}]: ${errorMsg}`); showNotification("Lỗi Cấu Hình Auth", errorMsg, 'error', `cfg_fatal_${authUniqueId}`); return reject(new Error(errorMsg)); } logger.debug(`BG AUTH [${authUniqueId}]: Config check OK.`); let finalAuthUrl; try { logger.debug(`BG AUTH [${authUniqueId}]: Getting extension ID...`); const extensionId = chrome.runtime.id; if (!extensionId) throw new Error("Cannot get Extension ID."); logger.debug(`BG AUTH [${authUniqueId}]: Ext ID: ${extensionId}`); const specificRedirectUri = `https://${extensionId}.chromiumapp.org/google`; logger.info(`BG AUTH [${authUniqueId}]: Redirect URI: ${specificRedirectUri}`); const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth'); authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID); authUrl.searchParams.set('response_type', 'token'); authUrl.searchParams.set('redirect_uri', specificRedirectUri); authUrl.searchParams.set('scope', GOOGLE_SCOPES); authUrl.searchParams.set('prompt', 'consent select_account'); if (userIdHint) authUrl.searchParams.set('login_hint', userIdHint); finalAuthUrl = authUrl.toString(); logger.info(`BG AUTH [${authUniqueId}]: Auth URL Built (start): ${finalAuthUrl.substring(0, 200)}...`); } catch (setupError) { logger.error(`BG AUTH [${authUniqueId}]: Sync setup error:`, setupError); return reject(new Error(`Setup Auth URL Error: ${setupError.message}`)); } logger.debug(`BG AUTH [${authUniqueId}]: PREP CALL launchWebAuthFlow...`); try { logger.debug(`BG AUTH [${authUniqueId}]: CALLING launchWebAuthFlow NOW...`); chrome.identity.launchWebAuthFlow({ url: finalAuthUrl, interactive: true }, (redirectUrl) => { logger.info(`BG AUTH [${authUniqueId}]: --- launchWebAuthFlow CALLBACK START ---`); const lastError = chrome.runtime.lastError; logger.debug(`BG AUTH [${authUniqueId}]: Callback - lastError:`, lastError); logger.debug(`BG AUTH [${authUniqueId}]: Callback - redirectUrl:`, redirectUrl); if (lastError || !redirectUrl) { const errorMsg = lastError?.message || "Auth failed/cancelled (No URL)."; logger.error(`BG AUTH [${authUniqueId}]: Callback - FAILED/Cancelled. Msg: ${errorMsg}`); return reject(new Error(errorMsg)); } logger.info(`BG AUTH [${authUniqueId}]: Callback - Auth OK, processing URL...`); try { const fragmentIndex = redirectUrl.indexOf('#'); if (fragmentIndex === -1) { logger.error(`BG AUTH [${authUniqueId}]: Callback - No fragment!`); return reject(new Error("Callback - No fragment (#) in URL.")); } const params = new URLSearchParams(redirectUrl.substring(fragmentIndex + 1)); const accessToken = params.get('access_token'); const errorParam = params.get('error'); logger.debug(`BG AUTH [${authUniqueId}]: Callback - Parsed params:`, Object.fromEntries(params)); if (errorParam) { logger.error(`BG AUTH [${authUniqueId}]: Callback - Google error param: ${errorParam}`); return reject(new Error(`Callback - Google Error: ${errorParam}`)); } if (!accessToken) { logger.error(`BG AUTH [${authUniqueId}]: Callback - No access_token found!`); return reject(new Error("Callback - No access_token in fragment.")); } logger.info(`BG AUTH [${authUniqueId}]: Callback - Access Token OK! Resolving promise.`); resolve(accessToken); } catch (parseError) { logger.error(`BG AUTH [${authUniqueId}]: Callback - Parse fragment error:`, parseError); return reject(new Error("Callback - Error processing fragment.")); } finally { logger.info(`BG AUTH [${authUniqueId}]: CALLBACK END`); } }); logger.debug(`BG AUTH [${authUniqueId}]: Called launchWebAuthFlow, WAITING...`); } catch (launchError) { logger.error(`BG AUTH [${authUniqueId}]: Sync error calling launchWebAuthFlow API:`, launchError); return reject(new Error(`Error calling launchWebAuthFlow: ${launchError.message}`)); } }); }

// --- Delay Function ---
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- Script Injection Function ---
async function executeScriptOnTab(tabId, targetScript, args = []) { let scriptTarget; if (typeof targetScript === 'function') { scriptTarget = { func: targetScript, args: args }; } else if (typeof targetScript === 'string' && targetScript.endsWith('.js')) { scriptTarget = { files: [targetScript] }; } else if (typeof targetScript === 'string') { if (targetScript === 'getContent_getWeekOptions') scriptTarget = { func: getContent_getWeekOptions, args: args }; else if (targetScript === 'getContent_selectWeekAndGetData') scriptTarget = { func: getContent_selectWeekAndGetData, args: args }; else { logger.warn(`BG Scripting: Assuming string '${targetScript}' is file.`); scriptTarget = { files: [targetScript] }; } } else { throw new Error(`Invalid target script type: ${typeof targetScript}`); } const injection = { target: { tabId: tabId }, world: "MAIN", ...scriptTarget }; logger.debug(`BG Scripting: Executing on tab ${tabId}`, injection); try { const results = await chrome.scripting.executeScript(injection); logger.debug(`BG Scripting: Raw result tab ${tabId}:`, results); if (!results || results.length === 0) { logger.warn(`BG Scripting: No result frame tab ${tabId}.`); return null; } if (results[0].error) { logger.error(`BG Scripting: Frame script error:`, results[0].error); throw new Error(`Frame script error: ${results[0].error.message || results[0].error}`); } logger.debug(`BG Scripting: Script result frame 0:`, results[0].result); return results[0].result; } catch (err) { logger.error(`BG Scripting: Inject/Exec error tab ${tabId}:`, err); let errMsg = err.message || "Unknown script inject error"; /*...*/ throw new Error(`Script injection/execution failed: ${errMsg}`); } }

// --- Functions to be Injected ---
function getContent_getWeekOptions(dropdownId) { /* ... (Giữ nguyên) ... */ console.log('[CS getContent_getWeekOptions] Running...');const weekDropdown=document.getElementById(dropdownId);if(!weekDropdown){console.error(`[CS] Dropdown ID '${dropdownId}' not found!`);return {error:`Dropdown ID '${dropdownId}' không thấy!`};} const options=[];for (let i=0; i < weekDropdown.options.length; i++){const option=weekDropdown.options[i];if(option.value&&option.value!=="-1"&&option.value!==""&&option.value!=="0") options.push({value:option.value, text:option.text});} console.log(`[CS] Found ${options.length} weeks.`); return options; }
async function getContent_selectWeekAndGetData(dropdownId, weekValue, tableId, dateId) { /* ... (Giữ nguyên) ... */ console.log(`[CS getContent_selectWeekAndGetData] Selecting: ${weekValue}`);const weekDropdown=document.getElementById(dropdownId);const initialTable=document.getElementById(tableId);const initialDateSpan=document.getElementById(dateId);if(!weekDropdown||!initialTable||!initialDateSpan){let missing=[];if(!weekDropdown)missing.push(dropdownId);if(!initialTable)missing.push(tableId);if(!initialDateSpan)missing.push(dateId);console.error("[CS] Missing initial:", missing);return {error:`Thiếu phần tử: ${missing.join(', ')}`};} const oldDateText=initialDateSpan.innerText.trim();weekDropdown.value=weekValue;console.log("[CS] Dispatching 'change'...");weekDropdown.dispatchEvent(new Event('change',{bubbles:true}));const checkInterval=300;const timeoutMs=8000;const endTime=Date.now()+timeoutMs;let dateChanged=false;let waitedTime=0;console.log(`[CS Wait] Waiting date from "${oldDateText}"`);while(Date.now()<endTime){await new Promise(r => setTimeout(r,checkInterval));waitedTime+=checkInterval;const currentDateSpan=document.getElementById(dateId);if(!currentDateSpan){console.warn("[CS Wait] Date span gone.");continue;} const newDateText=currentDateSpan.innerText.trim();if(newDateText&&newDateText!==oldDateText){console.log(`[CS Wait] Date changed after ${waitedTime}ms.`);dateChanged=true;break;}} if(!dateChanged)console.warn(`[CS Wait] Timeout.`);await new Promise(r => setTimeout(r,300));const finalTable=document.getElementById(tableId);const finalDateSpan=document.getElementById(dateId);if(!finalTable||!finalDateSpan){console.error("[CS] Final elements lost.");return {error:"Phần tử TKB/ngày mất sau chờ."};} const timetableHtml=finalTable.outerHTML;const dateRangeText=finalDateSpan.innerText.trim();if(!timetableHtml||!dateRangeText){console.error("[CS] Final extract fail.");return {error:"Không lấy được HTML/ngày cuối."};} console.log(`[CS] Extracted OK. Date: ${dateRangeText}`);return {timetableHtml, dateRangeText}; }

// --- Helper parse LocalDate ---
function parseLocalDate(dateString) { const parts = dateString.split('/'); if (parts.length !== 3) return null; const day = parseInt(parts[0], 10); const month = parseInt(parts[1], 10) - 1; const year = parseInt(parts[2], 10); if (isNaN(day) || isNaN(month) || isNaN(year) || month < 0 || month > 11 || day < 1 || day > 31) return null; const date = new Date(year, month, day); if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null; return date; }

// --- Google Calendar API Helpers ---
async function fetchGoogleApi(url, method, accessToken, body = null) { const fetchId = `gapi-${Date.now()}`; logger.debug(`GAPI [${fetchId}]> ${method} ${url.substring(0,100)}...`); if (!accessToken) { logger.error(`GAPI [${fetchId}] ERROR: No accessToken.`); throw new Error("Thiếu access token GAPI."); } const options = { method: method, headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }; if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) { options.body = JSON.stringify(body); logger.debug(`GAPI [${fetchId}] Body size: ${options.body.length}`); } try { const response = await fetch(url, options); logger.debug(`GAPI [${fetchId}]< Status ${response.status}`); if (!response.ok) { let errorData = null; let errorText = ''; try { errorData = await response.json(); logger.error(`GAPI [${fetchId}] Err Body:`, errorData); } catch (e) { try { errorText = await response.text(); } catch (e2) {} logger.error(`GAPI [${fetchId}] Err Status: ${response.status}. Non-JSON: ${errorText}`); } const errorMsg = errorData?.error?.message || `HTTP ${response.status} - ${errorText || response.statusText}`; const apiError = new Error(errorMsg); apiError.status = response.status; apiError.data = errorData; throw apiError; } if (response.status === 204) { logger.debug(`GAPI [${fetchId}] 204 No Content.`); return {}; } const data = await response.json(); return data; } catch (error) { logger.error(`GAPI [${fetchId}] FETCH ERROR for ${method}:`, error); if (!(error instanceof Error)) { throw new Error(`Unknown GAPI fetch err: ${JSON.stringify(error)}`); } throw error; } }
async function fetchExistingCalendarEvents(startDateStr, endDateStr, accessToken) { /* ... (Giữ nguyên phiên bản V4.2 với logging chi tiết) ... */ const fetchExistingId = `fetchExist-${Date.now()}`; logger.info(`GAPI Events [${fetchExistingId}]: --- ENTERING fetchExisting... ---`); logger.debug(`GAPI Events [${fetchExistingId}]: Inputs - Start='${startDateStr}', End='${endDateStr}', Token?=${!!accessToken}`); const existingEventsSet = new Set(); try { logger.debug(`GAPI Events [${fetchExistingId}]: Parsing dates...`); const startDtObj = parseLocalDate(startDateStr); const endDtObj = parseLocalDate(endDateStr); if (!startDtObj || !endDtObj) { logger.error(`GAPI Events [${fetchExistingId}]: Invalid dates!`); throw new Error(`Invalid dates: ${startDateStr} - ${endDateStr}`); } logger.debug(`GAPI Events [${fetchExistingId}]: Dates OK.`); startDtObj.setHours(0,0,0,0); endDtObj.setHours(23,59,59,999); const timeMin = new Date(Date.UTC(startDtObj.getFullYear(),startDtObj.getMonth(),startDtObj.getDate(),0,0,0)).toISOString(); const timeMax = new Date(Date.UTC(endDtObj.getFullYear(),endDtObj.getMonth(),endDtObj.getDate(),23,59,59,999)).toISOString(); logger.debug(`GAPI Events [${fetchExistingId}]: Query UTC ISO: ${timeMin} to ${timeMax}`); const eventsListUrl = new URL(`${CALENDAR_API_BASE}/calendars/primary/events`); eventsListUrl.searchParams.set('timeMin', timeMin); eventsListUrl.searchParams.set('timeMax', timeMax); eventsListUrl.searchParams.set('singleEvents', 'true'); eventsListUrl.searchParams.set('maxResults', '250'); eventsListUrl.searchParams.set('orderBy', 'startTime'); logger.debug(`GAPI Events [${fetchExistingId}]: Query URL base: ${eventsListUrl.toString()}`); let nextPageToken = null; let totalEventsFetched = 0; let pageNum = 1; do { logger.debug(`GAPI Events [${fetchExistingId}]: Fetching page ${pageNum} (Token: ${nextPageToken||'None'})...`); const currentUrl = new URL(eventsListUrl.toString()); if (nextPageToken) { currentUrl.searchParams.set('pageToken', nextPageToken); } logger.debug(`GAPI Events [${fetchExistingId}]: Awaiting fetchGAPI pg ${pageNum}...`); const responseData = await fetchGoogleApi(currentUrl.toString(), 'GET', accessToken); logger.debug(`GAPI Events [${fetchExistingId}]: fetchGAPI returned pg ${pageNum}. Resp?=${!!responseData}`); const items = responseData?.items || []; totalEventsFetched += items.length; logger.debug(`GAPI Events [${fetchExistingId}]: Page ${pageNum} got ${items.length}. Total: ${totalEventsFetched}`); for (const item of items) { const summary=item.summary||""; const startISO=item.start?.dateTime; const endISO=item.end?.dateTime; const location=(item.location||"").trim(); if (summary&&startISO&&endISO) { const eventKey=`${summary}|${startISO}|${endISO}|${location}`; existingEventsSet.add(eventKey); } } nextPageToken = responseData?.nextPageToken; logger.debug(`GAPI Events [${fetchExistingId}]: Next token pg ${pageNum}: ${nextPageToken||'None'}`); pageNum++; } while (nextPageToken); logger.info(`GAPI Events [${fetchExistingId}]: Fetch finished. Set size: ${existingEventsSet.size}. Items processed: ${totalEventsFetched}`); return existingEventsSet; } catch (error) { logger.error(`GAPI Events [${fetchExistingId}]: ERROR fetchExisting:`, error); throw new Error(`Lỗi lấy sự kiện GCal: ${error.message}`); } finally { logger.info(`GAPI Events [${fetchExistingId}]: --- EXITING fetchExisting... (Set size: ${existingEventsSet?.size}) ---`); } }

// --- addEventsToCalendar (PHIÊN BẢN V4.2 - TUẦN TỰ, KHÔNG DÙNG Promise.all) ---
async function addEventsToCalendar(eventsToAdd, accessToken) {
    const addEventsId = `addEventsSEQ-${Date.now()}`; // Đổi ID để nhận biết là tuần tự
    logger.info(`GAPI Events [${addEventsId}]: Adding ${eventsToAdd.length} events sequentially...`);
    let addedCount = 0; let errorCount = 0; const subjectColorMap = {}; let nextColorIndex = 0; const numColors = AVAILABLE_EVENT_COLORS.length;
    const insertUrl = `${CALENDAR_API_BASE}/calendars/primary/events`;

    // *** Vòng lặp tuần tự ***
    for (const eventData of eventsToAdd) {
        try {
            const subjectName = eventData.subject || "Sự kiện KCL";
            // Color assignment - Use pre-assigned color if available
            const colorId = eventData.colorId || (() => {
                let assignedColor = subjectColorMap[subjectName];
                if (!assignedColor) { assignedColor = AVAILABLE_EVENT_COLORS[nextColorIndex % numColors]; subjectColorMap[subjectName] = assignedColor; nextColorIndex++; }
                return assignedColor;
            })();
             const desc = `GV: ${eventData.teacher || 'N/A'}\nCS: ${eventData.location || 'N/A'}${eventData.periods ? `\nTiết: ${eventData.periods}` : ''}\nPhòng: ${eventData.room || 'N/A'}${eventData.description_extra || ''}`;
             const eventBody = {
                 summary: subjectName, location: eventData.room || '', description: desc,
                 start: { dateTime: eventData.start_datetime_iso, timeZone: VIETNAM_TIMEZONE_IANA },
                 end: { dateTime: eventData.end_datetime_iso, timeZone: VIETNAM_TIMEZONE_IANA },
                 colorId: colorId,
                 reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] }
             };
            logger.debug(`GAPI Events [${addEventsId}]: Inserting: ${eventBody.summary} at ${eventBody.start.dateTime}`);
            // *** await từng lệnh gọi ***
            const result = await fetchGoogleApi(insertUrl, 'POST', accessToken, eventBody);
            logger.info(`GAPI Events [${addEventsId}]: Added OK '${subjectName}'. ID: ${result?.id}`);
            addedCount++;
        } catch (error) {
            logger.error(`GAPI Events [${addEventsId}]: Failed to add event '${eventData.subject}':`, error);
            errorCount++;
            // Có thể thêm delay nhỏ nếu gặp lỗi Rate Limit 403
            if (error.status === 403) {
                 logger.warn(`GAPI Events [${addEventsId}]: Hit Rate Limit (403)? Delaying before next...`);
                 await delay(1000); // Chờ 1 giây
             }
        }
        // *** KHÔNG CÓ Promise.all ở đây ***
    } // Kết thúc vòng lặp for

    logger.info(`GAPI Events [${addEventsId}]: Finished sequential add loop. Added: ${addedCount}, Errors: ${errorCount}`);
    return { added: addedCount, errors: errorCount };
}


// --- HÀM XỬ LÝ ĐỒNG BỘ TUẦN (Sử dụng phiên bản addEvents tuần tự) ---
async function handleSingleWeekSync(userId, tabId, sendResponse) {
    console.log(`[handleSingleWeekSync ENTRY V4.2.1] START User: ${userId}, Tab: ${tabId}`);
    const uniqueId = `week-${Date.now()}`; logger.info(`BG [${uniqueId}]: Starting...`);
    // ... (Initial vars and helpers remain the same) ...
    let accessToken = null; const notificationTitle="Đồng bộ Tuần"; let finalStatus = { status:"pending", message:"Đang xử lý..."}; let scheduleList = []; let weekStartDate = ""; let weekEndDate = ""; let resultCounts = { added:0, skipped:0, errors:0 }; let offscreenDocWasClosed = false;
    async function ensureCloseOffscreen() { if (!offscreenDocWasClosed) { logger.debug(`BG [${uniqueId}]: Closing offscreen...`); await closeOffscreenDocument(); offscreenDocWasClosed = true; } } function safeSendResponse(status) { if (typeof sendResponse === 'function'){ try { logger.info(`BG [${uniqueId}]: Sending final response:`, status); sendResponse(status); } catch (e) { logger.warn(`BG [${uniqueId}]: Error sending response:`, e); } } else { logger.warn(`BG [${uniqueId}]: sendResponse invalid.`); } } if(typeof sendResponse !== 'function'){ return; } logger.debug(`BG [${uniqueId}]: sendResponse OK.`); if (!tabId) { safeSendResponse({status:"error", message:"No Tab ID"}); return; }

    try {
        // Step 1: Token
        logger.info(`BG [${uniqueId}]: Getting token...`); showNotification(notificationTitle, "Yêu cầu Google...", 'basic', `week-auth-${uniqueId}`); accessToken = await forceGoogleLoginAndGetToken(userId); if (!accessToken) throw new Error("Token không hợp lệ."); logger.info(`BG [${uniqueId}]: Token OK [Len: ${accessToken.length}]`);
        // Step 2: Get Data
        logger.info(`BG [${uniqueId}]: Getting data...`); showNotification(notificationTitle, "Lấy dữ liệu TKB...", 'basic', `week-scrape-${uniqueId}`); const extractedData = await executeScriptOnTab(tabId, 'content.js'); if (!extractedData || extractedData.error || !extractedData.timetableHtml || !extractedData.dateRangeText) throw new Error(`Lỗi lấy TKB: ${extractedData?.error||'Data invalid'}`); logger.info(`BG [${uniqueId}]: Data OK.`);
        // Step 3: Parse
        logger.info(`BG [${uniqueId}]: Parsing...`); showNotification(notificationTitle, "Phân tích dữ liệu...", 'basic', `week-parse-${uniqueId}`); const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText); scheduleList = parseResult.scheduleList; weekStartDate = parseResult.weekStartDate; weekEndDate = parseResult.weekEndDate; logger.info(`BG [${uniqueId}]: Parsed ${scheduleList.length} events.`); await ensureCloseOffscreen();
        if (scheduleList.length === 0) { /* No events handling */ logger.info(`BG [${uniqueId}]: No events.`); finalStatus={status:"success", message:`Không có sự kiện tuần ${weekStartDate}-${weekEndDate}.`}; showNotification(notificationTitle+" - Xong", finalStatus.message,'success',`noev-${uniqueId}`); safeSendResponse(finalStatus); return; }
        // Step 4: Fetch Existing
        logger.info(`BG [${uniqueId}]: Fetching existing...`); showNotification(notificationTitle, `Kiểm tra lịch...`, 'basic', `week-fetch-${uniqueId}`); const existingEventsSet = await fetchExistingCalendarEvents(weekStartDate, weekEndDate, accessToken); logger.info(`BG [${uniqueId}]: Existing keys OK. Set size: ${existingEventsSet.size}`);
        // Step 5: Filter & Assign Color
        logger.info(`BG [${uniqueId}]: Filtering events...`); const eventsToAdd = []; const subjectColorMap={}; let nextColorIndex=0;
        for (const eventData of scheduleList) { const eventKey = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room||'').trim()}`; if (!existingEventsSet.has(eventKey)) { const subjectName=eventData.subject||"N/A"; let colorId=subjectColorMap[subjectName]; if (!colorId) { colorId=AVAILABLE_EVENT_COLORS[nextColorIndex++ % AVAILABLE_EVENT_COLORS.length]; subjectColorMap[subjectName]=colorId; } eventData.colorId=colorId; eventsToAdd.push(eventData); } else { resultCounts.skipped++; } } logger.info(`BG [${uniqueId}]: Filter done. Add: ${eventsToAdd.length}, Skip: ${resultCounts.skipped}`);
        // Step 6: Add (*** SỬ DỤNG PHIÊN BẢN TUẦN TỰ ***)
        logger.info(`BG [${uniqueId}]: Adding events sequentially...`);
        if (eventsToAdd.length > 0) { showNotification(notificationTitle, `Đang thêm ${eventsToAdd.length}...`, 'basic', `week-add-${uniqueId}`); const addResult = await addEventsToCalendar(eventsToAdd, accessToken); resultCounts.added = addResult.added; resultCounts.errors = addResult.errors; logger.info(`BG [${uniqueId}]: Add result: Added ${resultCounts.added}, Errors ${resultCounts.errors}`); }
        else { logger.info(`BG [${uniqueId}]: No new events.`); }
        // Step 7: Final Status
        logger.info(`BG [${uniqueId}]: Preparing final status...`); let finalMessage = `Tuần ${weekStartDate}-${weekEndDate}: Thêm ${resultCounts.added}, Bỏ qua ${resultCounts.skipped}, Lỗi ${resultCounts.errors}.`;
        if (resultCounts.errors > 0) { finalStatus = { status:"error", message:finalMessage}; showNotification(notificationTitle+" - Lỗi",finalMessage,'error',`done-err-${uniqueId}`);}
        else { finalStatus = { status:"success", message:finalMessage}; showNotification(notificationTitle+" - Xong",finalMessage,'success',`done-ok-${uniqueId}`);}
        safeSendResponse(finalStatus);

    } catch (error) { // Outer Catch
        logger.error(`BG [${uniqueId}]: --- SINGLE WEEK SYNC FAILED ---`); logger.error(`BG [${uniqueId}]: Error Object:`, error); logger.error(`BG [${uniqueId}]: Error Msg: ${error?.message}`);
        let errorMsg = `Lỗi ĐB tuần: ${error?.message || 'Lỗi KXD.'}`; if (error?.status===401) errorMsg="Lỗi xác thực Google (401)."; else if (error?.status===403) errorMsg="Lỗi quyền Google Cal (403).";
        finalStatus = { status: "error", message: errorMsg }; showNotification(notificationTitle + " - LỖI", errorMsg, 'error', `week-error-${uniqueId}`);
        await ensureCloseOffscreen(); safeSendResponse(finalStatus);
    }
}

// --- HÀM XỬ LÝ ĐỒNG BỘ HỌC KỲ (SỬ DỤNG PHIÊN BẢN addEvents tuần tự + Delay đã giảm) ---
async function handleSemesterSync(userId, sendResponse) {
    console.log(`[handleSemesterSync ENTRY V4.2.1] START User: ${userId}`);
    const uniqueId = `sem-${Date.now()}`; logger.info(`BG [${uniqueId}]: Starting...`);
    let accessToken = null; const notificationTitle="Đồng bộ Học kỳ"; let overallResult = { added:0, skipped:0, errors:0, weeksProcessed:0, weeksTotal:0, weeksWithApiError:0 }; let finalStatus = { status:"pending", message:"Đang xử lý..."}; let offscreenDocWasClosed = false;
    async function ensureCloseOffscreen() { if (!offscreenDocWasClosed) { logger.debug(`BG [${uniqueId}]: Closing offscreen...`); await closeOffscreenDocument(); offscreenDocWasClosed = true; } } function safeSendResponse(status) { if (typeof sendResponse === 'function'){ try { logger.info(`BG [${uniqueId}]: Sending final response:`, status); sendResponse(status); } catch (e) { logger.warn(`BG [${uniqueId}]: Error sending response:`, e); } } else { logger.warn(`BG [${uniqueId}]: sendResponse invalid.`); } } if(typeof sendResponse !== 'function'){ return; } logger.debug(`BG [${uniqueId}]: sendResponse OK.`);

    try {
        // Step 1: Token
        logger.info(`BG [${uniqueId}]: Getting token...`); accessToken = await forceGoogleLoginAndGetToken(userId); if (!accessToken) throw new Error("Token không hợp lệ."); logger.info(`BG [${uniqueId}]: Token OK [Len: ${accessToken.length}]`);
        // Step 2&3: Find Tab, Weeks, Pre-select
        logger.info(`BG [${uniqueId}]: Finding tab & getting weeks...`); const matchingTabs = await chrome.tabs.query({ url: MYUEL_TKB_URL_PATTERN + "*" }); if (matchingTabs.length === 0) throw new Error(`Tab TKB không tìm thấy.`); const targetTabId = matchingTabs[0].id; logger.info(`BG [${uniqueId}]: Target Tab: ${targetTabId}`); const weekOptionsResult = await executeScriptOnTab(targetTabId, 'getContent_getWeekOptions', [WEEK_DROPDOWN_ID]); if (!weekOptionsResult || weekOptionsResult.error || !Array.isArray(weekOptionsResult)) throw new Error(`Lỗi lấy tuần: ${weekOptionsResult?.error||'?'}`); const weekOptions = weekOptionsResult.filter(opt=>opt.value && opt.value !== "-1"); if (weekOptions.length === 0) throw new Error("Không có tuần hợp lệ."); overallResult.weeksTotal = weekOptions.length; logger.info(`BG [${uniqueId}]: Found ${weekOptions.length} weeks.`); let consecutiveEmptyWeeks=0; const PRESELECT_WAIT_MS=3500;
        if (weekOptions.length > 1) { try { logger.debug(`BG [${uniqueId}]: Pre-selecting...`); await executeScriptOnTab(targetTabId, (ddId,wVal)=>{const d=document.getElementById(ddId);if(d)d.value=wVal;d.dispatchEvent(new Event('change',{bubbles:true}));}, [WEEK_DROPDOWN_ID, weekOptions[1].value]); await delay(PRESELECT_WAIT_MS); } catch (preSelectError) { logger.error(`BG [${uniqueId}]: Pre-select error:`, preSelectError); await delay(500); } } logger.info(`BG [${uniqueId}]: Pre-select finished.`);

        // Step 4: Week Loop (*** Sử dụng INTER_WEEK_DELAY_MS đã giảm ***)
        logger.info(`BG [${uniqueId}]: Starting week loop (Delay: ${INTER_WEEK_DELAY_MS}ms)...`);
        for (let i = 0; i < weekOptions.length; i++) {
            overallResult.weeksProcessed++; if (consecutiveEmptyWeeks >= CONSECUTIVE_EMPTY_WEEKS_LIMIT) { logger.warn(`BG [${uniqueId}]: Stop early.`); break; } const week = weekOptions[i]; const progressMsg = `Tuần ${i+1}/${weekOptions.length}: ${week.text}`; logger.info(`BG [${uniqueId}]: --- Proc W${i+1} ---`); showNotification(notificationTitle, `Xử lý ${progressMsg}...`, 'basic', `sem-week-${i}-${uniqueId}`); let scheduleListForWeek = [], weekStartDate = "", weekEndDate = "";
            try {
                 // 4a. Get Data
                 logger.debug(`BG [${uniqueId}]: W${i+1} - Getting data...`); const extractedData = await executeScriptOnTab(targetTabId, 'getContent_selectWeekAndGetData', [WEEK_DROPDOWN_ID, week.value, TIMETABLE_TABLE_ID_STRING, DATE_SPAN_ID_STRING]); if (!extractedData || extractedData.error) throw new Error(extractedData?.error || `Lỗi lấy data W${i+1}.`); if (!extractedData.timetableHtml || !extractedData.dateRangeText) throw new Error(`Thiếu HTML/Ngày W${i+1}.`); logger.info(`BG [${uniqueId}]: W${i+1} - Data extracted.`);
                 // 4b. Parse
                 logger.info(`BG [${uniqueId}]: W${i+1} - Parsing...`); showNotification(notificationTitle, `Phân tích ${progressMsg}...`, 'basic', `sem-parse-${i}-${uniqueId}`); const parseResult = await parseHtmlViaOffscreen(extractedData.timetableHtml, extractedData.dateRangeText); scheduleListForWeek = parseResult.scheduleList; weekStartDate = parseResult.weekStartDate; weekEndDate = parseResult.weekEndDate; logger.info(`BG [${uniqueId}]: W${i+1} - Parsed ${scheduleListForWeek.length} events.`); if (scheduleListForWeek.length === 0) consecutiveEmptyWeeks++; else consecutiveEmptyWeeks = 0;
                 // 4c,d,e: API Interaction (*** Sử dụng addEvents tuần tự ***)
                 if (scheduleListForWeek.length > 0) {
                      logger.info(`BG [${uniqueId}]: W${i+1} - Fetching existing...`); showNotification(notificationTitle, `Kiểm tra lịch (W${i+1})...`, 'basic', `sem-fetch-${i}-${uniqueId}`); const existingEventsSet = await fetchExistingCalendarEvents(weekStartDate, weekEndDate, accessToken); logger.info(`BG [${uniqueId}]: W${i+1} - Existing keys: ${existingEventsSet.size}`); const eventsToAdd = []; const subjectColorMap={}; let nextColorIndex=0; let currentSkipped=0;
                      for (const eventData of scheduleListForWeek) { const eventKey = `${eventData.subject}|${eventData.start_datetime_iso}|${eventData.end_datetime_iso}|${(eventData.room||'').trim()}`; if (!existingEventsSet.has(eventKey)) { const subjectName=eventData.subject||"N/A"; let colorId=subjectColorMap[subjectName]; if(!colorId){colorId=AVAILABLE_EVENT_COLORS[nextColorIndex++%AVAILABLE_EVENT_COLORS.length];subjectColorMap[subjectName]=colorId;} eventData.colorId=colorId; eventsToAdd.push(eventData); } else { currentSkipped++; } } overallResult.skipped += currentSkipped; logger.info(`BG [${uniqueId}]: W${i+1} - To add: ${eventsToAdd.length}, Skip: ${currentSkipped}`);
                     if (eventsToAdd.length > 0) {
                          logger.info(`BG [${uniqueId}]: W${i+1} - Adding events sequentially...`); showNotification(notificationTitle, `Thêm ${eventsToAdd.length} (W${i+1})...`, 'basic', `sem-add-${i}-${uniqueId}`);
                          const addResult = await addEventsToCalendar(eventsToAdd, accessToken); // <-- Gọi hàm tuần tự
                          overallResult.added += addResult.added; overallResult.errors += addResult.errors; if (addResult.errors > 0) overallResult.weeksWithApiError++; logger.info(`BG [${uniqueId}]: W${i+1} - Add result: Added ${addResult.added}, Err ${addResult.errors}`);
                     } else { logger.info(`BG [${uniqueId}]: W${i+1} - No new events.`); }
                 } else { logger.info(`BG [${uniqueId}]: W${i+1} - Skip API.`); }
            } catch (weekError) { logger.error(`BG [${uniqueId}]: W${i+1} Error:`, weekError); overallResult.errors++; consecutiveEmptyWeeks++; showNotification(notificationTitle+"-Lỗi Tuần", `Lỗi W${i+1}: ${weekError.message}`, 'error', `sem-err-${i}-${uniqueId}`); if (weekError.message.includes("GCal:") && (weekError.status===401||weekError.status===403)) throw weekError; }
             // <<< SỬ DỤNG DELAY ĐÃ GIẢM >>>
             logger.debug(`BG [${uniqueId}]: Delaying ${INTER_WEEK_DELAY_MS}ms...`);
             await delay(INTER_WEEK_DELAY_MS);
        } // End week loop
        logger.info(`BG [${uniqueId}]: Semester loop finished.`);

       // Final Summary & Response (Logic không đổi)
        // ... (Tạo finalMessage, finalStatus) ...
        let processedCount = overallResult.weeksProcessed - (consecutiveEmptyWeeks >= CONSECUTIVE_EMPTY_WEEKS_LIMIT ? CONSECUTIVE_EMPTY_WEEKS_LIMIT : 0); let finalMessage = `Đồng bộ HK xong! (${processedCount}/${overallResult.weeksTotal} tuần) Thêm: ${overallResult.added}, Skip: ${overallResult.skipped}, Lỗi Thêm: ${overallResult.errors}.`; if (overallResult.weeksWithApiError > 0) finalMessage += ` (${overallResult.weeksWithApiError} tuần lỗi API)`; if (consecutiveEmptyWeeks >= CONSECUTIVE_EMPTY_WEEKS_LIMIT) finalMessage += ` (Dừng sớm)`; logger.info(`BG [${uniqueId}]: Final Summary: ${finalMessage}`); if (overallResult.errors > 0) { finalStatus = { status: "error", message: finalMessage }; showNotification(notificationTitle + " - Có lỗi", finalMessage, 'error', `sem-done-err-${uniqueId}`); } else { finalStatus = { status: "success", message: finalMessage }; showNotification(notificationTitle + " - Thành công", finalMessage, 'success', `sem-done-ok-${uniqueId}`); }
        await ensureCloseOffscreen();
        safeSendResponse(finalStatus);

    } catch (error) { // Outer Catch
        logger.error(`BG [${uniqueId}]: --- SEMESTER SYNC FAILED ---`); logger.error(`BG [${uniqueId}]: Error Object:`, error); logger.error(`BG [${uniqueId}]: Error Msg: ${error?.message}`);
        let errorMsg = `Lỗi nghiêm trọng đồng bộ HK: ${error?.message || 'Unknown error.'}`; /* ... (status handling) ... */ finalStatus = { status: "error", message: errorMsg }; showNotification(notificationTitle + " - LỖI", errorMsg, 'error', `sem-error-final-${uniqueId}`);
        await ensureCloseOffscreen(); safeSendResponse(finalStatus);
    }
}

// --- Listener chính nhận message từ popup.js ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[onMessage Listener] Received:', message); if (message.target === 'offscreen') return false;
    if (message.action === "startSync") { console.log('[Msg List.] Dispatch: handleSingleWeekSync'); const userId=message.userId, tabId=message.tabId; if(!userId||!tabId){console.error('[Msg List.] Args missing startSync.'); try{sendResponse({status:"error",message:"Thiếu ID/Tab."});}catch(e){} return false;} handleSingleWeekSync(userId, tabId, sendResponse); return true; }
    else if (message.action === "startSemesterSync") { console.log('[Msg List.] Dispatch: handleSemesterSync'); const userId=message.userId; if(!userId){console.error('[Msg List.] Args missing startSemesterSync.'); try{sendResponse({status:"error",message:"Thiếu User ID."});}catch(e){} return false;} handleSemesterSync(userId, sendResponse); return true; }
    logger.warn("BG: Unknown action:", message.action); return false;
});

logger.info("Background service worker started. V4.2.1 Restore Sequential Add + Reduced Delay.");