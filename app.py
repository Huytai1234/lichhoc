from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, StaleElementReferenceException
from webdriver_manager.chrome import ChromeDriverManager
from google_auth_oauthlib.flow import Flow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
import time
import re
import os
import pickle
import stat
import logging
from datetime import datetime, timedelta
from werkzeug.wrappers import Response

os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

app = Flask(__name__)
app.secret_key = 'my-secret-key'

logging.basicConfig(level=logging.INFO, filename='calendar_sync.log')
logging.info("Bắt đầu đồng bộ lịch học...")
logger = logging.getLogger(__name__)

DAY_COLORS = {
    "THỨ 2": "11", "THỨ 3": "5", "THỨ 4": "9", "THỨ 5": "4",
    "THỨ 6": "7", "THỨ 7": "10", "CHỦ NHẬT": "3"
}

global_driver = None
SCOPES = ['https://www.googleapis.com/auth/calendar']
REDIRECT_URI = 'http://localhost:5001/oauth2callback'

def setup_driver():
    chrome_options = Options()
    try:
        driver_path = ChromeDriverManager().install()
        logger.info(f"Initial ChromeDriver path: {driver_path}")

        if "THIRD_PARTY_NOTICES" in driver_path or not os.path.isfile(driver_path):
            driver_dir = os.path.dirname(driver_path)
            correct_driver_path = os.path.join(driver_dir, "chromedriver")
            if os.path.isfile(correct_driver_path):
                driver_path = correct_driver_path
            else:
                raise FileNotFoundError(f"Cannot find chromedriver executable in {driver_dir}")

        st = os.stat(driver_path)
        os.chmod(driver_path, st.st_mode | stat.S_IEXEC)
        logger.info(f"Set executable permissions for: {driver_path}")

        driver = webdriver.Chrome(service=Service(executable_path=driver_path), options=chrome_options)
        logger.info("ChromeDriver initialized successfully")
        return driver
    except Exception as e:
        logger.error(f"Failed to setup ChromeDriver: {str(e)}")
        raise

def get_google_calendar_service(user_id):
    token_file = f"token_{user_id}.pickle"
    creds = None
    used_existing_token = False
    if os.path.exists(token_file):
        with open(token_file, 'rb') as token:
            creds = pickle.load(token)
        used_existing_token = True
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = Flow.from_client_secrets_file('11.json', scopes=SCOPES, redirect_uri=REDIRECT_URI)
            auth_url, state = flow.authorization_url(prompt='consent')
            session['state'] = state
            session['user_id'] = user_id
            return redirect(auth_url), False
    return build('calendar', 'v3', credentials=creds), used_existing_token

@app.route('/oauth2callback')
def oauth2callback():
    state = session.get('state')
    user_id = session.get('user_id')
    flow = Flow.from_client_secrets_file('11.json', scopes=SCOPES, state=state, redirect_uri=REDIRECT_URI)
    flow.fetch_token(authorization_response=request.url)
    creds = flow.credentials
    token_file = f"token_{user_id}.pickle"
    with open(token_file, 'wb') as token:
        pickle.dump(creds, token)
    return redirect(url_for('options'))

