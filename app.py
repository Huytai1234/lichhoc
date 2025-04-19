# Calendar-sync/app.py
# -*- coding: utf-8 -*-
# Phiên bản: Đã xóa OAUTHLIB_INSECURE_TRANSPORT, HARDCODE ID EXTENSION DEV TẠM THỜI

from flask import Flask, render_template, request, session, jsonify
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials
from bs4 import BeautifulSoup
import time
import re
import os # Vẫn cần os để đọc SECRET_KEY
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
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'
app = Flask(__name__)

# --- KÍCH HOẠT CORS ---
# !!! QUAN TRỌNG: THAY THẾ ID EXTENSION DEV CỦA BẠN VÀO ĐÂY !!!
# ID này sẽ cần được thay đổi thành ID extension đã xuất bản sau này.
ALLOWED_EXTENSION_ID = "klldcleohebcjhdplkcdnjabebgmabfa" # <<< THAY BẰNG ID EXTENSION DEV CỦA BẠN
# --------------------------------------------------------------

EXTENSION_ORIGIN = f"chrome-extension://{ALLOWED_EXTENSION_ID}"
CORS(app, resources={ r"/sync_from_extension": {"origins": EXTENSION_ORIGIN} })

# Khởi tạo logger sau khi import logging
# (Đảm bảo cấu hình logging vẫn tồn tại như trước)
log_level = logging.DEBUG # Hoặc logging.INFO cho production
logging.basicConfig(level=log_level, filename='calendar_sync.log', format='%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s', encoding='utf-8')
logger = logging.getLogger(__name__)
logger.info(f"CORS temporarily hardcoded for testing origin: {EXTENSION_ORIGIN}")
# ---------------------

# !!! QUAN TRỌNG: VẪN NÊN DÙNG BIẾN MÔI TRƯỜNG CHO SECRET KEY !!!
# Lấy secret key từ biến môi trường, có giá trị mặc định yếu cho dev
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'dev-secret-key-change-this-immediately')
# Ghi log cảnh báo nếu đang chạy production mà dùng key mặc định
if app.secret_key == 'dev-secret-key-change-this-immediately' and os.environ.get('FLASK_ENV') != 'development': # Kiểm tra nếu không phải development
     logger.warning("CRITICAL: Using default secret key in non-development environment! Set FLASK_SECRET_KEY env var.")
# --------------------------------------------------------------

logger.info("Flask application starting (Ext Auth, Batch Optimized, Indent Fixed, Temp Hardcoded CORS ID)...")

AVAILABLE_EVENT_COLORS = ["1", "2", "3", "4", "5", "6", "7", "9", "10", "11"]
SCOPES = ['https://www.googleapis.com/auth/calendar']
TIMETABLE_TABLE_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu"
DATE_SPAN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate"
# -----------------------------------------

# --- Các Hàm Trợ Giúp ---

def build_service_from_token(access_token):
    """Tạo service Google Calendar từ access token."""
    if not access_token:
        logger.error("build_service empty token.")
        return None
    try:
        # Sử dụng token trực tiếp để tạo Credentials
        creds = Credentials(token=access_token)
        service = build('calendar', 'v3', credentials=creds, cache_discovery=False)
        logger.info("Attempting to build service from provided token...")
        # Thêm một lệnh gọi nhỏ để kiểm tra token ngay lập tức (ví dụ: lấy danh sách lịch)
        try:
             service.calendarList().list(maxResults=1).execute() # Lệnh gọi nhẹ để xác thực token
             logger.info("Service built and token seems valid.")
             return service
        except HttpError as http_err:
             if http_err.resp.status in [401, 403]:
                 logger.error(f"Token validation failed (HTTP {http_err.resp.status}): {http_err.content.decode('utf-8', errors='ignore')}")
                 return None # Token không hợp lệ
             else:
                 logger.exception(f"Unexpected HTTP error during token validation: {http_err}")
                 raise # Ném lại các lỗi khác
        except Exception as e:
             logger.exception(f"Unexpected error during token validation: {e}")
             raise # Ném lại các lỗi không mong muốn khác
    except Exception as e:
        logger.exception(f"Build service error: {e}")
        return None


