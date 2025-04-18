const FLASK_BACKEND_URL = 'http://localhost:5001';
// !!! QUAN TRỌNG: Đảm bảo pattern này khớp chính xác với phần đầu URL trang TKB MyUEL !!!
const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId='; // <<< KIỂM TRA LẠI GIÁ TRỊ NÀY
// --- ID CỦA CÁC PHẦN TỬ HTML TRÊN TRANG MYUEL (Cần kiểm tra lại) ---
const WEEK_DROPDOWN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan"; // <<< ID ĐÚNG LÀ ddlTuan
// --- Định nghĩa các chuỗi ID để truyền đi ---
const TIMETABLE_TABLE_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu";
const DATE_SPAN_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate";
// -----------------------------------------------------------
let GOOGLE_CLIENT_ID = ''; // Sẽ được đọc từ manifest
let GOOGLE_SCOPES = '';    // Sẽ được đọc từ manifest

try {
    const manifest = chrome.runtime.getManifest();
    // Đọc Client ID và Scopes từ manifest (đã được cập nhật với Client ID mới loại "Web application")
    GOOGLE_CLIENT_ID = manifest?.oauth2?.client_id;
    GOOGLE_SCOPES = manifest?.oauth2?.scopes?.join(' ');
    if (!GOOGLE_CLIENT_ID || !GOOGLE_SCOPES || GOOGLE_CLIENT_ID.includes("YOUR_")) {
        throw new Error("Client ID/Scopes chưa cấu hình đúng trong manifest.json (Hãy dùng Client ID loại Web mới)");
    }
    console.info("[BACKGROUND INIT] Loaded Client ID:", GOOGLE_CLIENT_ID); // Log Client ID được load
} catch (e) {
    console.error("BG ERROR: Init manifest failed.", e);
}
// ---------------

const logger = {
    info: (...args) => console.log("[BACKGROUND INFO]", new Date().toISOString(), ...args),
    warn: (...args) => console.warn("[BACKGROUND WARN]", new Date().toISOString(), ...args),
    error: (...args) => console.error("[BACKGROUND ERROR]", new Date().toISOString(), ...args),
    debug: (...args) => console.debug("[BACKGROUND DEBUG]", new Date().toISOString(), ...args)
};

// --- Hàm Hiển Thị Thông Báo Hệ Thống ---
function showNotification(title, message, type = 'basic', idSuffix = Date.now().toString()) {
     const notificationId = `uel-sync-notif-${idSuffix}`;
     let iconUrl = 'icon.png'; // Đảm bảo file icon.png tồn tại ở thư mục gốc
     logger.debug(`BG: Showing notification: Id=${notificationId}, Title='${title}', Msg='${message}'`);
     chrome.notifications.create(notificationId, { type: 'basic', iconUrl: iconUrl, title: title, message: message, priority: 1 }, (id) => { if (chrome.runtime.lastError) logger.error("BG: Notif Create Error:", chrome.runtime.lastError?.message); else logger.debug("BG: Notification created ID:", id); });
}