def extract_schedule_for_week(driver, wait, start_date_obj, week_value):
    select_tuan = Select(wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan"))))
    select_tuan.select_by_value(week_value)
    time.sleep(5)
    date_span = wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate")))
    date_text = date_span.text.strip()
    date_match = re.search(r'Từ ngày (\d{2}/\d{2}/\d{4}) đến ngày (\d{2}/\d{2}/\d{4})', date_text)
    if not date_match:
        raise ValueError("Không phân tích được ngày của tuần.")
    start_date = date_match.group(1)
    end_date = date_match.group(2)
    tkb_table = wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu")))
    rows = tkb_table.find_elements(By.TAG_NAME, "tr")
    header_row = rows[0]
    day_headers = [th.text for th in header_row.find_elements(By.TAG_NAME, "td") if
                   th.text in ["PHÒNG", "THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"]]
    if not day_headers:
        raise ValueError("Không tìm thấy header.")
    room_header_index = day_headers.index("PHÒNG") if "PHÒNG" in day_headers else 0
    schedule_list = []
    seen_events = set()  # Để kiểm tra sự kiện trùng lặp trong schedule_list
    for row in rows[1:]:
        cells = row.find_elements(By.TAG_NAME, "td")
        if len(cells) > room_header_index:
            room = cells[room_header_index].text or "Không xác định"
            if not room.strip():
                continue
            for i, cell in enumerate(cells[room_header_index + 1:], room_header_index + 1):
                if cell.text.strip() and not cell.text.strip() == "    ":
                    if i - 1 < len(day_headers) and day_headers[i] in DAY_COLORS:
                        day_name = day_headers[i]
                    else:
                        continue
                    day_offset = ["THỨ 2", "THỨ 3", "THỨ 4", "THỨ 5", "THỨ 6", "THỨ 7", "CHỦ NHẬT"].index(day_name)
                    current_date = datetime.strptime(start_date, "%d/%m/%Y") + timedelta(days=day_offset)
                    current_date_str = current_date.strftime("%d/%m/%Y")
                    cell_html = cell.get_attribute("innerHTML")
                    schedule_blocks = re.split(r'<hr>', cell_html.replace('<br>', '\n'))
                    for block in schedule_blocks:
                        if not block.strip():
                            continue
                        block_text = block.strip().replace('<b>', '').replace('</b>', '')
                        lines = [line.strip() for line in block_text.split('\n') if line.strip()]
                        subject = lines[0] if lines else ""
                        time_range = lines[1] if len(lines) > 1 else ""
                        periods = next((line for line in lines[2:] if "Tiết" in line), "") if len(lines) > 2 else ""
                        teacher = next((line.replace("GV: ", "") for line in lines[2:] if "GV:" in line), "") if len(
                            lines) > 2 else ""
                        location = next((line.replace("Cơ sở: ", "") for line in lines[2:] if "Cơ sở:" in line),
                                        "") if len(lines) > 2 else ""
                        if subject:
                            time_parts = re.findall(r'(\d{1,2}h\d{2})', time_range)
                            start_datetime = datetime.strptime(f"{current_date_str} {time_parts[0]}", "%d/%m/%Y %Hh%M")
                            end_datetime = start_datetime + timedelta(hours=2) if len(
                                time_parts) == 1 else datetime.strptime(f"{current_date_str} {time_parts[1]}",
                                                                        "%d/%m/%Y %Hh%M")
                            event_key = (subject, start_datetime.isoformat(), end_datetime.isoformat(), room)
                            if event_key in seen_events:
                                continue  # Bỏ qua nếu sự kiện đã tồn tại trong schedule_list
                            seen_events.add(event_key)
                            schedule_list.append({
                                "date": current_date_str, "day_name": day_name, "room": room, "subject": subject,
                                "time_range": time_range, "periods": periods, "teacher": teacher, "location": location,
                                "start_datetime": start_datetime.isoformat(), "end_datetime": end_datetime.isoformat(),
                                "color_id": DAY_COLORS.get(day_name, "1")
                            })
    return schedule_list, start_date, end_date

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/start', methods=['POST'])
def start():
    global global_driver
    user_id = request.form.get('user_id')
    if not user_id:
        return render_template('index.html', error="Vui lòng nhập định danh!")
    if not re.match(r'^[a-zA-Z0-9._%+-]+@st\.uel\.edu\.vn$', user_id):
        return render_template('index.html',
                               error="Định danh không hợp lệ! Vui lòng sử dụng email sinh viên UEL (ví dụ: tenban@st.uel.edu.vn).")
    session['user_id'] = user_id
    driver = setup_driver()
    global_driver = driver
    driver.get("https://myuel.uel.edu.vn/")
    wait = WebDriverWait(driver, 90)
    try:
        hoc_tap_giang_day = wait.until(EC.element_to_be_clickable((By.ID, "ctl11_btLoginUIS")))
        hoc_tap_giang_day.click()
    except (TimeoutException, NoSuchElementException):
        pass
    wait.until(lambda driver: "myuel.uel.edu.vn" in driver.current_url)
    wait.until(EC.presence_of_element_located((By.XPATH, "//span[@class='rpText' and text()='Học vụ']")))
    hoc_vu_menu = wait.until(EC.element_to_be_clickable(
        (By.XPATH, "//a[contains(@class, 'rpLink') and .//span[@class='rpText' and text()='Học vụ']]")))
    hoc_vu_menu.click()
    time.sleep(2)
    thoikhoabieu_link = wait.until(EC.element_to_be_clickable(
        (By.XPATH, "//a[.//span[@class='rpText' and text()='Thời khóa biểu'] and contains(@href, 'Ph3wLiN1yCA')]")))
    thoikhoabieu_link.click()
    time.sleep(5)
    wait.until(EC.presence_of_element_located(
        (By.XPATH, "//a[contains(text(), 'In thời khóa biểu') and contains(@href, 'Print.aspx')]")))
    nam_hoc_dropdown = wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlNamHoc")))
    select_nam_hoc = Select(nam_hoc_dropdown)
    nam_hoc_options = [option.text for option in select_nam_hoc.options]
    hoc_ky_dropdown = wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlHocKy")))
    select_hoc_ky = Select(hoc_ky_dropdown)
    hoc_ky_options = [option.text for option in select_hoc_ky.options]
    session['nam_hoc_options'] = nam_hoc_options
    session['hoc_ky_options'] = hoc_ky_options
    session['selected_nam_hoc'] = nam_hoc_options[0]
    session['selected_hoc_ky'] = hoc_ky_options[0]
    session['week_list'] = []
    return redirect(url_for('options'))

@app.route('/options')
def options():
    return render_template('options.html',
                           nam_hoc_options=session.get('nam_hoc_options', []),
                           hoc_ky_options=session.get('hoc_ky_options', []),
                           week_list=session.get('week_list', []),
                           selected_nam_hoc=session.get('selected_nam_hoc', ''),
                           selected_hoc_ky=session.get('selected_hoc_ky', ''))

@app.route('/update_hoc_ky', methods=['POST'])
def update_hoc_ky():
    global global_driver
    if not global_driver:
        return "Driver không tồn tại, vui lòng bắt đầu lại!", 500
    driver = global_driver
    wait = WebDriverWait(driver, 90)
    nam_hoc = request.form.get('nam_hoc')

    Select(wait.until(EC.presence_of_element_located(
        (By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlNamHoc")))).select_by_visible_text(nam_hoc)
    time.sleep(2)

    hoc_ky_dropdown = wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlHocKy")))
    select_hoc_ky = Select(hoc_ky_dropdown)
    hoc_ky_options = [option.text for option in select_hoc_ky.options]

    session['hoc_ky_options'] = hoc_ky_options
    session['selected_nam_hoc'] = nam_hoc
    session['selected_hoc_ky'] = hoc_ky_options[0] if hoc_ky_options else ""
    session['week_list'] = []

    return jsonify({'hoc_ky_options': hoc_ky_options, 'selected_hoc_ky': session['selected_hoc_ky']})

@app.route('/update_weeks', methods=['POST'])
def update_weeks():
    global global_driver
    if not global_driver:
        return jsonify({'error': 'Driver không tồn tại, vui lòng bắt đầu lại!'}), 500
    driver = global_driver
    wait = WebDriverWait(driver, 90)
    nam_hoc = request.form.get('nam_hoc')
    hoc_ky = request.form.get('hoc_ky')

    try:
        Select(wait.until(EC.presence_of_element_located(
            (By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlNamHoc")))).select_by_visible_text(nam_hoc)
        time.sleep(2)

        hoc_ky_dropdown = wait.until(
            EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlHocKy")))
        select_hoc_ky = Select(hoc_ky_dropdown)
        hoc_ky_options = [option.text for option in select_hoc_ky.options]

        if hoc_ky not in hoc_ky_options:
            logger.warning(f"Học kỳ '{hoc_ky}' không tồn tại trong danh sách: {hoc_ky_options}")
            hoc_ky = hoc_ky_options[0] if hoc_ky_options else ""

        select_hoc_ky.select_by_visible_text(hoc_ky)
        time.sleep(5)

        tuan_dropdown = wait.until(
            EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan")))
        select_tuan = Select(tuan_dropdown)
        select_tuan.select_by_index(0)
        time.sleep(2)

        date_span = wait.until(
            EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate")))
        date_match = re.search(r'Từ ngày (\d{2}/\d{2}/\d{4}) đến ngày (\d{2}/\d{2}/\d{4})', date_span.text.strip())
        week1_start_date = datetime.strptime(date_match.group(1), "%d/%m/%Y") if date_match else None

        tuan_options = wait.until(
            EC.presence_of_all_elements_located(
                (By.XPATH, "//select[@id='portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan']/option"))
        )

        week_list = []
        for i, option in enumerate(tuan_options):
            option_text = option.text.strip()
            option_value = option.get_attribute("value")
            if option_text == "Tất cả":
                continue
            start_date = week1_start_date + timedelta(days=7 * i)
            end_date = start_date + timedelta(days=6)
            week_list.append({
                "index": i, "text": option_text, "value": option_value,
                "start_date": start_date.strftime("%d/%m/%Y"), "end_date": end_date.strftime("%d/%m/%Y")
            })

        session['week_list'] = week_list
        session['selected_nam_hoc'] = nam_hoc
        session['selected_hoc_ky'] = hoc_ky

        return jsonify({'week_list': week_list})
    except Exception as e:
        logger.error(f"Lỗi trong update_weeks: {str(e)}")
        return jsonify({'error': f"Không thể cập nhật tuần: {str(e)}"}), 500

def check_event_exists(service, event_body):
    """Kiểm tra xem sự kiện đã tồn tại trên Google Calendar hay chưa."""
    try:
        start_time = event_body['start']['dateTime']
        end_time = event_body['end']['dateTime']
        summary = event_body['summary']
        location = event_body['location']

        events_result = service.events().list(
            calendarId='primary',
            timeMin=start_time,
            timeMax=end_time,
            q=summary,
            singleEvents=True,
            orderBy='startTime'
        ).execute()

        events = events_result.get('items', [])
        for event in events:
            if (event.get('summary') == summary and
                event.get('location') == location and
                event['start'].get('dateTime') == start_time and
                event['end'].get('dateTime') == end_time):
                return True
        return False
    except Exception as e:
        logger.error(f"Lỗi khi kiểm tra sự kiện trùng lặp: {str(e)}")
        return False

@app.route('/sync', methods=['POST'])
def sync():
    global global_driver
    if not global_driver:
        return "Driver không tồn tại, vui lòng bắt đầu lại!", 500
    driver = global_driver
    wait = WebDriverWait(driver, 90)
    user_id = session.get('user_id')
    nam_hoc = request.form.get('nam_hoc')
    hoc_ky = request.form.get('hoc_ky')
    week_indices = request.form.getlist('weeks')
    mode = request.form.get('mode')

    Select(wait.until(EC.presence_of_element_located(
        (By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlNamHoc")))).select_by_visible_text(nam_hoc)
    time.sleep(2)

    Select(wait.until(EC.presence_of_element_located(
        (By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlHocKy")))).select_by_visible_text(hoc_ky)
    time.sleep(5)

    try:
        iframes = driver.find_elements(By.TAG_NAME, "iframe")
        for iframe in iframes:
            driver.switch_to.frame(iframe)
            try:
                tuan_dropdown = wait.until(
                    EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan")))
                break
            except:
                driver.switch_to.default_content()
    except:
        driver.switch_to.default_content()

    tuan_dropdown = wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan")))
    select_tuan = Select(tuan_dropdown)
    select_tuan.select_by_index(0)
    wait.until(EC.presence_of_all_elements_located(
        (By.XPATH, "//select[@id='portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan']/option")))

    tuan_options = wait.until(
        EC.presence_of_all_elements_located(
            (By.XPATH, "//select[@id='portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan']/option"))
    )

    date_span = wait.until(
        EC.presence_of_element_located((By.ID, "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate")))
    date_match = re.search(r'Từ ngày (\d{2}/\d{2}/\d{4}) đến ngày (\d{2}/\d{2}/\d{4})', date_span.text.strip())
    week1_start_date = datetime.strptime(date_match.group(1), "%d/%m/%Y") if date_match else None

    week_list = []
    for i, option in enumerate(tuan_options):
        try:
            option_text = option.text.strip()
            option_value = option.get_attribute("value")
            if option_text == "Tất cả":
                continue
            start_date = week1_start_date + timedelta(days=7 * i)
            end_date = start_date + timedelta(days=6)
            week_list.append({
                "index": i, "text": option_text, "value": option_value,
                "start_date": start_date.strftime("%d/%m/%Y"), "end_date": end_date.strftime("%d/%m/%Y")
            })
        except StaleElementReferenceException:
            tuan_options = wait.until(
                EC.presence_of_all_elements_located(
                    (By.XPATH, "//select[@id='portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan']/option"))
            )
            option = tuan_options[i]
            option_text = option.text.strip()
            option_value = option.get_attribute("value")
            if option_text == "Tất cả":
                continue
            start_date = week1_start_date + timedelta(days=7 * i)
            end_date = start_date + timedelta(days=6)
            week_list.append({
                "index": i, "text": option_text, "value": option_value,
                "start_date": start_date.strftime("%d/%m/%Y"), "end_date": end_date.strftime("%d/%m/%Y")
            })

    service, used_existing_token = get_google_calendar_service(user_id)
    if isinstance(service, Response):
        return service

    updated_weeks = []
    skipped_weeks = []
    if mode == "1":
        for idx in map(int, week_indices):
            week = week_list[idx]
            schedule_list, start_date, end_date = extract_schedule_for_week(driver, wait, week1_start_date,
                                                                            week['value'])
            if not schedule_list:
                skipped_weeks.append(f"Tuần {week['text']} (Không có sự kiện)")
            else:
                for event in schedule_list:
                    event_body = {
                        'summary': event['subject'],
                        'location': event['room'],
                        'description': f"Giáo viên: {event['teacher']}\nCơ sở: {event['location']}\nTiết: {event['periods']}",
                        'start': {'dateTime': event['start_datetime'], 'timeZone': 'Asia/Ho_Chi_Minh'},
                        'end': {'dateTime': event['end_datetime'], 'timeZone': 'Asia/Ho_Chi_Minh'},
                        'colorId': event['color_id']
                    }
                    # Kiểm tra xem sự kiện đã tồn tại hay chưa
                    if not check_event_exists(service, event_body):
                        service.events().insert(calendarId='primary', body=event_body).execute()
                    else:
                        logger.info(f"Bỏ qua sự kiện trùng lặp: {event['subject']} tại {event['start_datetime']}")
                updated_weeks.append(f"Tuần {week['text']} (Từ {start_date} đến {end_date})")
    elif mode == "2":
        consecutive_empty_weeks = 0
        MAX_EMPTY_WEEKS = 4
        for week in week_list:
            schedule_list, start_date, end_date = extract_schedule_for_week(driver, wait, week1_start_date,
                                                                            week['value'])
            if not schedule_list:
                consecutive_empty_weeks += 1
                skipped_weeks.append(f"Tuần {week['text']} (Không có sự kiện)")
                if consecutive_empty_weeks >= MAX_EMPTY_WEEKS:
                    break
            else:
                consecutive_empty_weeks = 0
                for event in schedule_list:
                    event_body = {
                        'summary': event['subject'],
                        'location': event['room'],
                        'description': f"Giáo viên: {event['teacher']}\nCơ sở: {event['location']}\nTiết: {event['periods']}",
                        'start': {'dateTime': event['start_datetime'], 'timeZone': 'Asia/Ho_Chi_Minh'},
                        'end': {'dateTime': event['end_datetime'], 'timeZone': 'Asia/Ho_Chi_Minh'},
                        'colorId': event['color_id']
                    }
                    # Kiểm tra xem sự kiện đã tồn tại hay chưa
                    if not check_event_exists(service, event_body):
                        service.events().insert(calendarId='primary', body=event_body).execute()
                    else:
                        logger.info(f"Bỏ qua sự kiện trùng lặp: {event['subject']} tại {event['start_datetime']}")
                updated_weeks.append(f"Tuần {week['text']} (Từ {start_date} đến {end_date})")

    driver.quit()
    global_driver = None
    return render_template('result.html', updated_weeks=updated_weeks, skipped_weeks=skipped_weeks, user_id=user_id,
                           used_existing_token=used_existing_token)

@app.route('/logout', methods=['POST'])
def logout():
    user_id = session.get('user_id')
    token_file = f"token_{user_id}.pickle"
    if os.path.exists(token_file):
        os.remove(token_file)
    return redirect(url_for('index'))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)