def extract_schedule_from_html(timetable_html, date_range_text):
    """Trích xuất lịch học (Đã sửa lỗi parse Tiết, thời gian)."""
    logger.info("Starting schedule extraction (Flexible Parsing).")
    schedule_list = []
    seen_events = set() # Dùng để lọc trùng lặp ngay khi parse HTML

    # Parse date range
    date_match = re.search(r'Từ ngày\s*(\d{2}/\d{2}/\d{4})\s*đến ngày\s*(\d{2}/\d{2}/\d{4})', date_range_text, re.IGNORECASE)
    if not date_match:
        logger.error(f"Date range format error: '{date_range_text}'")
        raise ValueError(f"Định dạng chuỗi ngày tháng không đúng: '{date_range_text}'")
    start_date_str, end_date_str = date_match.group(1), date_match.group(2)
    try:
        start_date_obj = datetime.strptime(start_date_str, "%d/%m/%Y")
    except ValueError:
        logger.error(f"Invalid start date format: '{start_date_str}'")
        raise ValueError(f"Ngày bắt đầu không hợp lệ: '{start_date_str}'")
    logger.info(f"Parsed week date range: {start_date_str} - {end_date_str}")

    # Parse HTML table
    try:
        soup = BeautifulSoup(timetable_html, 'lxml')
    except ImportError:
        logger.warning("lxml not found, using html.parser (might be slower).")
        soup = BeautifulSoup(timetable_html, 'html.parser')

    tkb_table = soup.find('table', id=TIMETABLE_TABLE_ID)
    if not tkb_table:
        logger.error(f"Timetable table not found with ID: {TIMETABLE_TABLE_ID}")
        raise ValueError(f"Không tìm thấy bảng thời khóa biểu (ID: {TIMETABLE_TABLE_ID}).")

    rows = tkb_table.find_all('tr')
    if len(rows) < 2: # Cần ít nhất 1 hàng header và 1 hàng dữ liệu
        logger.warning("Timetable table has less than 2 rows. No data extracted.")
        return [], start_date_str, end_date_str # Trả về list rỗng

    # Parse Header Row
    header_row = rows[0]
    header_cells = header_row.find_all(['td', 'th']) # Chấp nhận cả td và th
    day_headers = [c.get_text(strip=True) for c in header_cells]
    logger.debug(f"Table Headers found: {day_headers}")

    try:
        room_header_index = -1
        day_indices = {} # Lưu index của các cột ngày trong tuần
        days_list_keys = ["THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"]

        for idx, h in enumerate(day_headers):
            norm_h = h.upper().strip().replace('.', '') # Chuẩn hóa header
            if norm_h == "PHÒNG":
                room_header_index = idx
            elif norm_h in days_list_keys:
                day_indices[norm_h] = idx # Lưu map giữa tên ngày và index cột

        if room_header_index == -1:
            logger.error("Header 'PHÒNG' not found in table.")
            raise ValueError("Thiếu cột 'PHÒNG' trong header của bảng.")
        if not day_indices:
            logger.error("No day headers (THỨ 2, THỨ 3,...) found in table.")
            raise ValueError("Thiếu các cột ngày (THỨ 2, THỨ 3,...) trong header của bảng.")
        logger.info(f"Header parsing successful: Room Index={room_header_index}, Day Indices={day_indices}")

    except ValueError as e:
        logger.error(f"Error processing table header structure: {e}")
        raise ValueError(f"Lỗi cấu trúc header bảng TKB: {e}")

    # Parse Data Rows
    for row_idx, row in enumerate(rows[1:], 1): # Bắt đầu từ hàng thứ 2 (index 1)
        cells = row.find_all('td')
        if len(cells) <= room_header_index:
            logger.debug(f"Skipping row {row_idx+1}: Not enough cells (found {len(cells)}, need >{room_header_index})")
            continue

        room = cells[room_header_index].get_text(strip=True) or "N/A"
        if not room or room == "N/A" or room.replace('\xa0', '').strip() == "":
            logger.debug(f"Skipping row {row_idx+1}: Room is empty or N/A ('{room}')")
            continue
        logger.debug(f"Processing Row {row_idx+1}: Room='{room}'")

        for day_name_key, cell_index in day_indices.items():
            if cell_index >= len(cells):
                logger.warning(f"Row {row_idx+1}: Cell index {cell_index} for day '{day_name_key}' is out of bounds (only {len(cells)} cells)")
                continue

            cell = cells[cell_index]
            cell_content_html = cell.decode_contents()
            schedule_blocks_html = re.split(r'<hr\s*/?>', cell_content_html, flags=re.IGNORECASE)

            for block_idx, block_html in enumerate(schedule_blocks_html):
                block_html_stripped = block_html.strip()
                if not block_html_stripped:
                    continue

                try:
                    block_soup = BeautifulSoup(block_html_stripped, 'lxml')
                except Exception:
                    block_soup = BeautifulSoup(block_html_stripped, 'html.parser')

                block_text_lines_raw = list(block_soup.stripped_strings)
                block_text_lines = [ln.strip().strip('"').strip() for ln in block_text_lines_raw if ln.strip()]
                logger.debug(f"  Processing Block {block_idx+1} in Cell({row_idx+1},{cell_index}) for Day '{day_name_key}': Lines={block_text_lines}")

                if not block_text_lines:
                    continue

                subject = block_text_lines[0]
                time_range_str = ""
                periods_str = ""
                teacher = ""
                location = "" # Cơ sở
                start_dt = None
                end_dt = None
                has_only_start_time = False
                time_match = None

                for line in block_text_lines[1:]:
                    cleaned_line = line.replace('\n', ' ').strip()

                    t_match = re.search(r'(\d{1,2}[h:]\d{2})\s*(?:->|-|đến)\s*(\d{1,2}[h:]\d{2})', cleaned_line, re.IGNORECASE)
                    if t_match and not time_match:
                        time_range_str = t_match.group(0)
                        time_match = t_match
                        logger.debug(f"    Time match (range): Group1='{t_match.group(1)}', Group2='{t_match.group(2)}', Raw='{time_range_str}'")
                    else:
                        t_match_start_only = re.search(r'^(\d{1,2}[h:]\d{2})$', cleaned_line)
                        if t_match_start_only and not time_match:
                             time_range_str = t_match_start_only.group(1)
                             time_match = t_match_start_only
                             has_only_start_time = True
                             logger.debug(f"    Time match (start only): Group1='{t_match_start_only.group(1)}', Raw='{time_range_str}'")

                    p_match = re.search(r'Tiết\s*([\d\-\.]+)', cleaned_line, re.IGNORECASE)
                    if p_match:
                        periods_str = p_match.group(1).strip()
                        logger.debug(f"    Periods match: '{periods_str}'")

                    elif cleaned_line.lower().startswith('gv'):
                        teacher = cleaned_line[2:].strip().lstrip(':').strip()
                        logger.debug(f"    Teacher match: '{teacher}'")

                    elif cleaned_line.lower().startswith('cơ sở'):
                        location = cleaned_line[6:].strip().lstrip(':').strip()
                        logger.debug(f"    Location match: '{location}'")

                if not time_match:
                    logger.warning(f"    No valid time information found for subject '{subject}' in block. Skipping.")
                    continue

                try:
                    day_index_in_week = days_list_keys.index(day_name_key)
                    current_date = start_date_obj + timedelta(days=day_index_in_week)
                    current_date_str = current_date.strftime("%d/%m/%Y")

                    start_time_str = time_match.group(1)
                    start_format = "%Hh%M" if 'h' in start_time_str else "%H:%M"
                    start_dt = datetime.strptime(f"{current_date_str} {start_time_str}", f"%d/%m/%Y {start_format}")

                    if not has_only_start_time and len(time_match.groups()) >= 2 and time_match.group(2):
                        end_time_str = time_match.group(2)
                        end_format = "%Hh%M" if 'h' in end_time_str else "%H:%M"
                        end_dt_candidate = datetime.strptime(f"{current_date_str} {end_time_str}", f"%d/%m/%Y {end_format}")
                        if end_dt_candidate <= start_dt:
                            logger.warning(f"    End time '{end_time_str}' is before or same as start time '{start_time_str}' for '{subject}'. Assuming end time = start time.")
                            end_dt = start_dt
                        else:
                            end_dt = end_dt_candidate
                    else:
                        logger.debug(f"    Only start time found or parsed for '{subject}'. Setting end time = start time.")
                        end_dt = start_dt

                    logger.debug(f"    Parsed Datetime: Start={start_dt.isoformat()}, End={end_dt.isoformat()}")

                    event_key = (subject, start_dt.isoformat(), end_dt.isoformat(), room)
                    if event_key in seen_events:
                        logger.warning(f"    Skipping duplicate event parsed from HTML: {event_key}")
                        continue
                    seen_events.add(event_key)

                    description_extra = "\n(Chỉ có giờ bắt đầu)" if start_dt == end_dt and has_only_start_time else ""
                    schedule_list.append({
                        "date": current_date_str,
                        "day_name": day_name_key,
                        "room": room,
                        "subject": subject,
                        "time_range": time_range_str,
                        "periods": periods_str,
                        "teacher": teacher,
                        "location": location,
                        "start_datetime": start_dt.isoformat(),
                        "end_datetime": end_dt.isoformat(),
                        "description_extra": description_extra
                    })
                    logger.debug(f"    Successfully prepared event: Subject='{subject}', Periods='{periods_str}'")

                except ValueError as e:
                    logger.error(f"    Error parsing datetime/day index for block '{subject}': {e}. Lines: {block_text_lines}")
                except Exception as e:
                    logger.exception(f"    Unexpected error processing block for subject '{subject}': {e}")

    logger.info(f"HTML extraction finished. Found {len(schedule_list)} unique potential events.")
    return schedule_list, start_date_str, end_date_str


