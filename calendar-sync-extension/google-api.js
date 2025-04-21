// google-api.js
'use strict';

import { logger } from './logger.js';
import * as constants from './constants.js';
import { parseLocalDate, delay } from './utils.js';

/** Generic fetch wrapper for Google APIs */
async function fetchGoogleApi(url, method, accessToken, body = null) {
    // ... (code for fetchGoogleApi - unchanged) ...
     const fetchId = `gapi-${Date.now().toString().slice(-6)}`;
    logger.debug(`GAPI [${fetchId}]> ${method} ${url.substring(0, 100)}...`);
    if (!accessToken) throw new Error("[fetchGoogleApi] Access token is missing.");

    const options = {
        method: method,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    };
    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.body = JSON.stringify(body);
        logger.debug(`GAPI [${fetchId}] Body size: ${options.body.length}`);
    }

    try {
        const response = await fetch(url, options);
        logger.debug(`GAPI [${fetchId}]< Status ${response.status}`);

        if (!response.ok) {
            let errorData = null; let errorText = '';
            try { errorData = await response.json(); logger.error(`GAPI [${fetchId}] Err Body JSON:`, errorData); }
            catch (e) { try { errorText = await response.text(); } catch (e2) { /*ignore*/ } logger.error(`GAPI [${fetchId}] Err Status: ${response.status}. Non-JSON: ${errorText.substring(0,300)}`); }
            const errorMsg = errorData?.error?.message || `HTTP ${response.status} - ${errorText || response.statusText}`;
            const apiError = new Error(errorMsg);
            apiError.status = response.status;
            apiError.data = errorData || errorText;
            throw apiError;
        }

        if (response.status === 204) { logger.debug(`GAPI [${fetchId}]< 204 No Content.`); return {}; }
        return await response.json();
    } catch (error) {
        logger.error(`GAPI [${fetchId}] FETCH ERROR for ${method} ${url.substring(0,50)}:`, error);
        throw error;
    }
}

/** Executes a Google API Batch Request */
async function fetchGoogleApiBatch(batchUrl, batchBoundary, batchBody, accessToken) {
    // ... (code for fetchGoogleApiBatch - unchanged) ...
     const batchFetchId = `gapiBatch-${Date.now().toString().slice(-6)}`;
    logger.debug(`GAPI Batch [${batchFetchId}]> POST ${batchUrl.substring(0, 100)}...`);
    logger.debug(`GAPI Batch [${batchFetchId}]  Body Length: ${batchBody?.length || 0}`);

    if (!accessToken) throw new Error("[fetchGoogleApiBatch] Access token is missing.");
    if (!batchBody) { logger.warn(`GAPI Batch [${batchFetchId}]: Batch body empty.`); return null; }

    const options = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': `multipart/mixed; boundary=${batchBoundary}`
        },
        body: batchBody
    };

    try {
        const response = await fetch(batchUrl, options);
        const responseContentType = response.headers.get('content-type');
        const responseText = await response.text();
        logger.debug(`GAPI Batch [${batchFetchId}]< Status ${response.status}`);

        if (!response.ok) {
            logger.error(`GAPI Batch [${batchFetchId}] Request Failed. Status: ${response.status}. Response Text: ${responseText.substring(0, 500)}...`);
            let errorData = null; let errorMsg = `Batch HTTP ${response.status} - ${response.statusText}`;
            try { errorData = JSON.parse(responseText); errorMsg = errorData?.error?.message || errorMsg; } catch (e) { /* Not JSON */ }
            const apiError = new Error(errorMsg); apiError.status = response.status; apiError.data = errorData || responseText; throw apiError;
        }
        return { responseText, responseContentType };
    } catch (error) {
        logger.error(`GAPI Batch [${batchFetchId}] FETCH BATCH ERROR:`, error);
        if (!(error instanceof Error)) throw new Error(`Unknown Batch fetch err: ${JSON.stringify(error)}`);
        throw error;
    }
}

