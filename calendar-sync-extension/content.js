// Calendar-sync/Calendar-sync-extension/content.js
(function() {
    // Log ngay khi script bắt đầu chạy
    console.log("[CONTENT SCRIPT] Running..."); // <<< THÊM LOG

    // --- ID Phần tử HTML (Kiểm tra lại nếu MyUEL thay đổi) ---
    const TIMETABLE_TABLE_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu";
    const DATE_SPAN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate";
    // -----------------------------------------------------------
    console.debug("[CONTENT SCRIPT] Element IDs:", { table: TIMETABLE_TABLE_ID, date: DATE_SPAN_ID }); // <<< THÊM LOG

    const timetableTable = document.getElementById(TIMETABLE_TABLE_ID);
    console.debug("[CONTENT SCRIPT] Found table element:", timetableTable); // <<< THÊM LOG

    const dateSpan = document.getElementById(DATE_SPAN_ID);
    console.debug("[CONTENT SCRIPT] Found date span element:", dateSpan); // <<< THÊM LOG

    if (!timetableTable) {
        const errorMsg = `Không tìm thấy bảng TKB (ID: ${TIMETABLE_TABLE_ID}). Đảm bảo bạn đang ở đúng trang TKB và ID là chính xác.`;
        console.error("[CONTENT SCRIPT] Error:", errorMsg);
        return { error: errorMsg }; // Trả về lỗi
    }
    if (!dateSpan) {
         const errorMsg = `Không tìm thấy thông tin ngày tháng (ID: ${DATE_SPAN_ID}).`;
         console.error("[CONTENT SCRIPT] Error:", errorMsg);
         return { error: errorMsg }; // Trả về lỗi
    }

    // Chỉ lấy HTML và Text nếu cả hai phần tử đều tồn tại
    const timetableHtml = timetableTable.outerHTML;
    const dateRangeText = dateSpan.innerText.trim();

    if (!timetableHtml) {
        console.error("[CONTENT SCRIPT] Error getting table HTML.");
        return { error: `Không lấy được HTML bảng TKB.` };
    }
    if (!dateRangeText) {
        console.error("[CONTENT SCRIPT] Error getting date range text.");
        return { error: `Không lấy được nội dung ngày tháng.` };
    }

    // Log trước khi trả về thành công
    console.log("[CONTENT SCRIPT] Extracted data successfully. Returning..."); // <<< THÊM LOG
    return {
        timetableHtml: timetableHtml,
        dateRangeText: dateRangeText
    };
})();