// --- Hàm Lấy Google Access Token qua launchWebAuthFlow (ĐÃ SỬA ĐỔI REDIRECT URI) ---
function forceGoogleLoginAndGetToken(userIdHint) {
    logger.info("BG: --- ENTERING forceGoogleLoginAndGetToken (Using Specific Redirect URI) ---");
    logger.debug("BG: >> userIdHint:", userIdHint);
    return new Promise((resolve, reject) => {
        logger.debug("BG: >> Inside forceGoogleLoginAndGetToken Promise.");
        logger.debug(`BG: >> Using GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}`); // Client ID này đã được cập nhật từ manifest
        logger.debug(`BG: >> Using GOOGLE_SCOPES: ${GOOGLE_SCOPES}`);

        // Kiểm tra Client ID và Scopes vẫn quan trọng
        if (!GOOGLE_CLIENT_ID || !GOOGLE_SCOPES || GOOGLE_CLIENT_ID.includes("YOUR_")) {
            const errorMsg = "Chưa cấu hình đúng Client ID (Web application) hoặc Scopes trong manifest.";
            logger.error("BG: >> Validation failed:", errorMsg);
            showNotification("Lỗi Cấu Hình", errorMsg, 'error', 'cfg_err_token');
            return reject(new Error(errorMsg));
        }

        try {
            // <<< --- BẮT ĐẦU SỬA ĐỔI --- >>>
            // Xây dựng Redirect URI cụ thể theo phương pháp bạn yêu cầu
            // KHÔNG dùng chrome.identity.getRedirectURL() nữa
            const extensionId = chrome.runtime.id; // Lấy ID của extension hiện tại đang chạy
            if (!extensionId) {
                // Thêm kiểm tra lỗi nếu không lấy được ID
                logger.error("BG: >> Could not get extension ID.");
                return reject(new Error("Không thể lấy được ID của extension."));
            }
            // Tạo URI chính xác như đã cấu hình trên Google Cloud Console cho Client ID "Web application"
            // Bao gồm cả phần path "/google"
            const specificRedirectUri = `https://${extensionId}.chromiumapp.org/google`;
            logger.info("BG: >> Constructing specific Redirect URI:", specificRedirectUri);
            // <<< --- KẾT THÚC SỬA ĐỔI --- >>>

            // Xây dựng URL xác thực của Google
            const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID); // Sử dụng Client ID mới đã đọc từ manifest
            authUrl.searchParams.set('response_type', 'token'); // Yêu cầu trả về token trực tiếp trong fragment

            // <<< --- SỬA ĐỔI DÒNG NÀY --- >>>
            // Sử dụng URI vừa được xây dựng cụ thể làm redirect_uri
            authUrl.searchParams.set('redirect_uri', specificRedirectUri);
            // <<< --- KẾT THÚC SỬA ĐỔI DÒNG NÀY --- >>>

            authUrl.searchParams.set('scope', GOOGLE_SCOPES);
            authUrl.searchParams.set('prompt', 'consent select_account'); // Luôn yêu cầu chọn tài khoản & chấp thuận
            if (userIdHint) {
                authUrl.searchParams.set('login_hint', userIdHint); // Gợi ý email nếu có
            }
            const finalAuthUrl = authUrl.toString();
            logger.info("BG: >> Launching Web Auth Flow with URL:", finalAuthUrl); // Log URL cuối cùng để kiểm tra

            // Gọi launchWebAuthFlow với URL đã xây dựng
            chrome.identity.launchWebAuthFlow({ url: finalAuthUrl, interactive: true }, (redirectUrl) => {
                // Callback này sẽ được gọi sau khi Google redirect trở lại
                logger.debug("BG: >> launchWebAuthFlow callback executed.");

                if (chrome.runtime.lastError || !redirectUrl) {
                    // Xử lý lỗi nếu người dùng hủy hoặc có lỗi API
                    logger.error("BG: >> launchWebAuthFlow API Error or Cancelled:", chrome.runtime.lastError);
                    reject(new Error(chrome.runtime.lastError?.message || "Xác thực Google thất bại/bị hủy bỏ."));
                } else {
                    // Log lại URL thực tế nhận được từ Google để đối chiếu
                    logger.info("BG: >> Auth flow successful, received redirect URL:", redirectUrl);

                    // Kiểm tra (tùy chọn) xem URL nhận được có bắt đầu đúng không
                    if (!redirectUrl.startsWith(`https:// ${extensionId}.chromiumapp.org/google`)) {
                         logger.warn(`BG: >> WARNING: Received redirect URL "${redirectUrl}" does not exactly match the configured "${specificRedirectUri}". Checking fragment anyway.`);
                         // Thường thì Google sẽ trả về đúng URI đã đăng ký, nhưng có thể thêm # hoặc ?
                     }

                    // Parse URL fragment để lấy token (Logic này vẫn giữ nguyên và đúng)
                    try {
                        const params = new URLSearchParams(redirectUrl.substring(redirectUrl.indexOf('#') + 1));
                        const accessToken = params.get('access_token');
                        const error = params.get('error');
                        logger.debug("BG: >> Parsed params from fragment:", Object.fromEntries(params));
                        if (error) {
                            logger.error("BG: >> Google returned error in fragment:", error);
                            reject(new Error(`Lỗi từ Google: ${error}`));
                        } else if (!accessToken) {
                            logger.error("BG: >> No access token found in fragment:", redirectUrl);
                            reject(new Error("Không tìm thấy access token trong URL trả về."));
                        } else {
                            // Thành công! Trả về access token
                            logger.info("BG: >> Access Token extracted OK.");
                            resolve(accessToken);
                        }
                    } catch (parseError) {
                        logger.error("BG: >> Error parsing redirect URL fragment:", parseError);
                        reject(new Error("Lỗi xử lý URL trả về từ Google."));
                    }
                }
            });
        } catch (error) {
            // Bắt lỗi trong quá trình thiết lập URL hoặc lấy extension ID
            logger.error("BG: >> Error during setup before launchWebAuthFlow:", error);
            reject(new Error(`Lỗi thiết lập xác thực extension: ${error.message}`));
        }
    });
}


// --- Hàm Gọi API Backend Flask ---
// Hàm này không cần thay đổi, nó chỉ sử dụng token đã lấy được
async function fetchBackendWithAuth(endpoint, method = 'GET', accessToken, body = null) {
    if (!accessToken) {
        logger.error("BG: fetchBackend: No accessToken.");
        throw new Error("Thiếu access token.");
    }
    try {
        const options = {
            method: method,
            headers: {
                'Authorization': `Bearer ${accessToken}`, // Gửi token lên backend
                'Content-Type': 'application/json'
            }
        };
        if (body && method !== 'GET' && method !== 'HEAD') {
            options.body = JSON.stringify(body);
        }
        const targetUrl = `${FLASK_BACKEND_URL}${endpoint}`;
        logger.debug(`BG: Fetching: ${method} ${targetUrl}`);
        const response = await fetch(targetUrl, options);
        let responseData = {};
        try {
            responseData = await response.json(); // Cố gắng parse JSON
        } catch (e) {
            // Nếu không phải JSON nhưng response không OK, vẫn ném lỗi HTTP
            if (!response.ok) throw { status: response.status, message: `HTTP Error ${response.status}`};
            // Nếu không phải JSON nhưng response OK, trả về object rỗng hoặc text nếu cần
            // responseData = await response.text(); // Ví dụ nếu backend có thể trả text
        }
        if (!response.ok) {
            logger.error(`BG: Backend Error: ${response.status}`, responseData);
            // Ném lỗi với thông tin từ backend nếu có, hoặc lỗi HTTP chung
            throw { status: response.status, message: responseData?.error || `HTTP Error ${response.status}`, data: responseData };
        }
        logger.info("BG: Backend response OK.");
        return responseData;
    } catch (error) {
        logger.error(`BG: Fetch Error to ${endpoint}:`, error);
        throw error; // Ném lại lỗi để hàm gọi xử lý
    }
}

