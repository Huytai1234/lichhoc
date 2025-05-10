
// constants.js
'use strict';

export const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId=';
export const WEEK_DROPDOWN_ID = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_ddlTuan";
export const TIMETABLE_TABLE_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_tblThoiKhoaBieu";
export const DATE_SPAN_ID_STRING = "portlet_3750a397-90f5-4478-b67c-a8f0a1a4060b_ctl00_lblDate";
export const AVAILABLE_EVENT_COLORS = ["1", "2", "3", "4", "5", "6", "7", "9", "10", "11"];
export const GOOGLE_API_BASE = 'https://www.googleapis.com';
export const CALENDAR_API_BASE = `${GOOGLE_API_BASE}/calendar/v3`;
export const BATCH_CALENDAR_ENDPOINT = `${GOOGLE_API_BASE}/batch/calendar/v3`;
export const VIETNAM_TIMEZONE_OFFSET = "+07:00";
export const VIETNAM_TIMEZONE_IANA = "Asia/Ho_Chi_Minh";
export const OFFSCRREN_DOCUMENT_PATH = 'offscreen.html';
export const INTER_WEEK_DELAY_MS = 250;
export const CONSECUTIVE_EMPTY_WEEKS_LIMIT = 4;
export const PRESELECT_WAIT_MS = 3500;
export const OFFSCREEN_PARSE_TIMEOUT_MS = 15000;
export const MUTATION_OBSERVER_TIMEOUT_MS = 18000;
export const NOTIFICATION_ICON_URL = 'icon.png';

// Global variables set during init
export let GOOGLE_CLIENT_ID = '';
export let GOOGLE_SCOPES = '';

// Function to set globals after manifest load
export function setGoogleCredentials(clientId, scopes) {
    GOOGLE_CLIENT_ID = clientId;
    GOOGLE_SCOPES = scopes;
}