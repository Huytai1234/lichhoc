function populateDropdown(selectElement, options, selectedValue) {
    selectElement.innerHTML = '<option value="">Chọn tuần</option>';
    options.forEach(option => {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.text = option.text;
        if (option.value === selectedValue) opt.selected = true;
        selectElement.appendChild(opt);
    });
}

function executeScript(tabId, func, args, callback, caller = "Không xác định", world = "ISOLATED") {
    if (typeof callback !== 'function') {
        console.error(`[${caller}] Callback không phải là hàm:`, callback);
        document.getElementById("status").textContent = "Lỗi: Callback không hợp lệ.";
        return;
    }

    console.log(`[${caller}] Đang gọi executeScript với tabId:`, tabId, "và args:", args, "world:", world);

    chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: func,
        args: args,
        world: world
    }, async (results) => {
        if (chrome.runtime.lastError) {
            console.error(`[${caller}] Lỗi từ chrome.runtime.lastError:`, chrome.runtime.lastError.message);
            document.getElementById("status").textContent = `Lỗi khi chạy script trên tab MyUEL: ${chrome.runtime.lastError.message}`;
            return;
        }

        if (!results || results.length === 0 || !results[0].result) {
            console.error(`[${caller}] Không nhận được kết quả từ executeScript:`, results);
            document.getElementById("status").textContent = "Lỗi: Không nhận được dữ liệu từ tab MyUEL.";
            return;
        }

        try {
            const result = await results[0].result;
            console.log(`[${caller}] Kết quả từ executeScript:`, result);
            callback(result);
        } catch (error) {
            console.error(`[${caller}] Lỗi khi xử lý kết quả executeScript:`, error);
            document.getElementById("status").textContent = `Lỗi xử lý dữ liệu: ${error.message}`;
        }
    });
}