// --- Hàm DELAY ---
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Hàm inject script và lấy kết quả ---
// Hàm này không cần thay đổi
async function executeScriptOnTab(tabId, funcOrFile, args = []) {
     const target = { tabId: tabId };
     const injection = {};
     if (typeof funcOrFile === 'function') {
         injection.func = funcOrFile;
         injection.args = args;
         injection.world = "MAIN"; // Chạy trong context của trang web
     } else if (typeof funcOrFile === 'string' && funcOrFile.endsWith('.js')) {
         injection.files = [funcOrFile];
     } else {
         throw new Error("Invalid funcOrFile for executeScriptOnTab");
     }
     logger.debug(`BG: Executing script on tab ${tabId}`, injection);
     try {
         const results = await chrome.scripting.executeScript({ target: target, ...injection });
         logger.debug(`BG: Script result raw:`, results);
         if (!results || results.length === 0) {
             // Có thể frame không tồn tại hoặc script không trả về gì
             logger.warn(`BG: Script executed but no result frame returned for tab ${tabId}.`);
             // throw new Error(`Script không trả về kết quả từ frame.`); // Có thể không cần ném lỗi
             return null; // Trả về null thay vì lỗi
         }
         // Kiểm tra lỗi trong kết quả của frame đầu tiên
         if (results[0].error) {
             logger.error(`BG: Frame script execution error:`, results[0].error);
             throw new Error(`Lỗi chạy script trong trang: ${results[0].error.message || results[0].error}`);
         }
         // Trả về kết quả từ frame đầu tiên
         return results[0].result;
     } catch (err) {
         logger.error(`BG: Error executing script on tab ${tabId}:`, err);
         // Ném lỗi để hàm gọi xử lý
         throw new Error(`Lỗi inject hoặc thực thi script: ${err.message}`);
     }
}


// --- Các hàm chạy trong Content Script Context ---
// Các hàm này được định nghĩa ở đây nhưng sẽ được inject vào trang MyUEL
// Chúng không cần thay đổi liên quan đến việc lấy token
function getContent_getWeekOptions(dropdownId) {
     const weekDropdown = document.getElementById(dropdownId);
     if (!weekDropdown) {
         console.error(`[CS] Dropdown ID '${dropdownId}' not found!`);
         return { error: `Dropdown tuần ID '${dropdownId}' không thấy!` };
     }
     const options = [];
     for (let i = 0; i < weekDropdown.options.length; i++) {
         const option = weekDropdown.options[i];
         // Lọc các giá trị không hợp lệ hoặc "Tất cả" nếu cần
         if (option.value && option.value !== "-1" && option.value !== "" && option.value !== "0") {
             options.push({ value: option.value, text: option.text });
         }
     }
     console.log(`[CS] Found ${options.length} valid week options.`);
     return options; // Trả về mảng options
 }

// Hàm này sẽ được inject để chọn tuần, chờ và lấy data
// Không cần thay đổi
async function getContent_selectWeekAndGetData(dropdownId, weekValue, tableId, dateId) {
    console.log(`[CS] Selecting week value: ${weekValue}`);
    const weekDropdown = document.getElementById(dropdownId);
    const timetableTable = document.getElementById(tableId);
    const dateSpan = document.getElementById(dateId);

    if (!weekDropdown || !timetableTable || !dateSpan) {
        let missing = [];
        if (!weekDropdown) missing.push(`Dropdown ID ${dropdownId}`);
        if (!timetableTable) missing.push(`Table ID ${tableId}`);
        if (!dateSpan) missing.push(`Date ID ${dateId}`);
        console.error("[CS] Missing elements:", missing);
        return { error: `Thiếu phần tử HTML cần thiết: ${missing.join(', ')}` };
    }

    const oldDateText = dateSpan.innerText.trim(); // Lưu lại text ngày cũ để so sánh
    weekDropdown.value = weekValue; // Chọn tuần mới
    console.log("[CS] Dispatching 'change' event...");
    weekDropdown.dispatchEvent(new Event('change', { bubbles: true })); // Kích hoạt sự kiện change

    // --- LOGIC CHỜ ĐỢI ĐỘNG ---
    const checkInterval = 300; // ms - Tần suất kiểm tra
    const timeoutMs = 8000; // ms - Thời gian chờ tối đa (8 giây)
    const endTime = Date.now() + timeoutMs;
    let dateChanged = false;
    console.log(`[CS Wait] Waiting for date change from "${oldDateText}" (max ${timeoutMs}ms)`);

    while (Date.now() < endTime) {
        // Lấy lại tham chiếu đến dateSpan phòng trường hợp nó bị thay thế hoàn toàn bởi AJAX
        const currentDateSpan = document.getElementById(dateId);
        if (!currentDateSpan) {
             console.warn("[CS Wait] Date span element disappeared during wait.");
             // Chờ một chút xem nó có xuất hiện lại không
             await new Promise(r => setTimeout(r, checkInterval * 2));
             continue; // Thử lại vòng lặp
        }
        const newDateText = currentDateSpan.innerText.trim();
        // Kiểm tra xem text đã thay đổi và không rỗng
        if (newDateText && newDateText !== oldDateText) {
            console.log(`[CS Wait] Date changed successfully to "${newDateText}". Update detected.`);
            dateChanged = true;
            break; // Thoát vòng lặp chờ
        }
        // Nếu chưa thay đổi, chờ checkInterval rồi kiểm tra lại
        await new Promise(r => setTimeout(r, checkInterval));
    }

    if (!dateChanged) {
        // Nếu hết thời gian chờ mà không thấy thay đổi
        console.warn(`[CS Wait] Timeout waiting for date text to change from "${oldDateText}". Proceeding to extract data anyway.`);
        // Không ném lỗi ở đây, vẫn thử lấy dữ liệu xem sao, có thể trang chỉ cập nhật bảng mà không cập nhật ngày
    }
    // --- KẾT THÚC LOGIC CHỜ ĐỢI ĐỘNG ---

    // Lấy dữ liệu sau khi chờ (hoặc timeout)
    // Lấy lại tham chiếu phòng khi bị thay thế
    const finalTimetableTable = document.getElementById(tableId);
    const finalDateSpan = document.getElementById(dateId);

    // Kiểm tra lại lần cuối trước khi lấy dữ liệu
    if (!finalTimetableTable || !finalDateSpan) {
        console.error("[CS] Timetable table or Date span element not found after wait.");
        return { error: "Phần tử bảng hoặc ngày tháng bị lỗi sau khi chờ cập nhật." };
    }

    const timetableHtml = finalTimetableTable.outerHTML;
    const dateRangeText = finalDateSpan.innerText.trim();

    if (!timetableHtml || !dateRangeText) {
        console.error("[CS] Failed to extract timetable HTML or date range text after wait.");
        return { error: "Không trích xuất được dữ liệu HTML hoặc ngày tháng sau khi chờ." };
    }

    console.log(`[CS] Successfully extracted data for week value ${weekValue}. Date range: ${dateRangeText}`);
    // Trả về dữ liệu dưới dạng object
    return {
        timetableHtml: timetableHtml,
        dateRangeText: dateRangeText
    };
}


