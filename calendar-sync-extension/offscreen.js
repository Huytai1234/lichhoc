// offscreen.js

// === Phần code PARSE HTML được chuyển từ background.js sang đây ===
// (Giữ lại các hằng số ID cần thiết cho parsing)
const TIMETABLE_TABLE_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu";
const VIETNAM_TIMEZONE_OFFSET = "+07:00"; // Vẫn cần offset

console.log("[OFFSCREEN] Script started.");

// Hàm parseTimetableHtmlJs giờ chạy trong context này (có DOMParser)
function parseTimetableHtmlJs(timetableHtml, dateRangeText) {
    console.log("[OFFSCREEN Parse JS] Received HTML and date range.");
    // Log này giờ là không cần thiết vì chúng ta không thể truy cập logger từ background
    // logger.info("BG Parse JS: Starting schedule extraction.");

    const scheduleList = [];
    const seenEvents = new Set();

    // 1. Parse Date Range Text
    const dateMatch = dateRangeText.match(/Từ ngày\s*(\d{2}\/\d{2}\/\d{4})\s*đến ngày\s*(\d{2}\/\d{2}\/\d{4})/i);
    if (!dateMatch) {
        console.error(`[OFFSCREEN Parse JS] Date range format error: '${dateRangeText}'`);
        // Thay vì throw Error, trả về lỗi để background xử lý
        return { error: `Lỗi định dạng chuỗi ngày tháng: '${dateRangeText}'` };
    }
    const startDateStr = dateMatch[1]; // DD/MM/YYYY
    const endDateStr = dateMatch[2];   // DD/MM/YYYY
    console.log(`[OFFSCREEN Parse JS] Parsed week: ${startDateStr} - ${endDateStr}`);

    // Helper parseLocalDate (giống hệt trước)
    function parseLocalDate(dateString) {
        const parts = dateString.split('/');
        if (parts.length !== 3) return null;
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const year = parseInt(parts[2], 10);
        if (isNaN(day) || isNaN(month) || isNaN(year) || month < 0 || month > 11 || day < 1 || day > 31) return null;
        const date = new Date(year, month, day);
        if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
        return date;
    }


    const startDateObj = parseLocalDate(startDateStr);
    if (!startDateObj) {
        console.error(`[OFFSCREEN Parse JS] Invalid start date: '${startDateStr}'`);
        return { error: `Ngày bắt đầu không hợp lệ: '${startDateStr}'` };
    }

    // 2. Parse HTML using DOMParser (OK trong context này)
    const parser = new DOMParser();
    const doc = parser.parseFromString(timetableHtml, 'text/html');

    // 3. Find Timetable Table
    let tkbTable = doc.getElementById(TIMETABLE_TABLE_ID_STRING);
    if (!tkbTable) {
        tkbTable = doc.querySelector('table');
        console.warn(`[OFFSCREEN Parse JS] Table ID '${TIMETABLE_TABLE_ID_STRING}' not found. Using first table found.`);
        if (!tkbTable) {
            console.error("[OFFSCREEN Parse JS] No timetable table found in the provided HTML.");
            return { error: "Không tìm thấy bảng TKB trong HTML." };
        }
    }


    // 4. Find Header Row and Identify Columns
    const rows = tkbTable.querySelectorAll('tr');
    if (rows.length < 2) {
        console.warn("[OFFSCREEN Parse JS] Table has less than 2 rows. No data to parse.");
        return { scheduleList: [], weekStartDate: startDateStr, weekEndDate: endDateStr }; // Trả về rỗng nếu không đủ hàng
    }

    const headerRow = rows[0];
    const headerCells = headerRow.querySelectorAll('th, td');
    let roomHeaderIndex = -1;
    const dayIndices = {};
     const daysMap = {
        "THỨ 2": 0, "THU 2": 0, "HAI": 0,
        "THỨ 3": 1, "THU 3": 1, "BA": 1,
        "THỨ 4": 2, "THU 4": 2, "TU": 2, "TƯ": 2,
        "THỨ 5": 3, "THU 5": 3, "NAM": 3, "NĂM": 3,
        "THỨ 6": 4, "THU 6": 4, "SAU": 4, "SÁU": 4,
        "THỨ 7": 5, "THU 7": 5, "BAY": 5, "BẢY": 5,
        "CHỦ NHẬT": 6, "CN": 6, "CHỦ NH": 6, "CNHAT": 6
     };
     const dayKeysOriginal = {};

    headerCells.forEach((cell, index) => {
        const headerText = (cell.textContent || "").trim().toUpperCase();
        if (headerText === "PHÒNG") {
            roomHeaderIndex = index;
        } else {
            for (const dayKey in daysMap) {
                if (headerText === dayKey) {
                    const dayIndex = daysMap[dayKey];
                    dayIndices[dayIndex] = index;
                    dayKeysOriginal[dayIndex] = headerText;
                    break;
                }
            }
        }
    });

    if (roomHeaderIndex === -1) {
        console.error("[OFFSCREEN Parse JS] Missing 'PHÒNG' header.");
        return { error: "Thiếu cột 'PHÒNG' trong bảng TKB." };
    }
    if (Object.keys(dayIndices).length === 0) {
        console.error("[OFFSCREEN Parse JS] Missing day headers.");
        return { error: "Thiếu các cột Thứ trong bảng TKB." };
    }
     //console.log(`[OFFSCREEN Parse JS] Header Indices - Room=${roomHeaderIndex}, Days=${JSON.stringify(dayIndices)}`);

    // 5. Iterate Through Data Rows
    for (let i = 1; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('td');
        if (cells.length <= roomHeaderIndex) continue;

        let room = (cells[roomHeaderIndex].textContent || "").trim().replace(/\u00A0/g, ' ').trim();
        if (!room) continue;
         //console.log(`[OFFSCREEN Parse JS] Row ${i + 1} - Room='${room}'`);

        // 6. Iterate Through Day Columns
         for (const dayIndexStr in dayIndices) {
            const dayIndex = parseInt(dayIndexStr, 10);
            const cellIndex = dayIndices[dayIndex];

            if (cellIndex >= cells.length) continue;

            const cell = cells[cellIndex];
             const cellHtmlContent = cell.innerHTML;

            // 7. Split Cell Content by <hr>
            const scheduleBlocksHtml = cellHtmlContent.split(/<hr\s*\/?>/i);

            for (let blockIdx = 0; blockIdx < scheduleBlocksHtml.length; blockIdx++) {
                const blockHtml = scheduleBlocksHtml[blockIdx].trim();
                if (!blockHtml) continue;
                 //console.log(`[OFFSCREEN Parse JS] -- Processing Block ${blockIdx + 1} in Cell [Row ${i+1}, Day ${dayIndex}] --`);

                // 8. Extract Text Lines from Block
                let blockLines = [];
                try {
                     const blockParser = new DOMParser();
                     const blockDoc = blockParser.parseFromString(`<div>${blockHtml}</div>`, 'text/html');
                     const blockContainer = blockDoc.body.firstChild;
                     function getTextNodes(node, lines) {
                         if (node.nodeType === Node.TEXT_NODE) {
                             const text = node.textContent.trim();
                             if (text) lines.push(text);
                         } else if (node.nodeType === Node.ELEMENT_NODE) {
                             for (let child = node.firstChild; child; child = child.nextSibling) getTextNodes(child, lines);
                         }
                     }
                    getTextNodes(blockContainer, blockLines);
                    blockLines = blockLines.map(line => line.replace(/^"|"$/g, '').trim()).filter(line => line);
                     //console.log(`[OFFSCREEN Parse JS] Block Lines: ${JSON.stringify(blockLines)}`);
                } catch (parseBlockError) {
                    console.error(`[OFFSCREEN Parse JS] Error parsing block HTML: ${parseBlockError}`, blockHtml);
                    continue;
                 }

                if (blockLines.length === 0) continue;

                // 9. Parse Information from Lines
                const subject = blockLines[0] || "N/A";
                let timeRangeStr = "";
                let periods = "";
                let teacher = "";
                let location = "";
                 let startTimeStr = "";
                 let endTimeStr = "";
                const timeRegex = /(\d{1,2}[:h]\d{2})\s*(?:->|-|đến)\s*(\d{1,2}[:h]\d{2})|(\d{1,2}[:h]\d{2})/;

                for (let j = 1; j < blockLines.length; j++) {
                    const line = blockLines[j];
                    if (!timeRangeStr) {
                        const timeMatch = line.match(timeRegex);
                        if (timeMatch) {
                            timeRangeStr = line;
                            startTimeStr = timeMatch[1] || timeMatch[3];
                            endTimeStr = timeMatch[2];
                            //console.debug(`[OFFSCREEN Parse JS] Time match: Raw='${line}', Start='${startTimeStr}', End='${endTimeStr || 'N/A'}'`);
                        }
                    }
                    const periodsMatch = line.match(/Tiết\s*([\d\-\.]+)/i);
                     if (periodsMatch && !periods) periods = periodsMatch[1].trim();
                    if (line.toLowerCase().startsWith('gv')) teacher = line.substring(line.indexOf(':') + 1).trim();
                    if (line.toLowerCase().startsWith('cơ sở')) location = line.substring(line.indexOf(':') + 1).trim();
                }

                if (!subject || subject === "N/A") continue;
                if (!startTimeStr) continue;

                // 10. Calculate Date & Time, Create Event Object
                try {
                    const currentEventDate = new Date(startDateObj);
                    currentEventDate.setDate(startDateObj.getDate() + dayIndex);
                    const year = currentEventDate.getFullYear();
                    const month = (currentEventDate.getMonth() + 1).toString().padStart(2, '0');
                    const day = currentEventDate.getDate().toString().padStart(2, '0');
                    const datePart = `${year}-${month}-${day}`;

                    function parseTime(timeStr) {
                        timeStr = timeStr.replace('h', ':');
                        const parts = timeStr.split(':');
                        if (parts.length !== 2) return null;
                        let hours = parseInt(parts[0], 10);
                        let minutes = parseInt(parts[1], 10);
                         if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
                        const hoursStr = hours.toString().padStart(2, '0');
                        const minutesStr = minutes.toString().padStart(2, '0');
                        return { hours: hoursStr, minutes: minutesStr, totalMinutes: hours * 60 + minutes };
                    }

                    const startParsed = parseTime(startTimeStr);
                    if (!startParsed) continue;
                    const timePartStart = `${startParsed.hours}:${startParsed.minutes}:00`;

                    let endParsed = null;
                    let timePartEnd = timePartStart;
                    let descriptionExtra = "\n(Chỉ giờ BĐ)";

                    if (endTimeStr) {
                        endParsed = parseTime(endTimeStr);
                        if (endParsed && endParsed.totalMinutes > startParsed.totalMinutes) {
                             timePartEnd = `${endParsed.hours}:${endParsed.minutes}:00`;
                             descriptionExtra = "";
                         } else {
                             //console.warn(`[OFFSCREEN Parse JS] End time invalid/<=start: ${endTimeStr}. Using start as end.`);
                         }
                    }

                    const startISO = `${datePart}T${timePartStart}${VIETNAM_TIMEZONE_OFFSET}`;
                    const endISO = `${datePart}T${timePartEnd}${VIETNAM_TIMEZONE_OFFSET}`;

                    // 11. Check for Duplicates
                    const eventKey = `${subject}|${startISO}|${endISO}|${room}`;
                    if (seenEvents.has(eventKey)) continue;
                    seenEvents.add(eventKey);

                    // 12. Add to Schedule List
                    const eventData = {
                        date: currentEventDate.toLocaleDateString('vi-VN'),
                        day_name: dayKeysOriginal[dayIndex] || `Ngày ${dayIndex}`,
                        room: room,
                        subject: subject,
                        time_range: timeRangeStr || startTimeStr,
                        periods: periods,
                        teacher: teacher,
                        location: location, // Cơ sở
                        start_datetime_iso: startISO,
                        end_datetime_iso: endISO,
                        description_extra: descriptionExtra,
                    };
                    scheduleList.push(eventData);
                     //console.log(`[OFFSCREEN Parse JS] Added event: ${subject} at ${startISO}`);

                } catch (eventError) {
                     console.error(`[OFFSCREEN Parse JS] Error processing event block for '${subject}': ${eventError}`);
                }
            } // end block loop
        } // end day loop
    } // end row loop

    console.log(`[OFFSCREEN Parse JS] Extraction complete. Found ${scheduleList.length} events.`);
    // Trả về kết quả, không có lỗi nếu đến được đây
    return { scheduleList, weekStartDate: startDateStr, weekEndDate: endDateStr };
}
// === Kết thúc phần code PARSE HTML ===


// Lắng nghe message từ service worker (background.js)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[OFFSCREEN] Message received:", message.type);

    if (message.type === 'parse-html-offscreen') {
        if (!message.data || !message.data.timetableHtml || !message.data.dateRangeText) {
            console.error("[OFFSCREEN] Invalid data received for parsing.");
            sendResponse({ error: "Dữ liệu không hợp lệ để phân tích." });
            return false; // Không phải async
        }
        console.log("[OFFSCREEN] Starting HTML parsing...");
        const result = parseTimetableHtmlJs(message.data.timetableHtml, message.data.dateRangeText);
        console.log("[OFFSCREEN] Parsing finished. Sending result back.");
        // Gửi kết quả (có thể là object chứa scheduleList hoặc object chứa error)
        sendResponse(result);
        return false; // Không phải async
    }

    // Có thể thêm các loại message khác nếu cần
    console.warn("[OFFSCREEN] Unknown message type received:", message.type);
    return false; // Không xử lý
});