# Calendar-sync/app.py
# -*- coding: utf-8 -*-
# Phiên bản: Thêm log debug CORS và entry route

from flask import Flask, render_template, request, session, jsonify
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials
from bs4 import BeautifulSoup
import time
import re
import os
import pickle
import logging
from datetime import datetime, timedelta, timezone
from werkzeug.wrappers import Response
import json
import pprint
# --- THÊM IMPORT CORS ---
from flask_cors import CORS
# -----------------------


# --- Cấu hình cơ bản ---
#os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1' # Đã comment out/xóa
app = Flask(__name__)

# --- KÍCH HOẠT CORS ---
EXTENSION_ID = "oolaaglnbllindgkiibpeemmojgflenc" # ID extension của bạn (đã xác nhận đúng)
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
# Dòng CORS cũ:
# CORS(app, resources={ r"/sync_from_extension": {"origins": EXTENSION_ORIGIN} })

# <<< THAY THẾ TẠM THỜI ĐỂ DEBUG >>>
CORS(app, resources={ r"/sync_from_extension": {"origins": "*"} })
# Khởi tạo logger sau khi import logging
logger = logging.getLogger(__name__)
# Ghi log về việc thay đổi CORS
logger.info("CORS temporarily set to allow all origins for /sync_from_extension for debugging.")
# Dòng log cũ (có thể giữ hoặc xóa)
# logger.info(f"CORS enabled for origin: {EXTENSION_ORIGIN}")
# ---------------------

# !!! Sử dụng biến môi trường cho secret key !!!
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'ban-can-thiet-lap-bien-moi-truong-FLASK_SECRET_KEY')

# Cấu hình logging
log_level = logging.DEBUG # Giữ DEBUG để xem log chi tiết khi debug
logging.basicConfig(level=log_level,
                    # Có thể đổi thành stream handler để xem log trực tiếp trên Render dễ hơn
                    # handlers=[logging.StreamHandler()], # Ghi log ra console thay vì file
                    filename='calendar_sync.log', # Giữ lại nếu vẫn muốn ghi file
                    format='%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s',
                    encoding='utf-8')
# logger = logging.getLogger(__name__) # Đã khởi tạo ở trên
logger.info("Flask application starting (DEBUG CORS MODE - Batch Optimized)...") # Sửa log khởi động

AVAILABLE_EVENT_COLORS = ["1", "2", "3", "4", "5", "6", "7", "9", "10", "11"]
SCOPES = ['https://www.googleapis.com/auth/calendar']
TIMETABLE_TABLE_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu"
DATE_SPAN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate"
# -----------------------------------------

# --- Các Hàm Trợ Giúp ---

def build_service_from_token(access_token):
    """Tạo service Google Calendar từ access token."""
    # (Giữ nguyên code hàm này)
    if not access_token:
        logger.error("build_service empty token.")
        return None
    try:
        creds = Credentials(token=access_token)
        if not creds or not creds.token:
            logger.error("Invalid token struct.")
            return None
        service = build('calendar', 'v3', credentials=creds, cache_discovery=False)
        logger.info("Service built from token OK.")
        return service
    except Exception as e:
        logger.exception(f"Build service error: {e}")
        return None