// --- HÀM XỬ LÝ ĐỒNG BỘ TUẦN ---
// Hàm này không cần thay đổi logic chính, chỉ gọi forceGoogleLoginAndGetToken đã sửa
async function handleSingleWeekSync(userId, tabId, sendResponse) {
     logger.info(`BG: Starting SINGLE WEEK sync for user: ${userId} on tab ${tabId}`);
     let accessToken = null;
     const notificationTitle = "Đồng bộ Tuần Hiện tại";
     let finalStatus = { status: "error", message: "Lỗi không xác định khi đồng bộ tuần." };

     if (!tabId) {
         logger.error("BG: Missing target tabId for single week sync.");
         finalStatus = { status: "error", message: "Lỗi: Không tìm thấy Tab ID để đồng bộ." };
         showNotification(notificationTitle + " - LỖI", finalStatus.message, 'error', 'week-notabid');
         try { if (typeof sendResponse === 'function') sendResponse(finalStatus); } catch (e) {}
         return;
     }

     try {
         // Bước 1: Lấy Access Token (Hàm này đã được sửa)
         logger.info("BG: (Week) Getting Google access token...");
         showNotification(notificationTitle, "Đang yêu cầu quyền truy cập Google...", 'basic', 'week-auth');
         try {
             accessToken = await forceGoogleLoginAndGetToken(userId); // Gọi hàm đã sửa
             // Token có thể null hoặc undefined nếu có lỗi bên trong forceGoogle...
             if (!accessToken) throw new Error("Không nhận được access token hợp lệ từ Google.");
             logger.info("BG: (Week) Google Token acquired successfully.");
         } catch (tokenError) {
             logger.error(`BG: (Week) FAILED to get Google token:`, tokenError);
             // Ném lại lỗi để khối catch bên ngoài xử lý và thông báo
             throw tokenError; // Đảm bảo lỗi được lan truyền
         }

         // Bước 2: Lấy dữ liệu TKB từ tab hiện tại
         showNotification(notificationTitle, "Đang lấy dữ liệu TKB từ trang MyUEL...", 'basic', 'week-scrape');
         logger.debug("BG: Getting target tab details:", tabId);
         const targetTab = await chrome.tabs.get(tabId);
         if (!targetTab) throw new Error(`Tab với ID ${tabId} không tồn tại.`);

         const currentUrl = targetTab.url;
         logger.info("BG: Target tab URL (Week):", currentUrl || "[No URL]");
         // Kiểm tra URL của tab có đúng là trang TKB không
         if (!currentUrl || !currentUrl.startsWith(MYUEL_TKB_URL_PATTERN)) {
             let urlDesc = currentUrl ? currentUrl.substring(0, 80) + "..." : "Không có URL";
             throw new Error(`Tab hiện tại (${urlDesc}) không phải là trang TKB MyUEL hợp lệ.`);
         }
         logger.info("BG: URL check OK (Week). Injecting content script...");
         const targetTabId = targetTab.id; // ID của tab cần inject

         // Inject content script để lấy HTML bảng và text ngày tháng hiện tại
         let injectionResults;
         try {
             // Inject file content.js để lấy dữ liệu đang hiển thị
             injectionResults = await executeScriptOnTab(targetTabId, 'content.js');
         } catch (scriptError) {
             // Bắt lỗi nếu inject hoặc script chạy lỗi
             throw new Error(`Lỗi inject hoặc thực thi content script (Tuần): ${scriptError.message}`);
         }
         logger.debug("BG: Script inject result (Week):", injectionResults);

         // Kiểm tra kết quả trả về từ content script
         if (!injectionResults) {
             throw new Error("Content script (content.js) không trả về kết quả hoặc bị lỗi (Tuần).");
         }
         const extractedData = injectionResults; // Kết quả trả về trực tiếp
         if (extractedData.error) {
             // Nếu content script trả về lỗi cụ thể
             throw new Error(`Lỗi từ content script (Tuần): ${extractedData.error}`);
         }
         if (!extractedData.timetableHtml || !extractedData.dateRangeText) {
             // Nếu thiếu dữ liệu quan trọng
             throw new Error("Content script không trích xuất đủ dữ liệu HTML hoặc ngày tháng (Tuần).");
         }
         logger.info("BG: Extracted data OK (Week).");

         // Bước 3: Gửi dữ liệu lên Backend Flask
         showNotification(notificationTitle, "Đang gửi dữ liệu TKB lên server...", 'basic', 'week-sync');
         const syncPayload = {
             user_id: userId,
             timetable_html: extractedData.timetableHtml,
             date_range_text: extractedData.dateRangeText
         };
         const syncResult = await fetchBackendWithAuth('/sync_from_extension', 'POST', accessToken, syncPayload);
         logger.info("BG: Backend call OK (Week). Result:", JSON.stringify(syncResult || {}, null, 2));

         // Bước 4: Xử lý kết quả và thông báo
         let finalMessage = "Đồng bộ tuần hiện tại hoàn tất.";
         let notificationType = 'success'; // Mặc định là thành công
         if (syncResult && typeof syncResult === 'object') {
             finalMessage = syncResult.message || 'Đồng bộ thành công!'; // Lấy thông báo từ backend
             const errorsReported = syncResult.errors ?? 0;
             const addedReported = syncResult.added ?? 0;
             const skippedReported = syncResult.skipped ?? 0;

             if (errorsReported > 0) {
                 notificationType = 'warning'; // Nếu có lỗi -> cảnh báo
                 finalMessage = `Hoàn tất với ${errorsReported} lỗi: Thêm ${addedReported}, Bỏ qua ${skippedReported}.`;
             } else if (addedReported !== undefined) { // Chỉ hiển thị chi tiết nếu có thông tin
                 finalMessage = `Tuần ${syncResult.week ?? 'N/A'}: Thêm ${addedReported}, Bỏ qua ${skippedReported}, Lỗi ${errorsReported}.`;
             }
             if (syncResult.processing_time !== undefined) {
                 finalMessage += ` (Thời gian: ${syncResult.processing_time}s)`;
             }
             finalStatus = { status: "success", message: finalMessage };
         } else {
             // Nếu kết quả backend không hợp lệ
             logger.error("BG: Invalid backend result (Week):", syncResult);
             finalMessage = "Phản hồi từ server xử lý không hợp lệ.";
             notificationType = 'error';
             finalStatus = { status: "error", message: finalMessage };
         }
         logger.debug("BG: Preparing final notification (Week).");
         showNotification(notificationTitle + (notificationType === 'success' ? " - Hoàn tất" : " - Chú ý/Lỗi"), finalMessage, notificationType, 'week-done');

     } catch (error) { // Bắt tất cả lỗi trong quá trình đồng bộ tuần
         logger.error("BG: --- SINGLE WEEK SYNC FAILED ---", error);
         let errorMsg = 'Lỗi đồng bộ tuần: ';
         // Ưu tiên message từ lỗi nếu có
         if (error?.message) {
             errorMsg += error.message;
         } else if (typeof error === 'string') {
             errorMsg += error;
         } else {
             errorMsg += 'Lỗi không xác định.';
         }
         showNotification(notificationTitle + " - LỖI", errorMsg, 'error', 'week-error');
         finalStatus = { status: "error", message: errorMsg };
     } finally {
         // Luôn gửi phản hồi về popup (nếu có thể)
         logger.info("BG: Single week sync process finished.");
         try {
             if (typeof sendResponse === 'function') {
                 sendResponse(finalStatus);
             }
         } catch (e) {
             logger.warn("BG: Error calling sendResponse at the end of handleSingleWeekSync:", e.message);
         }
     }
}