/** Fetches existing Google Calendar events within a date range. */
export async function fetchExistingCalendarEvents(startDateStr, endDateStr, accessToken) {
    // ... (code for fetchExistingCalendarEvents - unchanged, uses fetchGoogleApi and parseLocalDate) ...
     const fetchExistingId = `fetchExist-${Date.now().toString().slice(-6)}`;
    logger.info(`GAPI Events [${fetchExistingId}]: Fetching existing events for range: ${startDateStr} - ${endDateStr}`);
    const existingEventsSet = new Set();

    try {
        const startDtObj = parseLocalDate(startDateStr);
        const endDtObj = parseLocalDate(endDateStr);
        if (!startDtObj || !endDtObj) throw new Error(`Invalid date range format: ${startDateStr} - ${endDateStr}`);

        startDtObj.setHours(0, 0, 0, 0); endDtObj.setHours(23, 59, 59, 999);
        const timeMin = new Date(Date.UTC(startDtObj.getFullYear(), startDtObj.getMonth(), startDtObj.getDate())).toISOString();
        const timeMax = new Date(Date.UTC(endDtObj.getFullYear(), endDtObj.getMonth(), endDtObj.getDate(), 23, 59, 59, 999)).toISOString();
        logger.debug(`GAPI Events [${fetchExistingId}]: Querying UTC ISO: ${timeMin} to ${timeMax}`);

        const eventsListUrl = new URL(`${constants.CALENDAR_API_BASE}/calendars/primary/events`);
        eventsListUrl.searchParams.set('timeMin', timeMin); eventsListUrl.searchParams.set('timeMax', timeMax);
        eventsListUrl.searchParams.set('singleEvents', 'true'); eventsListUrl.searchParams.set('maxResults', '250');
        eventsListUrl.searchParams.set('orderBy', 'startTime');

        let pageNum = 1; let totalEventsFetched = 0; let nextPageToken = null;
        do {
            logger.debug(`GAPI Events [${fetchExistingId}]: Fetching page ${pageNum}${nextPageToken ? ' (with pageToken)' : ''}...`);
            const currentUrl = new URL(eventsListUrl.toString());
            if (nextPageToken) currentUrl.searchParams.set('pageToken', nextPageToken);

            const responseData = await fetchGoogleApi(currentUrl.toString(), 'GET', accessToken);
            const items = responseData?.items || [];
            totalEventsFetched += items.length;
            logger.debug(`GAPI Events [${fetchExistingId}]: Page ${pageNum} received ${items.length}. Total: ${totalEventsFetched}`);

            for (const item of items) {
                const summary = item.summary || ""; const startISO = item.start?.dateTime;
                const endISO = item.end?.dateTime; const location = (item.location || "").trim();
                if (summary && startISO && endISO) {
                    const eventKey = `${summary}|${startISO}|${endISO}|${location}`;
                    existingEventsSet.add(eventKey);
                }
            }
            nextPageToken = responseData?.nextPageToken; pageNum++;
        } while (nextPageToken);

        logger.info(`GAPI Events [${fetchExistingId}]: Fetch complete. Found ${existingEventsSet.size} unique keys.`);
        return existingEventsSet;
    } catch (error) {
        logger.error(`GAPI Events [${fetchExistingId}]: ERROR fetching events:`, error);
        throw new Error(`Lỗi lấy sự kiện GCal: ${error.message}`);
    }
}