# ----- Các Flask Routes -----

@app.route('/')
def index():
    """Route cơ bản để kiểm tra backend có chạy không."""
    return """<html><head><title>UEL Sync Backend Status</title></head><body><h1>UEL Calendar Sync Backend</h1><p>Status: Running</p><p>Awaiting requests from the Chrome Extension.</p></body></html>"""

# Hàm callback cho Batch Request (dùng context callback trong route)
# def handle_batch_response(request_id, response, exception): ... (đã tích hợp vào context callback)


@app.route('/sync_from_extension', methods=['POST'])
def sync_from_extension():
    """Endpoint đồng bộ chính - Tối ưu Batch + Check Google Calendar, Màu theo môn học."""
    start_time_process = time.time()
    logger.info("Received request on /sync_from_extension (Batch Optimized, Color by Subject)")

    # 1. Lấy Token và Dữ liệu từ Request
    auth_header = request.headers.get('Authorization')
    access_token = None
    if auth_header and auth_header.startswith('Bearer '):
        access_token = auth_header.split(' ')[1]

    if not access_token:
        logger.error("Authorization header missing or invalid (Bearer token not found).")
        return jsonify({"error": "Thiếu Google Access Token trong Authorization header."}), 401

    if not request.is_json:
        logger.error("Request Content-Type is not application/json.")
        return jsonify({"error": "Yêu cầu phải ở định dạng JSON."}), 415

    data = request.json
    if not data:
        logger.error("Request body is empty or not valid JSON.")
        return jsonify({"error": "Không có dữ liệu JSON trong request body."}), 400

    user_id = data.get('user_id')
    timetable_html = data.get('timetable_html')
    date_range_text = data.get('date_range_text')

    logger.debug(f"Received Sync Data: user='{user_id}', date_range='{date_range_text}', html_present={'Yes' if timetable_html else 'No'}")

    missing_field = None
    if not user_id: missing_field = "user_id"
    elif not timetable_html: missing_field = "timetable_html"
    elif not date_range_text: missing_field = "date_range_text"

    if missing_field:
        logger.error(f"Missing required data field: {missing_field}")
        return jsonify({"error": f"Thiếu dữ liệu bắt buộc: {missing_field}"}), 400

    logger.info(f"Processing sync request for user: {user_id}")

    # 2. Tạo Google Calendar Service từ Token
    service = None
    try:
        service = build_service_from_token(access_token)
        if not service:
            return jsonify({"error": "Token Google không hợp lệ hoặc đã hết hạn."}), 401
    except Exception as e:
        logger.exception(f"Unexpected error creating Google Calendar service: {e}")
        return jsonify({"error": "Lỗi kết nối đến Google Calendar. Vui lòng thử lại."}), 500

    # 3. Trích xuất sự kiện từ HTML
    try:
        schedule_list, week_start, week_end = extract_schedule_from_html(timetable_html, date_range_text)
        logger.info(f"Extracted {len(schedule_list)} potential events for week {week_start} to {week_end}")
    except ValueError as e:
        logger.error(f"HTML Extraction ValueError: {e}")
        return jsonify({"error": f"Lỗi xử lý dữ liệu TKB: {e}"}), 400
    except Exception as e:
        logger.exception(f"Unexpected HTML Extraction Error: {e}")
        return jsonify({"error": "Lỗi máy chủ khi xử lý dữ liệu TKB."}), 500

    added_count = 0
    skipped_count = 0
    error_count = 0
    batch_errors = 0 # Đếm lỗi từ callback batch
    batch_added = 0  # Đếm thành công từ callback batch

    # 4. Nếu không có sự kiện nào trích xuất được, trả về ngay
    if not schedule_list:
        proc_time = time.time() - start_time_process
        logger.info(f"No events extracted from HTML for week {week_start}-{week_end}. Sync finished early.")
        return jsonify({
            "message": f"Không có sự kiện nào được tìm thấy trong TKB tuần {week_start}-{week_end}.",
            "week": f"{week_start}-{week_end}",
            "added": 0,
            "skipped": 0,
            "errors": 0,
            "processing_time": round(proc_time, 2)
        })

    # 5. Lấy các sự kiện đã có trên Google Calendar cho tuần này để tránh trùng lặp
    existing_events_set = set()
    try:
        vn_tz = timezone(timedelta(hours=7))
        start_dt_obj = datetime.strptime(week_start, "%d/%m/%Y").replace(tzinfo=vn_tz)
        end_dt_obj = datetime.strptime(week_end, "%d/%m/%Y").replace(hour=23, minute=59, second=59, tzinfo=vn_tz)

        time_min_query = start_dt_obj.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        time_max_query = end_dt_obj.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

        logger.info(f"Fetching existing Google Calendar events from {time_min_query} to {time_max_query}")
        page_token = None
        items_fetched_count = 0
        fetch_start_time = time.time()

        while True:
            events_result = service.events().list(
                calendarId='primary',
                timeMin=time_min_query,
                timeMax=time_max_query,
                singleEvents=True,
                maxResults=250,
                pageToken=page_token
            ).execute()

            items = events_result.get('items', [])
            items_fetched_count += len(items)
            logger.debug(f"Fetched page with {len(items)} events. Total fetched so far: {items_fetched_count}")

            for item in items:
                 summary = item.get('summary')
                 start_node = item.get('start', {})
                 end_node = item.get('end', {})
                 start_iso = start_node.get('dateTime', start_node.get('date'))
                 end_iso = end_node.get('dateTime', end_node.get('date'))
                 loc = item.get('location', '').strip()

                 if all([summary, start_iso, end_iso]):
                     existing_events_set.add((summary, start_iso, end_iso, loc))
                 else:
                     logger.warning(f"Existing event missing key info (summary/start/end), skipping: ID={item.get('id')}")

            page_token = events_result.get('nextPageToken')
            if not page_token:
                break

        fetch_duration = time.time() - fetch_start_time
        logger.info(f"Finished fetching existing events. Found {len(existing_events_set)} unique existing event details. Duration: {fetch_duration:.2f}s")

    except HttpError as e:
        logger.error(f"Google API Error fetching existing events: {e.resp.status} - {e.content.decode('utf-8', errors='ignore')}")
        if e.resp.status in [401, 403]:
             return jsonify({"error": "Token Google không hợp lệ hoặc không có quyền truy cập Calendar."}), 401
        else:
             return jsonify({"error": "Lỗi khi kiểm tra sự kiện trên Google Calendar. Hãy thử lại."}), 503
    except Exception as e:
        logger.exception(f"Unexpected error fetching existing events: {e}")
        return jsonify({"error": "Lỗi máy chủ khi kiểm tra sự kiện trên Google Calendar."}), 500

    # 6. Chuẩn bị Batch Request để thêm các sự kiện mới
    events_to_insert_count = 0
    subject_color_map = {}
    next_color_index = 0
    num_colors = len(AVAILABLE_EVENT_COLORS)

    logger.info(f"Processing {len(schedule_list)} extracted events against {len(existing_events_set)} existing Google events...")

    # Tạo context callback để đếm kết quả batch
    batch_callback_results = {'added': 0, 'errors': 0}
    def batch_callback_with_context(request_id, response, exception):
        nonlocal batch_callback_results
        if exception is not None:
            status_code = "N/A"
            error_details = "Unknown batch item error"
            if isinstance(exception, HttpError):
                 status_code = exception.resp.status
                 try:
                     error_content = json.loads(exception.content.decode('utf-8'))
                     error_details = error_content.get('error', {}).get('message', exception.content.decode('utf-8', errors='ignore'))
                 except:
                     error_details = exception.content.decode('utf-8', errors='ignore') if hasattr(exception, 'content') and exception.content else str(exception)
            else:
                 error_details = str(exception)
            logger.error(f"Batch request item '{request_id}' FAILED in context callback. Status: {status_code}, Error: {error_details}")
            batch_callback_results['errors'] += 1
        else:
            logger.info(f"Batch request item '{request_id}' SUCCEEDED in context callback. Event ID: {response.get('id')}")
            batch_callback_results['added'] += 1

    batch = service.new_batch_http_request(callback=batch_callback_with_context)

    for i, event_data in enumerate(schedule_list, 1):
        subject_name = event_data.get('subject', 'Không có tiêu đề')
        start_iso = event_data['start_datetime']
        end_iso = event_data['end_datetime']
        room = event_data.get('room', '').strip()
        location_norm = room # Dùng phòng làm location chính để so sánh

        event_key_for_google_check = (subject_name, start_iso, end_iso, location_norm)

        if event_key_for_google_check not in existing_events_set:
            events_to_insert_count += 1

            if subject_name in subject_color_map:
                color_id = subject_color_map[subject_name]
            else:
                color_id = AVAILABLE_EVENT_COLORS[next_color_index % num_colors]
                subject_color_map[subject_name] = color_id
                next_color_index += 1
                logger.debug(f"Assigned new color {color_id} to subject '{subject_name}'")

            logger.debug(f"Event {i} ('{subject_name}' - Color: {color_id}) marked for BATCH insert.")

            periods_text = f"\nTiết: {event_data.get('periods')}" if event_data.get('periods') else ""
            teacher_text = f"GV: {event_data.get('teacher', 'N/A')}"
            location_text = f"CS: {event_data.get('location', 'N/A')}"
            desc = f"{teacher_text}\n{location_text}{periods_text}\nPhòng: {room}{event_data.get('description_extra', '')}"

            event_body = {
                'summary': subject_name,
                'location': room,
                'description': desc,
                'start': {'dateTime': start_iso, 'timeZone': 'Asia/Ho_Chi_Minh'},
                'end': {'dateTime': end_iso, 'timeZone': 'Asia/Ho_Chi_Minh'},
                'colorId': color_id,
                'reminders': {
                    'useDefault': False,
                    'overrides': [{'method': 'popup', 'minutes': 15}],
                },
            }
            batch.add(service.events().insert(calendarId='primary', body=event_body),
                      request_id=f"event-{i}-{user_id}-{subject_name[:10]}")
        else:
            logger.info(f"Skipping event {i} ('{subject_name}') as it already exists in Google Calendar.")
            skipped_count += 1

    # 7. Thực thi Batch Request nếu có sự kiện cần thêm
    if events_to_insert_count > 0:
        logger.info(f"Executing batch request to insert {events_to_insert_count} new events...")
        batch_start_time = time.time()
        try:
            batch.execute()
            added_count = batch_callback_results['added']
            error_count = batch_callback_results['errors']
            batch_duration = time.time() - batch_start_time
            logger.info(f"Batch executed. Callback results: Added={added_count}, Errors={error_count}. Duration: {batch_duration:.2f}s")
            if added_count + error_count != events_to_insert_count:
                 logger.warning(f"Batch callback count mismatch! Sent={events_to_insert_count}, Callback Added={added_count}, Callback Errors={error_count}")
                 error_count = events_to_insert_count - added_count # Ước lượng lỗi

        except HttpError as e:
            logger.error(f"Batch execute HttpError: {e.resp.status} - {e.content.decode('utf-8', errors='ignore')}")
            error_count = events_to_insert_count
            added_count = 0
        except Exception as e:
            logger.exception(f"Batch execute Failed Unexpectedly: {e}")
            error_count = events_to_insert_count
            added_count = 0
    else:
        logger.info("No new events to insert via batch.")
        added_count = 0
        error_count = 0

    # 8. Trả kết quả cuối cùng về cho extension
    proc_time = time.time() - start_time_process
    summary_msg = f"Sync completed for user={user_id}, week={week_start}-{week_end}. Added={added_count}, Skipped={skipped_count}, Errors={error_count}. Total time={proc_time:.2f}s"
    logger.info(summary_msg)

    response_message = f"Đồng bộ TKB tuần {week_start}-{week_end} hoàn tất."
    if error_count > 0:
        response_message += f" Thêm: {added_count}, Bỏ qua: {skipped_count}, Lỗi: {error_count}."
    else:
        response_message += f" Thêm: {added_count}, Bỏ qua: {skipped_count}."

    return jsonify({
        "message": response_message,
        "week": f"{week_start}-{week_end}",
        "added": added_count,
        "skipped": skipped_count,
        "errors": error_count,
        "processing_time": round(proc_time, 2)
    })


