// popup.js

const userIdInput = document.getElementById('userId');
const syncWeekButton = document.getElementById('syncWeekButton');
const syncSemesterButton = document.getElementById('syncSemesterButton');
const statusDiv = document.getElementById('status');
const loader = document.getElementById('loader');

// --- Cấu hình ---
const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId=';

const logger = { info: (...args) => console.log("[POPUP INFO]", ...args), warn: (...args) => console.warn("[POPUP WARN]", ...args), error: (...args) => console.error("[POPUP ERROR]", ...args), debug: (...args) => console.debug("[POPUP DEBUG]", ...args) };

// Hàm cập nhật trạng thái (đã cập nhật để quản lý loader)
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
        // Chỉ bật lại nút nếu không phải đang xử lý ban đầu (tránh bật lại quá sớm)
        if(!isProcessing) {
             syncWeekButton.disabled = false;
             syncSemesterButton.disabled = false;
        }
    }
}

// Load/Save User ID (Giữ nguyên)
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['userId'], (result) => {
        if (result.userId) {
            userIdInput.value = result.userId;
            logger.info('Restored userId:', result.userId);
        } else {
             updateStatus('Nhập email và chọn chức năng.');
        }
    });
     // Ẩn loader khi popup mới mở
     loader.classList.add('hidden');
     // Đặt trạng thái ban đầu
     updateStatus('Nhập email và chọn chức năng.');
});

userIdInput.addEventListener('input', () => {
    chrome.storage.local.set({ userId: userIdInput.value.trim() });
});


// --- Hàm xử lý gửi yêu cầu và nhận phản hồi (Đã sửa đổi để nhận duration từ background) ---
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

        // Kiểm tra tab đặc biệt cho đồng bộ tuần (chỉ cần kiểm tra URL, không cần await query nếu message đã có tabId)
        if (action === "startSync") {
             const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
             if (!currentTab) {
                 updateStatus('Lỗi: Không tìm thấy tab đang hoạt động.', 'error'); return;
             }
             logger.info("Popup: Current active tab:", currentTab.id, currentTab.url);
             if (!currentTab.url || !currentTab.url.startsWith(MYUEL_TKB_URL_PATTERN)) {
                  updateStatus(`Lỗi: Cần mở đúng trang TKB MyUEL trên tab hiện tại trước.`, 'error'); return;
             }
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

             if (chrome.runtime.lastError) {
                 logger.error(`Error sending/receiving message (${action}):`, chrome.runtime.lastError);
                 finalMessage = `Lỗi giao tiếp (${action === 'startSync' ? 'Tuần' : 'Học kỳ'}): ${chrome.runtime.lastError.message || 'Không rõ'}`;
                 finalType = 'error';
             } else if (response?.status === "success") {
                 logger.info(`Background success (${action}):`, response.message);
                 finalMessage = response.message;
                 finalType = 'success';
             } else if (response?.status === "error") {
                 logger.error(`Background error (${action}):`, response.message);
                 finalMessage = response.message;
                 finalType = 'error';
             } else {
                 logger.warn(`Unexpected response (${action}):`, response);
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
    const userId = userIdInput.value.trim();
    handleSyncRequest("startSync", userId);
});

// --- Sự kiện nút Đồng bộ Học Kỳ ---
syncSemesterButton.addEventListener('click', () => {
    const userId = userIdInput.value.trim();
    handleSyncRequest("startSemesterSync", userId);
});