def extract_schedule_from_html(timetable_html, date_range_text):
    """Trích xuất lịch học (Đã sửa lỗi parse Tiết, thời gian)."""
    # (Giữ nguyên code hàm này - Lưu ý: đã sửa lại phần timezone và xử lý lỗi trả về dict)
    logger.info("Starting schedule extraction (Flexible Parsing).")
    schedule_list = []
    seen_events = set()
    date_match = re.search(r'Từ ngày\s*(\d{2}/\d{2}/\d{4})\s*đến ngày\s*(\d{2}/\d{2}/\d{4})', date_range_text, re.IGNORECASE)
    if not date_match:
        logger.error(f"Date range format error: '{date_range_text}'")
        return {"error": f"Date range format error: '{date_range_text}'"}, None, None
    start_date_str, end_date_str = date_match.group(1), date_match.group(2)
    try:
        start_date_obj_naive = datetime.strptime(start_date_str, "%d/%m/%Y")
        start_date_obj = timezone(timedelta(hours=7)).localize(start_date_obj_naive) # Gán timezone VN UTC+7
    except ValueError:
        logger.error(f"Invalid start date: '{start_date_str}'")
        return {"error": f"Invalid start date: '{start_date_str}'"}, None, None
    logger.info(f"Parsed week: {start_date_str} - {end_date_str} (Timezone: {start_date_obj.tzinfo})")
    try:
        soup = BeautifulSoup(timetable_html, 'lxml')
    except ImportError:
        soup = BeautifulSoup(timetable_html, 'html.parser')
    tkb_table = soup.find('table', id=TIMETABLE_TABLE_ID)
    if not tkb_table:
        logger.error(f"Table not found (ID: {TIMETABLE_TABLE_ID}).")
        return {"error": f"Table not found (ID: {TIMETABLE_TABLE_ID})."}, start_date_str, end_date_str
    rows = tkb_table.find_all('tr')
    if len(rows) < 2:
        logger.info("Table has less than 2 rows, no schedule data.")
        return [], start_date_str, end_date_str
    header_row = rows[0]
    header_cells = header_row.find_all(['td', 'th'])
    day_headers = [c.get_text(strip=True) for c in header_cells]
    logger.debug(f"Headers: {day_headers}")
    try:
        room_header_index = -1
        day_indices = {}
        days_list_keys = ["THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"]
        for idx, h in enumerate(day_headers):
            norm_h = h.upper().strip()
            if norm_h == "PHÒNG":
                room_header_index = idx
            elif norm_h in days_list_keys:
                day_indices[norm_h] = idx
        if room_header_index == -1:
            raise ValueError("Missing 'PHÒNG' header")
        if not day_indices:
            raise ValueError("Missing day headers")
        logger.info(f"Header: RoomIdx={room_header_index}, DayIndices={day_indices}")
    except ValueError as e:
        logger.error(f"Header structure error: {e}")
        return {"error": f"Header structure error: {e}"}, start_date_str, end_date_str

    for row_idx, row in enumerate(rows[1:], 1):
        cells = row.find_all('td')
        if len(cells) <= room_header_index: continue
        room = cells[room_header_index].get_text(strip=True) or "N/A"
        if not room or room.replace('\xa0', '').strip() == "" or room == "N/A": continue
        logger.debug(f"Row {row_idx+1}: Room='{room}'")
        for day_name_key, cell_index in day_indices.items():
            if cell_index >= len(cells): continue
            cell = cells[cell_index]
            cell_content_html = cell.decode_contents()
            schedule_blocks_html = re.split(r'<hr\s*/?>', cell_content_html, flags=re.IGNORECASE)
            for block_idx, block_html in enumerate(schedule_blocks_html):
                block_html_stripped = block_html.strip();
                if not block_html_stripped: continue
                try:
                    try: block_soup = BeautifulSoup(block_html_stripped, 'lxml')
                    except Exception: block_soup = BeautifulSoup(block_html_stripped, 'html.parser')
                    block_text_lines_raw = list(block_soup.stripped_strings)
                    block_text_lines = [ln.strip().strip('"').strip() for ln in block_text_lines_raw if ln.strip()]
                    logger.debug(f"Cell({row_idx+1},{cell_index}), Block {block_idx+1}: Lines={block_text_lines}")
                    if not block_text_lines: continue
                    subject = ""; time_range = ""; periods = ""; teacher = ""; location = ""
                    time_match = None; periods_found = False
                    if block_text_lines: subject = block_text_lines[0]
                    for line in block_text_lines[1:]:
                        cleaned_line = line
                        t_match = re.search(r'(\d{1,2}[h:]\d{2})\s*(?:->|-|đến)\s*(\d{1,2}[h:]\d{2})|(\d{1,2}[h:]\d{2})', cleaned_line)
                        if t_match and not time_match: time_range=cleaned_line; time_match=t_match; logger.debug(f"Time match: Raw='{cleaned_line}' Groups={time_match.groups()}")
                        p_match = re.search(r'Tiết\s*([\d\-\.]+)', cleaned_line, re.IGNORECASE)
                        if p_match: periods=p_match.group(1).strip(); logger.debug(f"Periods regex: '{periods}'"); periods_found=True
                        elif cleaned_line.lower().startswith('gv'): teacher = cleaned_line[3:].strip().lstrip(':').strip()
                        elif cleaned_line.lower().startswith('cơ sở'): location = cleaned_line[6:].strip().lstrip(':').strip()
                    if not periods_found: logger.warning(f"No 'Tiết:' info for '{subject}': {block_text_lines}")
                    if not time_match: logger.warning(f"No time found for '{subject}'. Skip."); continue
                    if subject:
                        try:
                            day_index = days_list_keys.index(day_name_key)
                            current_date = start_date_obj + timedelta(days=day_index) # Đã có timezone
                            current_date_str = current_date.strftime("%d/%m/%Y")
                            start_str = ""; end_str = ""
                            g1, g2, g3 = time_match.group(1), time_match.group(2), time_match.group(3)
                            if g1 and g2: start_str=g1; end_str=g2
                            elif g3: start_str=g3
                            else: logger.warning(f"Time parse failed for '{subject}'. Skip."); continue
                            start_format = "%Hh%M" if 'h' in start_str else "%H:%M"
                            start_dt_naive = datetime.strptime(f"{current_date_str} {start_str}", f"%d/%m/%Y {start_format}")
                            start_dt = timezone(timedelta(hours=7)).localize(start_dt_naive) # Gán timezone
                            end_dt = start_dt
                            if end_str:
                                end_format = "%Hh%M" if 'h' in end_str else "%H:%M"
                                end_dt_naive = datetime.strptime(f"{current_date_str} {end_str}", f"%d/%m/%Y {end_format}")
                                end_dt = timezone(timedelta(hours=7)).localize(end_dt_naive) # Gán timezone
                                if end_dt <= start_dt:
                                    logger.warning(f"'{subject}': End time <= Start time. Setting end = start + 45 mins (estimated). Original end: {end_str}")
                                    end_dt = start_dt + timedelta(minutes=45)
                            start_iso = start_dt.isoformat()
                            end_iso = end_dt.isoformat()
                            logger.debug(f"Final DateTime: Start={start_iso}, End={end_iso}")
                            event_key=(subject, start_iso, end_iso, room)
                            if event_key in seen_events: logger.warning(f"Skipping duplicate event found during scrape: {event_key}"); continue
                            seen_events.add(event_key)
                            desc_extra = "\n(Chỉ có giờ bắt đầu)" if start_dt == end_dt and not end_str else ""
                            schedule_list.append({ "date": current_date_str, "day_name": day_name_key, "room": room, "subject": subject, "time_range": time_range, "periods": periods, "teacher": teacher, "location": location, "start_datetime": start_iso, "end_datetime": end_iso, "description_extra": desc_extra })
                            logger.debug(f"Prepared Event: Subject='{subject}', Periods='{periods}', Start='{start_iso}'")
                        except ValueError as e: logger.error(f"Error parsing date/time/day for '{subject}': {e}. Lines: {block_text_lines}")
                        except Exception as e: logger.exception(f"Unexpected error processing block for '{subject}': {e}")
                except Exception as block_parse_error: logger.exception(f"Error parsing HTML block in Cell({row_idx+1},{cell_index}): {block_parse_error}")

    logger.info(f"Extraction finished. Found {len(schedule_list)} potential events.")
    return schedule_list, start_date_str, end_date_str