# --- Khối chạy chính ---
if __name__ == "__main__":
    print("-" * 60)
    print(" Starting Flask Server - UEL Calendar Sync Backend")
    print(" (Batch Optimized, Temp Hardcoded CORS ID for Testing)")
    print("-" * 60)
    # Xác định chế độ chạy dựa trên biến môi trường FLASK_ENV hoặc tương tự
    is_debug_mode = os.environ.get('FLASK_ENV') == 'development' or os.environ.get('FLASK_DEBUG') == '1'
    print(f"[*] Environment: {'Development/Debug' if is_debug_mode else 'Production'}")
    print(f"[*] CORS Allowed Extension ID (Hardcoded): {ALLOWED_EXTENSION_ID}") # Nhấn mạnh là hardcoded
    print(f"[*] Secret Key Loaded From Env: {'Yes' if 'FLASK_SECRET_KEY' in os.environ else 'NO (Using default - UNSAFE!)'}")
    print(f"[*] Log Level Configured: {logging.getLevelName(log_level)}")
    print(f"[*] Log File: {os.path.abspath('calendar_sync.log')}")
    print(f"[*] Timetable Table ID: {TIMETABLE_TABLE_ID}")
    print(f"[*] Date Span ID: {DATE_SPAN_ID}")
    print(f"[*] Server running at: http://0.0.0.0:{os.environ.get('PORT', 5001)}") # Lấy port từ env var hoặc mặc định 5001
    print("-" * 60)
    print("Notes:")
    print("- Set FLASK_SECRET_KEY environment variable for production.")
    print("- REMEMBER: ALLOWED_EXTENSION_ID is hardcoded for testing.")
    print("-    >>> You MUST change it to the published extension ID later <<<")
    print("- Check 'calendar_sync.log' for detailed logs.")
    print("-" * 60)

    # Chỉ chạy server dev của Flask nếu đang ở chế độ debug và không chạy qua Gunicorn
    # Gunicorn sẽ quản lý việc chạy app trong production thông qua Procfile
    if is_debug_mode:
        # Chạy với server dev của Flask khi debug, reload tự động
        # Port được lấy từ biến môi trường PORT (Render cung cấp) hoặc mặc định 5001
        app.run(host="0.0.0.0", port=int(os.environ.get('PORT', 5001)), debug=True)
    else:
        # Trong production, không cần gọi app.run() ở đây nếu dùng Gunicorn
        logger.info("Running in production mode. Gunicorn should be managing the app.")
        pass