console.log("Bắt đầu chạy popup.js");

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOMContentLoaded: Bắt đầu xử lý");

    const statusDiv = document.getElementById("status");
    statusDiv.textContent = "Đang tải tùy chọn...";

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        console.log("DOMContentLoaded: Đã truy vấn tabs");

        if (chrome.runtime.lastError) {
            console.error("DOMContentLoaded: Lỗi truy vấn tab:", chrome.runtime.lastError.message);
            statusDiv.textContent = `Lỗi truy vấn tab: ${chrome.runtime.lastError.message}`;
            return;
        }

        if (!tabs || tabs.length === 0) {
            console.error("DOMContentLoaded: Không tìm thấy tab hiện tại.");
            statusDiv.textContent = "Lỗi: Không tìm thấy tab hiện tại.";
            return;
        }

        const currentTab = tabs[0];
        const tabId = currentTab.id;

        if (!currentTab.url.includes("myuel.uel.edu.vn")) {
            console.log("DOMContentLoaded: Tab hiện tại không phải trang MyUEL.");
            statusDiv.textContent = "Lỗi: Vui lòng mở trang MyUEL và điều hướng đến trang Thời Khóa Biểu.";
            return;
        }

        // Kiểm tra xem có bảng thời khóa biểu không
        executeScript(tabId, () => {
            const tkbElement = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu");
            return !!tkbElement;
        }, [], (isMyUELTab) => {
            console.log("DOMContentLoaded.checkTable: Kết quả kiểm tra bảng:", isMyUELTab);

            if (!isMyUELTab) {
                console.log("DOMContentLoaded.checkTable: Không tìm thấy bảng thời khóa biểu.");
                statusDiv.textContent = "Lỗi: Vui lòng điều hướng đến trang Thời Khóa Biểu.";
                return;
            }

            // Chờ trang tải hoàn tất trước khi lấy dữ liệu
            executeScript(tabId, () => {
                return new Promise(resolve => {
                    const waitForPageLoad = (attempts, maxAttempts, interval) => {
                        if (attempts >= maxAttempts) {
                            console.log("DOMContentLoaded: Không thể tải trang hoàn tất sau thời gian chờ tối đa.");
                            resolve({ error: "Không thể tải trang hoàn tất sau thời gian chờ tối đa." });
                            return;
                        }

                        setTimeout(() => {
                            const namHocDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlNamHoc");
                            const hocKyDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlHocKy");
                            const tuanDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan");

                            if (!namHocDropdown || !hocKyDropdown || !tuanDropdown) {
                                console.log("Attempt", attempts + 1, "- Dropdown không tìm thấy. Đang thử lại...");
                                waitForPageLoad(attempts + 1, maxAttempts, interval);
                                return;
                            }

                            console.log("DOMContentLoaded: Trang đã tải hoàn tất");
                            resolve(true);
                        }, interval);
                    };

                    // Thử tối đa 30 lần, mỗi lần cách nhau 1000ms (tổng cộng 30 giây)
                    waitForPageLoad(0, 30, 1000);
                });
            }, [], (pageLoaded) => {
                if (pageLoaded.error) {
                    console.log("DOMContentLoaded: Lỗi khi chờ trang tải:", pageLoaded.error);
                    statusDiv.textContent = pageLoaded.error;
                    return;
                }

                // Lấy dữ liệu dropdown
                executeScript(tabId, () => {
                    const namHocDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlNamHoc");
                    const hocKyDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlHocKy");
                    const tuanDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan");
                    const dateSpan = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate");

                    if (!namHocDropdown || !hocKyDropdown || !tuanDropdown || !dateSpan) {
                        console.log("DOMContentLoaded.getOptions: Không tìm thấy dropdown hoặc ngày.");
                        return { error: "Không tìm thấy dropdown hoặc ngày. Vui lòng đảm bảo bạn đang ở trang Thời Khóa Biểu." };
                    }

                    const namHocOptions = Array.from(namHocDropdown.options).map(opt => opt.text);
                    const hocKyOptions = Array.from(hocKyDropdown.options).map(opt => opt.text);
                    const selectedNamHoc = namHocDropdown.options[namHocDropdown.selectedIndex].text;
                    const selectedHocKy = hocKyDropdown.options[hocKyDropdown.selectedIndex].text;

                    // Trích xuất danh sách tuần
                    const dateMatch = dateSpan.textContent.trim().match(/Từ ngày (\d{2}\/\d{2}\/\d{4}) đến ngày (\d{2}\/\d{2}\/\d{4})/);
                    const week1StartDate = dateMatch ? dateMatch[1] : null;

                    const tuanOptions = Array.from(tuanDropdown.options)
                        .map((opt, index) => {
                            // Decode ký tự tiếng Việt nếu cần
                            let decodedText = opt.text;
                            try {
                                decodedText = decodeURIComponent(escape(opt.text));
                            } catch (e) {
                                console.log("Không thể decode ký tự:", opt.text);
                            }

                            if (decodedText === "Tất cả") return null;
                            const startDateParts = week1StartDate.split("/");
                            const startDateObj = new Date(`${startDateParts[2]}-${startDateParts[1]}-${startDateParts[0]}`);
                            const startDate = new Date(startDateObj.setDate(startDateObj.getDate() + 7 * index));
                            const endDate = new Date(startDateObj.setDate(startDate.getDate() + 6));
                            return {
                                index: index,
                                text: decodedText,
                                value: opt.value,
                                start_date: startDate.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }),
                                end_date: endDate.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })
                            };
                        })
                        .filter(opt => opt !== null);

                    return {
                        namHocOptions,
                        hocKyOptions,
                        selectedNamHoc,
                        selectedHocKy,
                        week_list: tuanOptions
                    };
                }, [], (response) => {
                    console.log("DOMContentLoaded.getOptions: Kết quả lấy dữ liệu dropdown:", response);

                    if (response.error) {
                        console.log("DOMContentLoaded.getOptions: Lỗi:", response.error);
                        statusDiv.textContent = response.error;
                        return;
                    }

                    const namHocSelect = document.getElementById('nam_hoc');
                    const hocKySelect = document.getElementById('hoc_ky');
                    const tuanSelect = document.getElementById('tuan');

                    // Hiển thị danh sách tuần
                    tuanSelect.innerHTML = '<option value="">Chọn tuần</option>';
                    response.week_list.forEach(week => {
                        const opt = document.createElement('option');
                        opt.value = week.value;
                        opt.text = `Tuần ${week.text} (Từ ${week.start_date} đến ${week.end_date})`;
                        tuanSelect.appendChild(opt);
                    });

                    statusDiv.textContent = "";

                    // Logic đồng bộ lên Google Calendar
                    document.getElementById("extractButton").addEventListener("click", () => {
                        console.log("extractButton.click: Bắt đầu xử lý sự kiện click");

                        const namHoc = response.selectedNamHoc;
                        const hocKy = response.selectedHocKy;
                        const tuan = tuanSelect.value;
                        const mode = document.querySelector('input[name="mode"]:checked').value;

                        if (!namHoc || !hocKy || (!tuan && mode === "1")) {
                            console.log("extractButton.click: Thiếu thông tin cần thiết, thoát.");
                            statusDiv.textContent = "Vui lòng chọn đầy đủ các tùy chọn.";
                            return;
                        }

                        statusDiv.textContent = "Vui lòng chạy script trong DevTools để chọn tuần...";

                        // Hiển thị script để người dùng chạy trong DevTools
                        const scriptOutput = document.createElement('div');
                        scriptOutput.innerHTML = `
                            <h3>Hướng dẫn chạy script trong DevTools</h3>
                            <p>1. Nhấn <strong>Command + Option + J</strong> để mở DevTools.</p>
                            <p>2. Sao chép đoạn script bên dưới và dán vào Console, sau đó nhấn Enter.</p>
                            <p>3. Sau khi chạy script, nhấn "Tiếp tục" để trích xuất thời khóa biểu.</p>
                            <pre>
(function () {
    const tuanDropdown = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan");
    if (!tuanDropdown) {
        console.error("Không tìm thấy dropdown tuần.");
        return;
    }
    tuanDropdown.value = "${tuan}";
    const changeEvent = new Event('change', { bubbles: true });
    tuanDropdown.dispatchEvent(changeEvent);
    console.log("Đã thay đổi tuần thành công:", tuanDropdown.value);
})();
                            </pre>
                            <button id="continueButton">Tiếp tục</button>
                        `;
                        document.body.appendChild(scriptOutput);

                        document.getElementById("continueButton").addEventListener("click", () => {
                            scriptOutput.remove();
                            statusDiv.textContent = "Đang trích xuất...";

                            const weeksToSync = mode === "1" ? [tuan] : response.week_list.map(week => week.value);
                            let currentWeekIndex = 0;

                            function syncNextWeek() {
                                if (currentWeekIndex >= weeksToSync.length) {
                                    console.log("extractButton.click: Hoàn tất đồng bộ tất cả tuần.");
                                    statusDiv.textContent = "Hoàn tất đồng bộ!";
                                    return;
                                }

                                const currentTuan = weeksToSync[currentWeekIndex];
                                console.log("extractButton.click: Bắt đầu đồng bộ tuần:", currentTuan);

                                executeScript(tabId, (namHoc, hocKy, tuan) => {
                                    const extractSchedule = () => {
                                        const table = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu");
                                        if (!table) return { error: "Không tìm thấy bảng thời khóa biểu." };

                                        const dateSpan = document.querySelector("#portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate");
                                        const dateText = dateSpan ? dateSpan.textContent.trim() : "";
                                        const dateMatch = dateText.match(/Từ ngày (\d{2}\/\d{2}\/\d{4}) đến ngày (\d{2}\/\d{2}\/\d{4})/);
                                        if (!dateMatch) return { error: "Không phân tích được ngày của tuần." };
                                        const startDate = dateMatch[1];
                                        const endDate = dateMatch[2];

                                        const rows = table.querySelectorAll("tr");
                                        const headerRow = rows[0];
                                        const dayHeaders = Array.from(headerRow.querySelectorAll("td"))
                                            .map(td => td.textContent.trim())
                                            .filter(text => ["PHÒNG", "THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"].includes(text));

                                        if (!dayHeaders.length) return { error: "Không tìm thấy tiêu đề ngày." };

                                        const roomHeaderIndex = dayHeaders.indexOf("PHÒNG");
                                        const scheduleList = [];
                                        const DAY_COLORS = {
                                            "THỨ 2": "11", "THỨ 3": "5", "THỨ 4": "9", "THỨ 5": "4",
                                            "THỨ 6": "7", "THỨ 7": "10", "CHỦ NHẬT": "3"
                                        };

                                        for (let i = 1; i < rows.length; i++) {
                                            const cells = rows[i].querySelectorAll("td");
                                            if (cells.length <= roomHeaderIndex) continue;

                                            const room = cells[roomHeaderIndex].textContent.trim() || "Không xác định";
                                            if (!room) continue;

                                            for (let j = roomHeaderIndex + 1; j < cells.length; j++) {
                                                const cell = cells[j];
                                                const cellText = cell.innerHTML.trim();
                                                if (!cellText || cellText === " ") continue;

                                                const dayName = dayHeaders[j];
                                                if (!["THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"].includes(dayName)) continue;

                                                const dayOffset = ["THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"].indexOf(dayName);
                                                const startDateParts = startDate.split("/");
                                                const startDateObj = new Date(`${startDateParts[2]}-${startDateParts[1]}-${startDateParts[0]}`);
                                                const currentDate = new Date(startDateObj.setDate(startDateObj.getDate() + dayOffset));
                                                const currentDateStr = currentDate.toLocaleDateString("vi-VN", {
                                                    day: "2-digit",
                                                    month: "2-digit",
                                                    year: "numeric"
                                                });

                                                const blocks = cellText.split("<hr>").map(block => block.replace(/<br>/g, "\n").trim());
                                                for (const block of blocks) {
                                                    if (!block) continue;

                                                    const lines = block
                                                        .replace(/<b>/g, "")
                                                        .replace(/<\/b>/g, "")
                                                        .split("\n")
                                                        .map(line => line.trim())
                                                        .filter(line => line);

                                                    if (lines.length < 2) continue;

                                                    const subject = lines[0] || "";
                                                    let timeRange = "";
                                                    for (let k = 1; k < lines.length; k++) {
                                                        if (lines[k].match(/(\d{1,2}h\d{2})/)) {
                                                            timeRange = lines[k];
                                                            break;
                                                        }
                                                    }
                                                    const periods = lines.find(line => line.includes("Tiết")) || "";
                                                    const teacher = lines.find(line => line.includes("GV:"))?.replace("GV: ", "") || "";
                                                    const location = lines.find(line => line.includes("Cơ sở:"))?.replace("Cơ sở: ", "") || "";

                                                    if (subject) {
                                                        const timeParts = timeRange.match(/(\d{1,2}h\d{2})/g) || [];
                                                        if (!timeParts.length) {
                                                            const startTime = "08h00";
                                                            const endTime = "10h00";

                                                            const startTimeFormatted = startTime.replace("h", ":");
                                                            const endTimeFormatted = endTime.replace("h", ":");

                                                            const startDateTimeStr = `${currentDateStr.split("/").reverse().join("-")}T${startTimeFormatted}:00+07:00`;
                                                            const endDateTimeStr = `${currentDateStr.split("/").reverse().join("-")}T${endTimeFormatted}:00+07:00`;

                                                            const startDateTime = new Date(startDateTimeStr);
                                                            const endDateTime = new Date(endDateTimeStr);

                                                            scheduleList.push({
                                                                date: currentDateStr,
                                                                day_name: dayName,
                                                                room,
                                                                subject,
                                                                time_range: `${startTime} -> ${endTime}`,
                                                                periods,
                                                                teacher,
                                                                location,
                                                                start_datetime: startDateTime.toISOString(),
                                                                end_datetime: endDateTime.toISOString(),
                                                                color_id: DAY_COLORS[dayName] || "1"
                                                            });
                                                            continue;
                                                        }

                                                        const startTime = timeParts[0];
                                                        let endTime = timeParts[1];

                                                        const formatTime = (timeStr) => {
                                                            const [hours, minutes] = timeStr.split("h");
                                                            return `${hours.padStart(2, "0")}:${minutes}`;
                                                        };

                                                        const startTimeFormatted = formatTime(startTime);
                                                        const startDateTimeStr = `${currentDateStr.split("/").reverse().join("-")}T${startTimeFormatted}:00+07:00`;
                                                        const startDateTime = new Date(startDateTimeStr);
                                                        if (isNaN(startDateTime.getTime())) continue;

                                                        let endDateTime;
                                                        if (!endTime) {
                                                            endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000);
                                                        } else {
                                                            const endTimeFormatted = formatTime(endTime);
                                                            const endDateTimeStr = `${currentDateStr.split("/").reverse().join("-")}T${endTimeFormatted}:00+07:00`;
                                                            endDateTime = new Date(endDateTimeStr);
                                                            if (isNaN(endDateTime.getTime())) continue;
                                                        }

                                                        const event = {
                                                            date: currentDateStr,
                                                            day_name: dayName,
                                                            room,
                                                            subject,
                                                            time_range: timeRange,
                                                            periods,
                                                            teacher,
                                                            location,
                                                            start_datetime: startDateTime.toISOString(),
                                                            end_datetime: endDateTime.toISOString(),
                                                            color_id: DAY_COLORS[dayName] || "1"
                                                        };
                                                        scheduleList.push(event);
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    return { schedule: scheduleList, start_date: startDate, end_date: endDate };
                                });

                                return new Promise(resolve => {
                                    setTimeout(() => {
                                        resolve(extractSchedule());
                                    }, 3000); // Đợi 3 giây để giao diện cập nhật
                                });
                            }; [namHoc, hocKy, currentTuan], (response) => {
                                console.log("extractButton.click: Kết quả trích xuất:", response);

                                if (response.error) {
                                    console.log("extractButton.click: Lỗi:", response.error);
                                    statusDiv.textContent = response.error;
                                    return;
                                }

                                statusDiv.textContent = `Đang gửi dữ liệu tuần ${currentTuan}...`;
                                fetch("http://localhost:5001/api/receive_schedule", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify(response)
                                })
                                    .then(res => res.json())
                                    .then(data => {
                                        if (data.error) {
                                            console.log("extractButton.click: Lỗi khi gửi dữ liệu:", data.error);
                                            statusDiv.textContent = data.error;
                                            return;
                                        }
                                        currentWeekIndex++;
                                        syncNextWeek();
                                    })
                                    .catch(error => {
                                        console.error("extractButton.click: Lỗi khi gửi dữ liệu qua fetch:", error);
                                        statusDiv.textContent = `Lỗi khi gửi dữ liệu: ${error.message}`;
                                    });
                            }, ("extractButton.click", "MAIN");
                            });
                        });
                    }, "DOMContentLoaded.checkTable");
            });
        });
    });
});

console.log("Kết thúc popup.js");