// --- HÀM XỬ LÝ ĐỒNG BỘ HỌC KỲ ---
// Hàm này không cần thay đổi logic chính, chỉ gọi forceGoogleLoginAndGetToken đã sửa
async function handleSemesterSync(userId, sendResponse) {
    logger.info(`BG: Starting SEMESTER sync process for user: ${userId}`);
    let accessToken = null;
    const notificationTitle = "Đồng bộ Học kỳ UEL";
    // Kết quả tổng hợp cho toàn học kỳ
    let overallResult = { added: 0, skipped: 0, errors: 0, weeksProcessed: 0, weeksTotal: 0 };
    // Trạng thái cuối cùng gửi về popup
    let finalStatus = { status: "error", message: "Lỗi khởi tạo đồng bộ học kỳ." };
    // Đếm số tuần trống liên tiếp để dừng sớm
    let consecutiveEmptyWeeks = 0;
    const CONSECUTIVE_EMPTY_WEEKS_LIMIT = 4; // Dừng nếu gặp 8 tuần trống liên tiếp
    // Thời gian chờ (có thể cần điều chỉnh tùy thuộc tốc độ mạng và server MyUEL)
    const INTER_WEEK_DELAY_MS = 700; // Chờ giữa các lần xử lý tuần (tăng nhẹ)
    const PRESELECT_WAIT_MS = 4500; // Chờ sau khi chọn trước tuần 2 (tăng nhẹ)

    try {
        // Bước 1: Lấy Access Token (Hàm này đã được sửa)
        showNotification(notificationTitle, "Bắt đầu: Yêu cầu quyền truy cập Google...", 'basic', 'sem-auth');
        try {
            accessToken = await forceGoogleLoginAndGetToken(userId); // Gọi hàm đã sửa
            if (!accessToken) throw new Error("Không nhận được access token hợp lệ từ Google.");
            logger.info("BG: (Semester) Google Token acquired successfully.");
        } catch (tokenError) {
            logger.error(`BG: (Semester) FAILED to get Google token:`, tokenError);
            throw tokenError; // Ném lỗi để dừng quá trình
        }

        // Bước 2: Tìm tab TKB MyUEL đang mở
        showNotification(notificationTitle, "Đang tìm tab Thời khóa biểu MyUEL...", 'basic', 'sem-findtab');
        const matchingTabs = await chrome.tabs.query({ url: MYUEL_TKB_URL_PATTERN + "*" });
        if (!matchingTabs || matchingTabs.length === 0) {
            throw new Error(`Không tìm thấy tab TKB MyUEL nào đang mở. Vui lòng mở trang TKB trước.`);
        }
        if (matchingTabs.length > 1) {
            logger.warn(`BG: Found ${matchingTabs.length} TKB tabs. Using the first one found.`);
        }
        const targetTabId = matchingTabs[0].id; // Lấy ID của tab đầu tiên tìm thấy
        logger.info(`BG: Found target TKB tab: ID=${targetTabId}, URL=${matchingTabs[0].url}`);

        // Bước 3: Lấy danh sách các tuần từ dropdown trên trang TKB
        showNotification(notificationTitle, "Đang lấy danh sách tuần học...", 'basic', 'sem-getweeks');
        const weekOptionsResult = await executeScriptOnTab(targetTabId, getContent_getWeekOptions, [WEEK_DROPDOWN_ID]);

        // Kiểm tra kết quả từ script lấy tuần
        if (!weekOptionsResult) {
             throw new Error("Không nhận được phản hồi khi lấy danh sách tuần từ trang.");
        }
        if (weekOptionsResult.error) {
            throw new Error(`Lỗi khi lấy danh sách tuần: ${weekOptionsResult.error}`);
        }
        if (!Array.isArray(weekOptionsResult) || weekOptionsResult.length === 0) {
            throw new Error("Không tìm thấy tuần học hợp lệ nào trong danh sách.");
        }
        // Lọc lại lần nữa để chắc chắn (mặc dù hàm getContent đã lọc)
        const weekOptions = weekOptionsResult.filter(option => option.value && option.value !== "-1" && option.value !== "" && option.value !== "0");
        logger.info(`BG: Found ${weekOptions.length} valid weeks to process.`);
        if (weekOptions.length === 0) {
            throw new Error("Không có tuần học hợp lệ nào để đồng bộ.");
        }
        overallResult.weeksTotal = weekOptions.length; // Tổng số tuần cần xử lý

        // --- BƯỚC 3.5: CHỌN TRƯỚC TUẦN 2 (NẾU CÓ > 1 TUẦN) ---
        // Mục đích: Đưa trang TKB ra khỏi trạng thái mặc định của tuần đầu tiên
        // trước khi bắt đầu vòng lặp chính, giúp việc chọn tuần sau đó ổn định hơn.
        if (weekOptions.length > 1) {
            const secondWeekValue = weekOptions[1].value; // Lấy value của tuần thứ hai
            logger.info(`BG: Pre-selecting week 2 (value: ${secondWeekValue}) to ensure proper page state change...`);
            showNotification(notificationTitle, `Đang chuẩn bị (tải trước tuần 2/${weekOptions.length})...`, 'basic', `sem-preselect`);
            try {
                // Inject một hàm đơn giản chỉ để chọn tuần và dispatch event, không cần chờ lấy data ở bước này
                await executeScriptOnTab(
                    targetTabId,
                    // Hàm inline để inject
                    (dropdownId, weekVal) => {
                         const dropdown = document.getElementById(dropdownId);
                         if (dropdown) {
                             dropdown.value = weekVal; // Chọn giá trị
                             dropdown.dispatchEvent(new Event('change', { bubbles: true })); // Giả lập sự kiện change
                             console.log(`[CS PreSelect] Dispatched change event for week value: ${weekVal}`);
                         } else {
                             console.error(`[CS PreSelect] Dropdown with ID '${dropdownId}' not found!`);
                             // Không ném lỗi từ đây để quá trình có thể tiếp tục
                         }
                     },
                     // Truyền tham số cho hàm inline
                     [WEEK_DROPDOWN_ID, secondWeekValue]
                );
                logger.debug(`BG: Pre-selection change event dispatched. Waiting ${PRESELECT_WAIT_MS}ms for page to potentially update...`);
                await delay(PRESELECT_WAIT_MS); // Chờ một khoảng thời gian đủ để trang xử lý AJAX (nếu có)
                logger.info("BG: Pre-selection of week 2 likely complete. Starting main loop.");
            } catch (preSelectError) {
                // Nếu bước này lỗi cũng không nên dừng hẳn, vòng lặp sau có thể vẫn hoạt động
                logger.error("BG: Error during pre-selection of week 2 (non-critical)", preSelectError);
                showNotification(notificationTitle + " - Cảnh báo", `Lỗi nhỏ khi tải trước tuần 2: ${preSelectError.message}. Tiếp tục đồng bộ...`, 'warning', `sem-preselect-err`);
                await delay(1000); // Chờ thêm chút trước khi vào vòng lặp chính
            }
        } else {
             logger.info("BG: Only one week found, skipping pre-selection step.");
        }
        // --- KẾT THÚC CHỌN TRƯỚC ---

        // --- Vòng lặp xử lý TẤT CẢ các tuần (từ tuần đầu tiên, index 0) ---
        showNotification(notificationTitle, `Bắt đầu xử lý ${weekOptions.length} tuần...`, 'basic', 'sem-loop-start');
        for (let i = 0; i < weekOptions.length; i++) {
            // Kiểm tra điều kiện dừng sớm do quá nhiều tuần trống
            if (consecutiveEmptyWeeks >= CONSECUTIVE_EMPTY_WEEKS_LIMIT) {
                logger.warn(`BG: Stopping semester sync early because ${consecutiveEmptyWeeks} consecutive empty/error weeks were encountered (limit: ${CONSECUTIVE_EMPTY_WEEKS_LIMIT}).`);
                showNotification(notificationTitle, `Dừng sớm do gặp ${CONSECUTIVE_EMPTY_WEEKS_LIMIT} tuần trống hoặc lỗi liên tiếp.`, 'info', `sem-stop-early`);
                break; // Thoát khỏi vòng lặp for
            }

            const week = weekOptions[i];
            const progressMsg = `Tuần ${i + 1}/${weekOptions.length}: ${week.text}`; // Hiển thị tiến trình
            logger.info(`BG: ----- Processing ${progressMsg} (Value: ${week.value}) -----`);
            showNotification(notificationTitle, `Đang xử lý ${progressMsg}...`, 'basic', `sem-week-${i}`);
            let extractedData = null; // Dữ liệu trích xuất cho tuần hiện tại

            try {
                 logger.debug(`BG: Attempting to select week '${week.value}', wait, and extract data...`);
                 // Gọi hàm inject phức tạp: chọn tuần -> chờ trang update -> lấy data
                 extractedData = await executeScriptOnTab(
                     targetTabId,
                     getContent_selectWeekAndGetData, // Hàm được định nghĩa ở trên
                     [ // Mảng các tham số cho hàm getContent_selectWeekAndGetData
                         WEEK_DROPDOWN_ID,
                         week.value, // Giá trị tuần cần chọn
                         TIMETABLE_TABLE_ID_STRING, // ID bảng TKB
                         DATE_SPAN_ID_STRING      // ID span hiển thị ngày
                     ]
                 );

                 // Kiểm tra kết quả trả về từ script inject
                 if (!extractedData) {
                      throw new Error("Không nhận được kết quả từ script chọn/lấy dữ liệu tuần.");
                 }
                 if (extractedData.error) {
                     throw new Error(extractedData.error); // Ném lỗi nếu script trả về lỗi cụ thể
                 }
                 if (!extractedData.timetableHtml || !extractedData.dateRangeText) {
                     // Kiểm tra xem có đủ dữ liệu không
                     throw new Error("Script không trích xuất đủ dữ liệu HTML hoặc ngày tháng cho tuần.");
                 }
                 logger.info(`BG: Successfully extracted data for week: ${week.text} (Date: ${extractedData.dateRangeText})`);

            } catch (extractOrSelectError) {
                 // Nếu có lỗi trong quá trình chọn tuần, chờ, hoặc lấy data
                 logger.error(`BG: Failed processing week ${i + 1} ('${week.text}'). Error:`, extractOrSelectError);
                 overallResult.errors++; // Ghi nhận lỗi tổng
                 showNotification(notificationTitle + " - Lỗi Tuần", `Lỗi xử lý tuần ${i + 1} (${week.text}): ${extractOrSelectError.message}`, 'error', `sem-week-err-${i}`);
                 consecutiveEmptyWeeks++; // Tăng bộ đếm tuần lỗi/trống
                 logger.info(`BG: Consecutive empty/error weeks count: ${consecutiveEmptyWeeks}`);
                 await delay(1000); // Chờ chút trước khi sang tuần tiếp theo
                 continue; // Bỏ qua tuần bị lỗi này và tiếp tục vòng lặp
            }

            // Nếu lấy dữ liệu thành công, gửi lên backend
            showNotification(notificationTitle, `Đang gửi dữ liệu ${progressMsg}...`, 'basic', `sem-sync-${i}`);
            const syncPayload = {
                user_id: userId,
                timetable_html: extractedData.timetableHtml,
                date_range_text: extractedData.dateRangeText
            };

            try {
                // Gọi backend để đồng bộ tuần này
                const syncResult = await fetchBackendWithAuth('/sync_from_extension', 'POST', accessToken, syncPayload);
                logger.info(`BG: Backend response for week ${i + 1} (${week.text}):`, JSON.stringify(syncResult || {}, null, 2));

                // Cập nhật kết quả tổng và biến đếm tuần trống/lỗi
                if (syncResult && typeof syncResult === 'object') {
                    const added = syncResult.added ?? 0;
                    const skipped = syncResult.skipped ?? 0;
                    const errors = syncResult.errors ?? 0;
                    overallResult.added += added;
                    overallResult.skipped += skipped;
                    overallResult.errors += errors; // Cộng dồn lỗi từ backend nữa

                    // Kiểm tra xem tuần này có phải là tuần trống/lỗi không để reset bộ đếm
                    // Một tuần được coi là không trống nếu có sự kiện được thêm, bỏ qua, hoặc backend báo lỗi cụ thể cho tuần đó
                    if (added > 0 || skipped > 0 || errors > 0) {
                        consecutiveEmptyWeeks = 0; // Reset bộ đếm
                    } else {
                         // Nếu backend không báo thêm/skip/lỗi -> coi là tuần trống
                         consecutiveEmptyWeeks++;
                         logger.info(`BG: Week ${i+1} appears empty or backend reported no changes. Consecutive count: ${consecutiveEmptyWeeks}`);
                    }
                } else {
                     // Nếu backend trả về lỗi không xác định hoặc không phải object
                     logger.error(`BG: Invalid backend response for week ${i+1}. Incrementing overall errors.`);
                     overallResult.errors++;
                     consecutiveEmptyWeeks++; // Coi như tuần lỗi
                }
            } catch (backendError) {
                // Nếu gọi backend thất bại (network error, 5xx, 401...)
                logger.error(`BG: Backend API call failed for week ${i + 1} (${week.text}). Error:`, backendError);
                overallResult.errors++; // Ghi nhận lỗi tổng
                consecutiveEmptyWeeks++; // Coi như tuần lỗi
                let backendErrorMsg = backendError.message || "Lỗi không xác định từ server";
                // Xử lý trường hợp token hết hạn
                if (backendError.status === 401 || backendError.message?.includes("Invalid/Expired Google token")) {
                    backendErrorMsg = "Token Google hết hạn hoặc không hợp lệ.";
                    showNotification(notificationTitle + " - LỖI NGHIÊM TRỌNG", `Lỗi đồng bộ tuần ${i + 1}: ${backendErrorMsg} Vui lòng thử lại.`, 'error', `sem-be-fatal-err-${i}`);
                    // Ném lỗi để dừng toàn bộ quá trình đồng bộ học kỳ
                    throw new Error(backendErrorMsg);
                } else {
                     // Các lỗi backend khác
                     showNotification(notificationTitle + " - Lỗi Backend", `Lỗi đồng bộ tuần ${i + 1}: ${backendErrorMsg}`, 'error', `sem-be-err-${i}`);
                }
            } // Kết thúc try-catch gọi backend

            overallResult.weeksProcessed++; // Tăng số tuần đã thực sự được xử lý (qua các bước)
            logger.debug(`BG: Finished week ${i+1}. Delaying ${INTER_WEEK_DELAY_MS}ms before next week...`);
            await delay(INTER_WEEK_DELAY_MS); // Delay ngắn giữa các tuần

        } // --- Kết thúc vòng lặp for qua các tuần ---

        // --- Tạo thông báo tổng kết cuối cùng ---
        logger.info("BG: Semester sync loop finished.");
        let finalSummary = `Đồng bộ học kỳ hoàn tất! Đã xử lý ${overallResult.weeksProcessed}/${overallResult.weeksTotal} tuần.`;
        finalSummary += ` Kết quả tổng cộng: Thêm ${overallResult.added} sự kiện, Bỏ qua ${overallResult.skipped} (đã có), Gặp ${overallResult.errors} lỗi.`;
        // Thêm thông báo nếu dừng sớm
        if (consecutiveEmptyWeeks >= CONSECUTIVE_EMPTY_WEEKS_LIMIT && overallResult.weeksProcessed < overallResult.weeksTotal) {
            finalSummary += ` (Đã dừng sớm do gặp ${CONSECUTIVE_EMPTY_WEEKS_LIMIT} tuần trống/lỗi liên tiếp.)`;
        }
        logger.info("BG: Final Semester Summary:", finalSummary);
        // Hiển thị thông báo cuối cùng
        showNotification(
            notificationTitle + " - Hoàn tất",
            finalSummary,
            (overallResult.errors > 0 ? 'warning' : 'success'), // Loại thông báo tùy thuộc có lỗi hay không
            'sem-done'
        );
        // Cập nhật trạng thái thành công gửi về popup
        finalStatus = { status: "success", message: finalSummary };

    } catch (error) { // Bắt lỗi tổng thể của cả quá trình đồng bộ học kỳ
        logger.error("BG: --- SEMESTER SYNC PROCESS FAILED (Outer Catch) ---", error);
        let errorMsg = 'Lỗi nghiêm trọng khi đồng bộ học kỳ: ';
        errorMsg += error?.message || 'Lỗi không xác định.';
        showNotification(notificationTitle + " - LỖI NGHIÊM TRỌNG", errorMsg, 'error', 'sem-error-final');
        // Cập nhật trạng thái lỗi gửi về popup
        finalStatus = { status: "error", message: errorMsg };
    } finally { // Khối này luôn chạy dù thành công hay lỗi
        // Gửi phản hồi cuối cùng về popup
        logger.info("BG: Semester sync handleSemesterSync function finished execution.");
        try {
            if (typeof sendResponse === 'function') {
                sendResponse(finalStatus);
            }
        } catch (e) {
            logger.warn("BG: Error calling sendResponse at the end of handleSemesterSync:", e.message);
        }
    }
}


