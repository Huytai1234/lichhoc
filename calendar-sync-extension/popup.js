// popup.js

const userIdInput = document.getElementById('userId');
const syncWeekButton = document.getElementById('syncWeekButton');
const syncSemesterButton = document.getElementById('syncSemesterButton');
const statusDiv = document.getElementById('status');
const loader = document.getElementById('loader');
const versionDisplay = document.getElementById('versionDisplay');
const clearEmailLink = document.getElementById('clearEmailLink');

// --- Cấu hình ---
const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId=';

const logger = { info: (...args) => console.log("[POPUP INFO]", ...args), warn: (...args) => console.warn("[POPUP WARN]", ...args), error: (...args) => console.error("[POPUP ERROR]", ...args), debug: (...args) => console.debug("[POPUP DEBUG]", ...args) };

// Hàm cập nhật trạng thái
function updateStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = `status-${type}`; // Ví dụ: status-info, status-success

    const isProcessing = (type === 'info' && (message.includes('Đang') || message.includes('Kiểm tra') || message.includes('Gửi yêu cầu')));

    if (isProcessing) {
        loader.classList.remove('hidden'); // Hiển thị loader
        syncWeekButton.disabled = true;
        syncSemesterButton.disabled = true;
    } else {
        loader.classList.add('hidden'); // Ẩn loader
         // Chỉ bật lại nút nếu không phải đang xử lý ban đầu
         if(!isProcessing) {
              syncWeekButton.disabled = false;
              syncSemesterButton.disabled = false;
         }
    }
}

// Load/Save User ID và Hiển thị Phiên bản
document.addEventListener('DOMContentLoaded', () => {
    const manifest = chrome.runtime.getManifest();
    versionDisplay.textContent = `Phiên bản: ${manifest.version}`; // Hiển thị phiên bản

    chrome.storage.local.get(['userId'], (result) => {
        if (result.userId) {
            userIdInput.value = result.userId;
            logger.info('Restored userId:', result.userId);
        }
         // Luôn đặt trạng thái ban đầu sau khi kiểm tra userId
         updateStatus('Nhập email và chọn chức năng.');
    });
    loader.classList.add('hidden');
});

userIdInput.addEventListener('input', () => {
    chrome.storage.local.set({ userId: userIdInput.value.trim() });
});


// --- Hàm xử lý gửi yêu cầu và nhận phản hồi ---
async function handleSyncRequest(action, userId, options = {}) {
    logger.info(`handleSyncRequest called for action: ${action}`);
    if (!userId || !userId.includes('@st.uel.edu.vn')) {
        updateStatus('Vui lòng nhập đúng email sinh viên UEL.', 'error');
        userIdInput.focus();
        return; // Dừng sớm nếu email không hợp lệ
    }
    chrome.storage.local.set({ userId: userId }); // Lưu lại email hợp lệ

    // Hiển thị trạng thái đang xử lý ban đầu
    let initialProcessingMessage = action === 'startSync' ? 'Đang gửi yêu cầu đồng bộ tuần...' : 'Đang gửi yêu cầu đồng bộ học kỳ...';
    updateStatus(initialProcessingMessage, 'info');

    try {
        let messagePayload = { action: action, userId: userId, ...options };

        if (action === "startSync") {
            const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!currentTab) { updateStatus('Lỗi: Không tìm thấy tab đang hoạt động.', 'error'); return; }
            logger.info("Popup: Current active tab:", currentTab.id, currentTab.url);
            if (!currentTab.url || !currentTab.url.startsWith(MYUEL_TKB_URL_PATTERN)) { updateStatus(`Lỗi: Cần mở đúng trang TKB MyUEL trên tab hiện tại trước.`, 'error'); return; }
            messagePayload.tabId = currentTab.id; // Gửi ID tab
            logger.debug("Payload for startSync:", messagePayload);
        } else {
            logger.debug("Payload for startSemesterSync:", messagePayload);
        }

        // Gửi message đến background script
        chrome.runtime.sendMessage(messagePayload, (response) => {
            let finalMessage = "Phản hồi không xác định.";
            let finalType = 'warn';
            // Lấy duration từ response do background trả về
            const duration = response?.duration;

             // Kiểm tra lỗi giao tiếp trước tiên
             if (chrome.runtime.lastError) {
                 logger.error(`Error sending/receiving message (${action}):`, chrome.runtime.lastError);
                 finalMessage = `Lỗi giao tiếp (${action === 'startSync' ? 'Tuần' : 'Học kỳ'}): ${chrome.runtime.lastError.message || 'Không rõ'}`;
                 finalType = 'error';
             } else if (response?.status === "success") { // Sau đó kiểm tra trạng thái từ background
                 logger.info(`Background success (${action}):`, response.message);
                 finalMessage = response.message;
                 finalType = 'success';
             } else if (response?.status === "error") {
                 logger.error(`Background error (${action}):`, response.message);
                 finalMessage = response.message;
                 finalType = 'error';
             } else { // Trường hợp không có response hoặc response không đúng định dạng
                 logger.warn(`Unexpected response (${action}):`, response);
                 finalMessage = "Nhận được phản hồi không mong muốn từ nền."; // Thông báo rõ hơn
                 finalType = 'warn';
             }

             // Hiển thị trạng thái cuối cùng kèm thời gian (nếu có)
             updateStatus(`${finalMessage}${duration ? ` (Thời gian: ${duration}s)` : ''}`, finalType);
        });

    } catch (error) {
        // Xử lý lỗi xảy ra *trước* khi gửi message (ví dụ: lỗi truy vấn tab)
        logger.error(`Error before sending message (${action}):`, error);
        // Không hiển thị duration cho lỗi xảy ra trước khi gọi background
        updateStatus(`Lỗi: ${error.message || 'Lỗi không xác định trong popup.'}`, 'error');
    }
}


// --- Sự kiện nút Đồng bộ Tuần ---
syncWeekButton.addEventListener('click', () => {
    handleSyncRequest("startSync", userIdInput.value.trim());
});

// --- Sự kiện nút Đồng bộ Học Kỳ ---
syncSemesterButton.addEventListener('click', () => {
    handleSyncRequest("startSemesterSync", userIdInput.value.trim());
});

// --- Sự kiện cho nút/link Xóa Email ---
clearEmailLink.addEventListener('click', () => {
    chrome.storage.local.remove('userId', () => {
        userIdInput.value = ''; // Xóa text trong ô input
        logger.info('Stored userId cleared.');
        updateStatus('Đã xóa email đã lưu. Nhập lại email.', 'info');
        userIdInput.focus(); // Focus vào ô input
    });
});