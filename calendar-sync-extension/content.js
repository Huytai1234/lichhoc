// content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("content.js: Đang chạy trên URL:", window.location.href);

    // Kiểm tra xem trang có phải là trang thời khóa biểu không
    if (window.location.href.includes("PageId=a1c64d89-9a1f-40ce-817f-6f61fa99db42")) {
        console.log("content.js: Đang chạy trên trang thời khóa biểu");

        if (message.action === "updateHocKy") {
            const { namHoc, hocKy } = message;
            console.log("content.js: Nhận yêu cầu cập nhật kỳ học:", namHoc, hocKy);

            const namHocDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlNamHoc");
            const hocKyDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlHocKy");

            if (!namHocDropdown || !hocKyDropdown) {
                console.log("content.js: Không tìm thấy dropdown.");
                sendResponse({ error: "Không tìm thấy dropdown." });
                return;
            }

            // Thiết lập năm học
            namHocDropdown.value = namHoc;
            namHocDropdown.dispatchEvent(new Event('change', { bubbles: true }));
            console.log("content.js: Đã thiết lập năm học:", namHocDropdown.value);

            // Thiết lập kỳ học
            // Kiểm tra các tùy chọn trong dropdown để tìm giá trị phù hợp với hocKy
            const hocKyOptions = Array.from(hocKyDropdown.options).map(opt => opt.text);
            console.log("content.js: Danh sách kỳ học:", hocKyOptions);
            if (!hocKyOptions.includes(hocKy)) {
                console.log("content.js: Không tìm thấy kỳ học", hocKy, "trong danh sách");
                sendResponse({ error: "Không tìm thấy kỳ học trong danh sách: " + hocKy });
                return;
            }
            hocKyDropdown.value = hocKy;
            console.log("content.js: Đã thiết lập kỳ học:", hocKyDropdown.value);

            // Chờ __doPostBack được định nghĩa trong top-level frame
            const waitForDoPostBack = (attempts, maxAttempts, interval) => {
                if (attempts >= maxAttempts) {
                    console.log("content.js: Không tìm thấy hàm __doPostBack sau thời gian chờ tối đa.");
                    sendResponse({ error: "Không tìm thấy hàm __doPostBack sau thời gian chờ tối đa." });
                    return;
                }

                setTimeout(() => {
                    if (typeof window.top.__doPostBack === 'function') {
                        console.log("content.js: Gọi __doPostBack từ top-level frame để cập nhật kỳ học");
                        window.top.__doPostBack('portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b$ctl00$ddlHocKy', '');

                        // Lắng nghe sự kiện AJAX hoàn tất
                        if (typeof window.top.Sys !== 'undefined' && window.top.Sys.WebForms && window.top.Sys.WebForms.PageRequestManager) {
                            const prm = window.top.Sys.WebForms.PageRequestManager.getInstance();
                            if (prm.get_isInAsyncPostBack()) {
                                console.log("content.js: Đang trong quá trình AJAX, chờ hoàn tất...");
                                prm.add_endRequest(() => {
                                    console.log("content.js: Yêu cầu AJAX hoàn tất");
                                    sendResponse({ success: true });
                                });
                            } else {
                                console.log("content.js: Không có AJAX đang chạy, trả về ngay");
                                sendResponse({ success: true });
                            }
                        } else {
                            console.log("content.js: Không tìm thấy Sys.WebForms.PageRequestManager, trả về sau 30 giây");
                            setTimeout(() => sendResponse({ success: true }), 30000);
                        }
                    } else {
                        console.log("content.js: Chưa tìm thấy __doPostBack, thử lại lần", attempts + 1);
                        waitForDoPostBack(attempts + 1, maxAttempts, interval);
                    }
                }, interval);
            };

            // Thử tối đa 30 lần, mỗi lần cách nhau 1000ms (tổng cộng 30 giây)
            waitForDoPostBack(0, 30, 1000);

            // Giữ channel mở để chờ phản hồi
            return true;
        }
    } else {
        console.log("content.js: Không chạy trên trang thời khóa biểu");
        sendResponse({ error: "Không phải trang thời khóa biểu." });
    }
});