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

// Hàm cập nhật trạng thái (Đã sửa để xử lý type 'info' luôn là đang xử lý)
function updateStatus(message, type = 'info') {
    statusDiv.textContent = message;
    // Thêm class để hỗ trợ hiển thị nhiều dòng tốt hơn
    statusDiv.className = `status-message status-${type}`; // Ví dụ: status-message status-info

    // Coi mọi thông báo 'info' là đang xử lý để hiển thị loader/disable nút
    const isProcessing = (type === 'info');

    if (isProcessing) {
        loader.classList.remove('hidden'); // Hiển thị loader
        syncWeekButton.disabled = true;
        syncSemesterButton.disabled = true;
    } else {
        loader.classList.add('hidden'); // Ẩn loader
        // Bật lại nút khi không còn xử lý (success, error, warn)
        syncWeekButton.disabled = false;
        syncSemesterButton.disabled = false;
    }
    // Có thể thêm CSS động nếu cần, nhưng ưu tiên dùng class CSS đã thêm
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
        // Reset trạng thái ban đầu khi mở popup
        updateStatus('Nhập email và chọn chức năng.'); // Sử dụng type mặc định 'info', nhưng sẽ được sửa lại nếu cần
        // Đảm bảo nút được bật và loader ẩn khi mở popup ban đầu
        syncWeekButton.disabled = false;
        syncSemesterButton.disabled = false;
        loader.classList.add('hidden');

    });
    // loader.classList.add('hidden'); // Di chuyển lên trên để đảm bảo ẩn ngay
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

    // === THAY ĐỔI CHÍNH: CẬP NHẬT THÔNG BÁO BAN ĐẦU ===
    // Hiển thị trạng thái đang xử lý ban đầu NGAY LẬP TỨC và giải thích lý do chờ đợi
    let initialProcessingMessage = '';
    if (action === 'startSync') {
        initialProcessingMessage = 'Đang gửi yêu cầu đồng bộ tuần...';
    } else if (action === 'startSemesterSync') {
        // Thông báo rõ ràng về độ trễ ngẫu nhiên và lý do
        initialProcessingMessage = 'Đang gửi yêu cầu đồng bộ học kỳ...\n(Sẽ có độ trễ ngẫu nhiên để tránh làm quá tải. Vui lòng đợi!)';
    } else {
        updateStatus('Hành động không xác định.', 'error');
        return;
    }
    // Cập nhật trạng thái ngay lập tức với thông báo tương ứng
    updateStatus(initialProcessingMessage, 'info'); // Dùng type 'info' để disable nút và hiện loader
    // === KẾT THÚC THAY ĐỔI THÔNG BÁO BAN ĐẦU ===

    try {
        let messagePayload = { action: action, userId: userId, ...options };

        // Chỉ kiểm tra tab cho đồng bộ tuần, sau khi đã update status
        if (action === "startSync") {
            const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!currentTab) { updateStatus('Lỗi: Không tìm thấy tab đang hoạt động.', 'error'); return; }
            logger.info("Popup: Current active tab:", currentTab.id, currentTab.url);
            if (!currentTab.url || !currentTab.url.startsWith(MYUEL_TKB_URL_PATTERN)) {
                updateStatus(`Lỗi: Bạn cần mở đúng trang TKB MyUEL (\n${MYUEL_TKB_URL_PATTERN}... \n) trên tab đang hoạt động trước.`, 'error');
                return;
            }
            messagePayload.tabId = currentTab.id; // Gửi ID tab
            logger.debug("Payload for startSync:", messagePayload);
        } else { // Hành động là startSemesterSync
            logger.debug("Payload for startSemesterSync:", messagePayload);
        }

        // Gửi message đến background script
        chrome.runtime.sendMessage(messagePayload, (response) => {
            // --- Xử lý phản hồi cuối cùng từ background ---
            let finalMessage = "Phản hồi không xác định.";
            let finalType = 'warn';
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
                 finalMessage = response.message; // Tin nhắn lỗi đã được chuẩn bị ở background
                 finalType = 'error';
             } else {
                 logger.warn(`Unexpected response (${action}):`, response);
                 finalMessage = "Nhận được phản hồi không mong muốn từ nền.";
                 finalType = 'warn';
             }

             // Hiển thị trạng thái cuối cùng kèm thời gian
             updateStatus(`${finalMessage}${duration ? ` (Thời gian: ${duration}s)` : ''}`, finalType);
             // Nút bấm sẽ tự động được bật lại bởi updateStatus
        });

    } catch (error) {
        // Xử lý lỗi xảy ra *trước* khi gửi message (vd: lỗi truy vấn tab)
        logger.error(`Error before sending message (${action}):`, error);
        updateStatus(`Lỗi: ${error.message || 'Lỗi không xác định trong popup.'}`, 'error');
        // Nút bấm sẽ tự động được bật lại bởi updateStatus
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
        updateStatus('Đã xóa email đã lưu. Nhập lại email.', 'info'); // Cập nhật status
        // Đảm bảo nút được bật và loader ẩn sau khi xóa
        syncWeekButton.disabled = false;
        syncSemesterButton.disabled = false;
        loader.classList.add('hidden');
        userIdInput.focus(); // Focus vào ô input
    });
});

// === THÊM CSS CHO XUỐNG DÒNG VÀ CĂN CHỈNH ===
// Thêm vào cuối để đảm bảo nó được áp dụng
const style = document.createElement('style');
style.textContent = `
    .status-message {
        white-space: pre-wrap; /* Cho phép xuống dòng tự động và bằng \\n */
        word-wrap: break-word; /* Ngắt từ nếu quá dài */
        line-height: 1.4;      /* Khoảng cách dòng dễ đọc hơn */
        text-align: left;      /* Căn trái khi có nhiều dòng */
        margin-top: 10px;      /* Thêm khoảng cách phía trên */
        padding: 8px 10px;     /* Padding bên trong */
    }
    /* Căn giữa lại loader nếu muốn */
    .loader {
         margin: 10px auto 5px auto;
    }
`;
document.head.appendChild(style);
// === KẾT THÚC THÊM CSS ===