/** Adds new events to Google Calendar using Batch requests. */
export async function addEventsToCalendar(eventsToAdd, accessToken) {
    // ... (code for addEventsToCalendar - unchanged, uses fetchGoogleApiBatch and delay) ...
     const addEventsId = `addEventsBatch-${Date.now().toString().slice(-6)}`;
    if (!eventsToAdd || eventsToAdd.length === 0) { logger.info(`GAPI Events [${addEventsId}]: No events.`); return { added: 0, errors: 0 }; }

    logger.info(`GAPI Events [${addEventsId}]: Adding ${eventsToAdd.length} via Batch...`);
    let addedCount = 0; let errorCount = 0;
    const subjectColorMap = {}; let nextColorIndex = 0; const numColors = constants.AVAILABLE_EVENT_COLORS.length;

    const batchBoundary = `batch_${Date.now()}`;
    const insertUrlRelative = `/calendar/v3/calendars/primary/events`;
    let batchRequestBody = ''; let contentIdCounter = 0;
    logger.info(`GAPI Batch [${addEventsId}]: Preparing batch: ${batchBoundary}`);

    for (const eventData of eventsToAdd) {
        contentIdCounter++; const subjectName = eventData.subject || "Sự kiện KCL";
        let colorId = subjectColorMap[subjectName];
        if (!colorId) { colorId = constants.AVAILABLE_EVENT_COLORS[nextColorIndex % numColors]; subjectColorMap[subjectName] = colorId; nextColorIndex++; }
        const desc = `GV: ${eventData.teacher || 'N/A'}\nCS: ${eventData.location || 'N/A'}${eventData.periods ? `\nTiết: ${eventData.periods}` : ''}\nPhòng: ${eventData.room || 'N/A'}${eventData.description_extra || ''}`;
        const eventBody = { summary: subjectName, location: eventData.room || '', description: desc,
            start: { dateTime: eventData.start_datetime_iso, timeZone: constants.VIETNAM_TIMEZONE_IANA },
            end: { dateTime: eventData.end_datetime_iso, timeZone: constants.VIETNAM_TIMEZONE_IANA },
            colorId: colorId, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] } };
        const eventBodyString = JSON.stringify(eventBody);
        batchRequestBody += `--${batchBoundary}\r\nContent-Type: application/http\r\nContent-ID: item-${contentIdCounter}\r\n\r\n`;
        batchRequestBody += `POST ${insertUrlRelative}\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: ${new TextEncoder().encode(eventBodyString).length}\r\n\r\n`;
        batchRequestBody += `${eventBodyString}\r\n`;
    }
    batchRequestBody += `--${batchBoundary}--\r\n`;
    logger.debug(`GAPI Batch [${addEventsId}]: Built ${contentIdCounter} sub-requests. Len: ${batchRequestBody.length}`);

    try {
        const batchResult = await fetchGoogleApiBatch(constants.BATCH_CALENDAR_ENDPOINT, batchBoundary, batchRequestBody, accessToken);
        if (!batchResult) { logger.warn(`GAPI Batch [${addEventsId}]: Call skipped/null.`); errorCount = eventsToAdd.length; return { added: 0, errors: errorCount }; }

        const responseBoundaryMatch = batchResult.responseContentType?.match(/boundary=(.+)/i);
        const responseBoundary = responseBoundaryMatch?.[1]?.trim();
        if (!responseBoundary) { logger.error(`GAPI Batch [${addEventsId}]: No boundary in response.`); errorCount = eventsToAdd.length; }
        else {
            logger.debug(`GAPI Batch [${addEventsId}]: Parsing response boundary: ${responseBoundary}`);
            const responseParts = batchResult.responseText.split(`--${responseBoundary}`);
            for (let i = 1; i < responseParts.length - 1; i++) {
                const part = responseParts[i].trim(); if (!part) continue;
                try {
                    const contentIdMatch = part.match(/Content-ID:\s*(?:<)?response-item-(\d+)(?:>)?/i);
                    const respId = contentIdMatch?.[1] ? parseInt(contentIdMatch[1], 10) : -1;
                    let httpStartIndex = part.indexOf('HTTP/'); if (httpStartIndex === -1) { logger.warn(`[${addEventsId}] No HTTP status line part ${i}.`); errorCount++; continue; }
                    const httpResponsePart = part.substring(httpStartIndex);
                    const statusMatch = httpResponsePart.match(/^HTTP\/[\d\.]+\s+(\d+)/i);
                    const statusCode = statusMatch?.[1] ? parseInt(statusMatch[1], 10) : -1;
                    let bodyStartIndex = httpResponsePart.indexOf('\r\n\r\n'); if (bodyStartIndex === -1) bodyStartIndex = httpResponsePart.indexOf('\n\n');
                    const httpBodyString = (bodyStartIndex !== -1) ? httpResponsePart.substring(bodyStartIndex + (httpResponsePart.includes('\r\n\r\n') ? 4 : 2)).trim() : "";
                    const origIdx = respId - 1; const origSubj = (origIdx >= 0 && origIdx < eventsToAdd.length) ? eventsToAdd[origIdx].subject : `Unknown (ID ${respId})`;
                    logger.debug(`GAPI Batch [${addEventsId}]: Part ${i} - ID:${respId}, Status:${statusCode}, Subj:${origSubj}`);
                    if (respId === -1 || statusCode === -1) { logger.error(`[${addEventsId}] Failed parse ID/Status part ${i}.`); errorCount++; continue; }
                    if (statusCode >= 200 && statusCode < 300) {
                        addedCount++; try { const res = JSON.parse(httpBodyString); logger.info(`[${addEventsId}] Sub-req ${respId} (${origSubj}) OK. ID: ${res?.id}`); } catch(e){ logger.info(`[${addEventsId}] Sub-req ${respId} (${origSubj}) OK (${statusCode}), parse body fail.`);}
                    } else { errorCount++; logger.error(`[${addEventsId}] Sub-req ${respId} (${origSubj}) FAIL. Status: ${statusCode}. Body: ${httpBodyString.substring(0, 300)}`); if (statusCode === 403 || statusCode === 429) { logger.warn(`[${addEventsId}] Rate Limit/Quota (${statusCode}) sub-req ${respId}?`); await delay(250); } }
                } catch(parseErr) { logger.error(`[${addEventsId}] Error parsing part ${i}: ${parseErr}.`); errorCount++; }
            }
            if (addedCount + errorCount !== eventsToAdd.length) { logger.warn(`[${addEventsId}] Count mismatch: ${addedCount}+${errorCount} != ${eventsToAdd.length}.`); }
        }
    } catch (batchError) { logger.error(`GAPI Batch [${addEventsId}]: Batch request failed:`, batchError); errorCount = eventsToAdd.length; addedCount = 0; if (batchError.status === 403 || batchError.status === 429) { logger.warn(`[${addEventsId}] Rate Limit/Quota (${batchError.status}) Batch? Delay...`); await delay(1500); } }

    logger.info(`GAPI Batch [${addEventsId}]: Finished. Added: ${addedCount}, Errors: ${errorCount}`);
    return { added: addedCount, errors: errorCount };
}