# ----- Các Flask Routes -----

@app.route('/')
def index():
    return """<html><body><h1>UEL Sync Backend OK</h1><p>Use Chrome Extension.</p></body></html>"""

# Biến toàn cục để lưu kết quả batch
batch_results = {'added': 0, 'errors': 0}

# Hàm callback cho Batch Request
def handle_batch_response(request_id, response, exception):
    """Xử lý kết quả trả về cho từng request trong batch."""
    # (Giữ nguyên code hàm này)
    global batch_results
    if exception is not None:
        error_details = "Unknown error"
        if isinstance(exception, HttpError):
            try:
                error_content = json.loads(exception.content.decode('utf-8'))
                error_details = error_content.get('error', {}).get('message', exception.content.decode('utf-8'))
            except:
                 error_details = exception.content.decode('utf-8') if exception.content else str(exception)
            logger.error(f"Batch request item {request_id} failed (HttpError {exception.resp.status}): {error_details}")
        else:
             error_details = str(exception)
             logger.error(f"Batch request item {request_id} failed (Non-HttpError): {error_details}")
        batch_results['errors'] += 1
    else:
        logger.info(f"Batch request item {request_id} succeeded. Event ID: {response.get('id')}")
        batch_results['added'] += 1

@app.route('/sync_from_extension', methods=['POST'])
def sync_from_extension():
    """Endpoint đồng bộ chính - Tối ưu Batch + Check In-Memory, Màu theo môn học."""
    # <<< THÊM LOG NGAY ĐẦU HÀM >>>
    logger.info(f"====== ENTERED /sync_from_extension ROUTE (Headers: {request.headers}) ======")
    start_time_process = time.time()
    global batch_results # Reset biến toàn cục
    batch_results = {'added': 0, 'errors': 0}
    # logger.info("Received request on /sync_from_extension (Batch Optimized, Color by Subject)") # Log cũ

    # 1. Lấy Token và Dữ liệu
    # (Giữ nguyên code phần này)
    auth_header = request.headers.get('Authorization'); access_token = None
    if auth_header and auth_header.startswith('Bearer '): access_token = auth_header.split(' ')[1]
    if not access_token: logger.warning("Authorization header missing or invalid."); return jsonify({"error": "Access Token missing or invalid format."}), 401
    if not request.is_json: logger.warning("Request content type is not JSON."); return jsonify({"error": "Request must be JSON."}), 415
    data = request.json;
    if not data: logger.warning("No JSON data received in request."); return jsonify({"error": "No JSON data received."}), 400
    user_id = data.get('user_id'); timetable_html = data.get('timetable_html'); date_range_text = data.get('date_range_text')
    logger.debug(f"Sync Data Received: user='{user_id}', date_range='{date_range_text}', html_present={'Yes' if timetable_html else 'No'}")
    missing = None;
    # if not user_id: missing = "user_id" # Bỏ qua kiểm tra user_id nếu không bắt buộc
    if not timetable_html: missing = "timetable_html"
    elif not date_range_text: missing = "date_range_text"
    if missing: logger.error(f"Missing required data in request: {missing}"); return jsonify({"error": f"Missing required data: {missing}"}), 400
    logger.info(f"Processing sync request for user: {user_id or 'Unknown'}")


    # 2. Tạo Google Service
    # (Giữ nguyên code phần này)
    try:
        service = build_service_from_token(access_token)
        if not service: logger.error("Failed to build Google Calendar service, likely invalid token."); return jsonify({"error": "Invalid or expired Google token."}), 401
    except Exception as e: logger.exception(f"Unexpected error building Google Calendar service: {e}"); return jsonify({"error": "Server error connecting to Google services."}), 500

    # 3. Trích xuất sự kiện từ HTML
    # (Giữ nguyên code phần này, dùng lại hàm đã sửa ở trên)
    try:
        extracted_result, week_start, week_end = extract_schedule_from_html(timetable_html, date_range_text)
        if isinstance(extracted_result, dict) and 'error' in extracted_result:
             logger.error(f"HTML Extraction failed: {extracted_result['error']}")
             return jsonify({"error": f"Timetable parsing error: {extracted_result['error']}"}), 400
        schedule_list = extracted_result
        logger.info(f"Successfully extracted {len(schedule_list)} events for week {week_start} - {week_end}")
    except ValueError as e: # Bắt lỗi cụ thể từ hàm extract cũ nếu còn dùng raise
        logger.error(f"Extraction ValueError: {e}")
        return jsonify({"error": f"TKB parsing error: {e}"}), 400
    except Exception as e:
        logger.exception(f"Unexpected error during HTML extraction: {e}")
        return jsonify({"error": "Server error during timetable extraction."}), 500

    # 4. Nếu không có sự kiện nào trích xuất được, trả về ngay
    # (Giữ nguyên code phần này)
    if not schedule_list:
        proc_time = time.time() - start_time_process
        logger.info(f"No events extracted for week {week_start}-{week_end}. Sync finished.")
        return jsonify({"message": f"No events found or extracted for the week {week_start} - {week_end}.", "week": f"{week_start}-{week_end}", "added": 0, "skipped": 0, "errors": 0, "processing_time": round(proc_time, 2)})

    # 5. Lấy các sự kiện đã có trên Google Calendar cho tuần này
    # (Giữ nguyên code phần này)
    existing_events_set = set()
    try:
        start_dt_obj_naive = datetime.strptime(week_start, "%d/%m/%Y")
        start_dt_obj = timezone(timedelta(hours=7)).localize(start_dt_obj_naive)
        end_dt_obj_naive = datetime.strptime(week_end, "%d/%m/%Y")
        end_dt_obj = timezone(timedelta(hours=7)).localize(end_dt_obj_naive.replace(hour=23, minute=59, second=59))
        time_min_query = start_dt_obj.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        time_max_query = end_dt_obj.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        logger.info(f"Fetching existing events: {time_min_query} to {time_max_query}")
        page_token = None
        items_fetched = 0
        while True:
            events_result = service.events().list( calendarId='primary', timeMin=time_min_query, timeMax=time_max_query, singleEvents=True, maxResults=250, pageToken=page_token ).execute()
            items = events_result.get('items', [])
            items_fetched += len(items)
            for item in items:
                 summary = item.get('summary')
                 start_iso_gcal = item.get('start', {}).get('dateTime')
                 end_iso_gcal = item.get('end', {}).get('dateTime')
                 loc_gcal = item.get('location', '').strip()
                 if all([summary, start_iso_gcal, end_iso_gcal]): existing_events_set.add((summary, start_iso_gcal, end_iso_gcal, loc_gcal))
            page_token = events_result.get('nextPageToken')
            if not page_token: break
        logger.info(f"Found {len(existing_events_set)} existing events details in Google Calendar for the week.")
    except HttpError as e:
        logger.error(f"Google API Error fetching existing events: {e.resp.status} - {e.content.decode()}")
        return jsonify({"error": "Error checking existing events on Google Calendar. Please try again later."}), 503
    except Exception as e:
        logger.exception(f"Unexpected error fetching existing Google events: {e}")
        return jsonify({"error": "Server error while checking existing events."}), 500

    # 6. Chuẩn bị Batch Request và xử lý sự kiện
    # (Giữ nguyên code phần này)
    batch = service.new_batch_http_request(callback=handle_batch_response)
    events_to_insert_count = 0; skipped_count = 0
    subject_color_map = {}; next_color_index = 0; num_colors = len(AVAILABLE_EVENT_COLORS)
    logger.info(f"Processing {len(schedule_list)} extracted events against {len(existing_events_set)} existing Google events...")
    for i, event_data in enumerate(schedule_list, 1):
        subject_name = event_data.get('subject', 'Unknown Subject'); start_iso = event_data['start_datetime']; end_iso = event_data['end_datetime']; room = event_data.get('room', 'N/A'); location_norm = room.strip()
        event_key_extracted = (subject_name, start_iso, end_iso, location_norm)
        if event_key_extracted not in existing_events_set:
            events_to_insert_count += 1
            if subject_name in subject_color_map: color_id = subject_color_map[subject_name]
            else: color_id = AVAILABLE_EVENT_COLORS[next_color_index % num_colors]; subject_color_map[subject_name] = color_id; logger.info(f"Assigning new color {color_id} to subject: '{subject_name}' (Index {next_color_index})"); next_color_index += 1
            logger.debug(f"Event {i} ('{subject_name}' - Color: {color_id}) marked for BATCH INSERT.")
            periods_text = f"\nTiết: {event_data.get('periods')}" if event_data.get('periods') else ""
            teacher_text = f"GV: {event_data.get('teacher', 'N/A')}"
            location_text = f"CS: {event_data.get('location', 'N/A')}"
            room_text = f"Phòng: {room}"
            desc_extra = event_data.get('description_extra', '')
            description = f"{teacher_text}\n{location_text}{periods_text}\n{room_text}{desc_extra}"
            event_body = { 'summary': subject_name, 'location': room, 'description': description, 'start': {'dateTime': start_iso, 'timeZone': 'Asia/Ho_Chi_Minh'}, 'end': {'dateTime': end_iso, 'timeZone': 'Asia/Ho_Chi_Minh'}, 'colorId': color_id, 'reminders': {'useDefault': False, 'overrides': [{'method': 'popup', 'minutes': 15}]}, }
            request_id_str = f"event-{i}-{subject_name[:15].replace(' ', '_')}"
            batch.add(service.events().insert(calendarId='primary', body=event_body), request_id=request_id_str)
        else:
            logger.info(f"Skipping event {i} (already exists in Google Calendar based on key): '{subject_name}' Start: {start_iso}"); skipped_count += 1

    # 7. Thực thi Batch Request nếu có sự kiện cần thêm
    # (Giữ nguyên code phần này)
    added_count = 0; error_count = 0
    if events_to_insert_count > 0:
        logger.info(f"Executing batch request to insert {events_to_insert_count} new events...")
        try:
            batch.execute()
            added_count = batch_results['added']
            error_count = batch_results['errors']
            logger.info(f"Batch execution finished. Callback results: Added={added_count}, Errors={error_count}")
            if error_count < (events_to_insert_count - added_count): logger.warning(f"Potential discrepancy in batch results. Expected inserts: {events_to_insert_count}, Callback Added: {added_count}, Callback Errors: {error_count}")
        except HttpError as e:
            logger.error(f"Batch execution failed entirely (HttpError): {e.resp.status} - {e.content.decode()}"); error_count = events_to_insert_count; added_count = 0
        except Exception as e:
            logger.exception(f"Batch execution failed entirely (Unexpected Error): {e}"); error_count = events_to_insert_count; added_count = 0
    else: logger.info("No new events to insert via batch request.")

    # 8. Trả kết quả cuối cùng về cho Extension
    # (Giữ nguyên code phần này)
    proc_time = time.time() - start_time_process
    summary_msg = f"Sync finished for week {week_start}-{week_end}: User={user_id or 'Unknown'}, Added={added_count}, Skipped={skipped_count}, Errors={error_count}, Time={proc_time:.2f}s"
    logger.info(summary_msg)
    response_message = f"Sync complete for week {week_start} - {week_end}."
    if added_count > 0: response_message += f" Added {added_count} event(s)."
    if skipped_count > 0: response_message += f" Skipped {skipped_count} existing event(s)."
    if error_count > 0: response_message += f" Encountered {error_count} error(s) during sync."
    return jsonify({"message": response_message, "week": f"{week_start}-{week_end}", "added": added_count, "skipped": skipped_count, "errors": error_count, "processing_time": round(proc_time, 2)})