// --- Listener chính nhận message từ popup.js ---
// Không cần thay đổi
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    logger.debug("BG: Message received", message);

    // Xử lý yêu cầu đồng bộ tuần hiện tại
    if (message.action === "startSync") {
        const userId = message.userId;
        const targetTabId = message.tabId; // Popup đã kiểm tra và gửi kèm tabId
        if (!userId || !targetTabId) {
            logger.error("BG: Week Sync request missing userId or tabId.");
            sendResponse({ status: "error", message:"Thiếu thông tin UserID hoặc TabID để bắt đầu." });
            return false; // Chỉ ra rằng sendResponse sẽ không được gọi không đồng bộ
        }
        // Gọi hàm xử lý đồng bộ tuần
        handleSingleWeekSync(userId, targetTabId, sendResponse);
        // Quan trọng: Return true để chỉ ra rằng sendResponse sẽ được gọi không đồng bộ (async)
        return true;

    // Xử lý yêu cầu đồng bộ cả học kỳ
    } else if (message.action === "startSemesterSync") {
        const userId = message.userId;
        if (!userId) {
            logger.error("BG: Semester Sync request missing userId.");
            sendResponse({ status: "error", message:"Thiếu thông tin User ID để bắt đầu." });
            return false; // Chỉ ra rằng sendResponse sẽ không được gọi không đồng bộ
        }
        // Gọi hàm xử lý đồng bộ học kỳ
        handleSemesterSync(userId, sendResponse);
        // Quan trọng: Return true để chỉ ra rằng sendResponse sẽ được gọi không đồng bộ (async)
        return true;
    }

    // Nếu không khớp action nào
    logger.warn("BG: Received unknown message action:", message.action);
    return false; // Không xử lý message này
});

// Log khởi động service worker
logger.info("Background service worker started and listener added. Waiting for messages.");