# --- Khối chạy chính ---
if __name__ == "__main__":
    # (Giữ nguyên code phần này, nó sẽ không chạy trên Render khi dùng Gunicorn)
    print("-" * 50 + "\nStarting Flask Server - UEL Calendar Sync Backend (Batch Optimized)\n" + "-" * 50)
    # is_debug = os.environ.get('FLASK_DEBUG') == '1' or app.debug; print(f"[*] Flask Mode: {'DEBUG' if is_debug else 'PRODUCTION'}"); print(f"[*] Log Level Configured: {logging.getLevelName(log_level)}"); print(f"[*] Log Level Effective: {logging.getLevelName(logger.getEffectiveLevel())}"); print(f"[*] Log File: {os.path.abspath('calendar_sync.log')}"); print(f"[*] Timetable Table ID: {TIMETABLE_TABLE_ID}"); print(f"[*] Date Span ID: {DATE_SPAN_ID}"); print(f"[*] Available Event Colors: {AVAILABLE_EVENT_COLORS}"); print(f"[*] Server running at: http://localhost:5001"); print("-" * 50 + "\nNotes:\n- Backend uses Batch API Calls.\n- Check logs.\n- !! CHANGE app.secret_key !!\n" + "-" * 50)
    # Lấy port từ biến môi trường PORT hoặc dùng 5001 mặc định cho local
    port = int(os.environ.get('PORT', 5001))
    # Không dùng debug=True ở đây
    app.run(host="0.0.0.0", port=port)

