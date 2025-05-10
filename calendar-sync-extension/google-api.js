// google-api.js
'use strict';

import { logger } from './logger.js';
import * as constants from './constants.js';
import { parseLocalDate, delay } from './utils.js';

// Hằng số cho extendedProperties
const EXT_PROP_APP_SOURCE_KEY = 'uelCalendarSyncSource';
const EXT_PROP_APP_SOURCE_VALUE = 'UEL-TKB-Sync-Extension-v1.3'; // Cập nhật version nếu cần

/** Generic fetch wrapper for Google APIs */
async function fetchGoogleApi(url, method, accessToken, body = null) {
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

/**
 * Fetches existing Google Calendar events (created by this extension using extendedProperties)
 * within a date range. Returns a Map where keys are eventKeys (summary|start|end|location)
 * AND values are eventIds.
 */
export async function fetchExistingExtensionEventsWithIds(startDateStr, endDateStr, accessToken) {
    const fetchExistingId = `fetchExtIds-${Date.now().toString().slice(-6)}`;
    logger.info(`GAPI Events [${fetchExistingId}]: Fetching existing EXTENSION events (via extendedProperty) with IDs for range: ${startDateStr} - ${endDateStr}`);
    const existingEventsMap = new Map(); // eventKey (summary) -> eventId

    try {
        const startDtObj = parseLocalDate(startDateStr);
        const endDtObj = parseLocalDate(endDateStr);
        if (!startDtObj || !endDtObj) throw new Error(`Invalid date range format: ${startDateStr} - ${endDateStr}`);

        startDtObj.setHours(0, 0, 0, 0); endDtObj.setHours(23, 59, 59, 999);
        const timeMin = new Date(Date.UTC(startDtObj.getFullYear(), startDtObj.getMonth(), startDtObj.getDate())).toISOString();
        const timeMax = new Date(Date.UTC(endDtObj.getFullYear(), endDtObj.getMonth(), endDtObj.getDate(), 23, 59, 59, 999)).toISOString();

        const eventsListUrl = new URL(`${constants.CALENDAR_API_BASE}/calendars/primary/events`);
        eventsListUrl.searchParams.set('timeMin', timeMin);
        eventsListUrl.searchParams.set('timeMax', timeMax);
        eventsListUrl.searchParams.set('singleEvents', 'true');
        eventsListUrl.searchParams.set('maxResults', '250');
        eventsListUrl.searchParams.set('orderBy', 'startTime');
        eventsListUrl.searchParams.set('privateExtendedProperty', `${EXT_PROP_APP_SOURCE_KEY}=${EXT_PROP_APP_SOURCE_VALUE}`);

        let pageNum = 1; let nextPageToken = null;
        do {
            logger.debug(`GAPI Events [${fetchExistingId}]: Fetching page ${pageNum}${nextPageToken ? ' (with pageToken)' : ''}...`);
            const currentUrl = new URL(eventsListUrl.toString());
            if (nextPageToken) currentUrl.searchParams.set('pageToken', nextPageToken);

            const responseData = await fetchGoogleApi(currentUrl.toString(), 'GET', accessToken);
            const items = responseData?.items || [];
            logger.debug(`GAPI Events [${fetchExistingId}]: Page ${pageNum} received ${items.length} items (expected to be extension events).`);

            for (const item of items) {
                const summary = item.summary || "";
                const startISO = item.start?.dateTime;
                const endISO = item.end?.dateTime;
                const location = (item.location || "").trim();
                const eventId = item.id;

                // Double check, though query should be enough
                const eventPrivateProps = item.extendedProperties?.private;
                if (eventPrivateProps && eventPrivateProps[EXT_PROP_APP_SOURCE_KEY] === EXT_PROP_APP_SOURCE_VALUE) {
                    if (summary && startISO && endISO && eventId) {
                        const eventKey = `${summary}|${startISO}|${endISO}|${location}`;
                        if (!existingEventsMap.has(eventKey)) {
                            existingEventsMap.set(eventKey, eventId);
                        }
                    }
                } else {
                   logger.warn(`GAPI Events [${fetchExistingId}]: Event ${eventId} received but missing/mismatched private prop. Summary: ${summary}. Props: ${JSON.stringify(eventPrivateProps)}`);
                }
            }
            nextPageToken = responseData?.nextPageToken;
            pageNum++;
        } while (nextPageToken);

        logger.info(`GAPI Events [${fetchExistingId}]: Fetch complete. Found ${existingEventsMap.size} unique EXTENSION event keys (via extendedProperty) with IDs.`);
        return existingEventsMap;
    } catch (error) {
        logger.error(`GAPI Events [${fetchExistingId}]: ERROR fetching extension events (via extendedProperty) with IDs:`, error);
        throw new Error(`Lỗi lấy ID sự kiện (extension) GCal: ${error.message}`);
    }
}


/** Deletes specified events from Google Calendar using Batch requests. */
export async function deleteEventsFromCalendar(eventIdsToDelete, accessToken) {
    const deleteEventsId = `delEventsBatch-${Date.now().toString().slice(-6)}`;
    if (!eventIdsToDelete || eventIdsToDelete.length === 0) {
        logger.info(`GAPI Events [${deleteEventsId}]: No event IDs provided for deletion.`);
        return { deleted: 0, errors: 0 };
    }

    logger.info(`GAPI Events [${deleteEventsId}]: Deleting ${eventIdsToDelete.length} events via Batch...`);
    let deletedCount = 0; let errorCount = 0;
    const batchBoundary = `batch_delete_${Date.now()}`;
    const batchUrl = constants.BATCH_CALENDAR_ENDPOINT;
    let batchRequestBody = '';
    let contentIdCounter = 0;

    for (const eventId of eventIdsToDelete) {
        contentIdCounter++;
        const deleteUrlRelative = `/calendar/v3/calendars/primary/events/${eventId}`;
        batchRequestBody += `--${batchBoundary}\r\n`;
        batchRequestBody += `Content-Type: application/http\r\n`;
        batchRequestBody += `Content-ID: item-delete-${contentIdCounter}\r\n\r\n`;
        batchRequestBody += `DELETE ${deleteUrlRelative}\r\n`;
        batchRequestBody += `Content-Length: 0\r\n\r\n`;
    }
    batchRequestBody += `--${batchBoundary}--\r\n`;

    try {
        const batchResult = await fetchGoogleApiBatch(batchUrl, batchBoundary, batchRequestBody, accessToken);
        if (!batchResult || !batchResult.responseText || !batchResult.responseContentType) {
            logger.error(`GAPI Batch [${deleteEventsId}]: Batch delete call returned null or invalid response.`);
            errorCount = eventIdsToDelete.length;
            return { deleted: 0, errors: errorCount };
        }

        const responseBoundaryMatch = batchResult.responseContentType.match(/boundary=(.+)/i);
        const responseBoundary = responseBoundaryMatch?.[1]?.trim();

        if (!responseBoundary) {
            logger.error(`GAPI Batch [${deleteEventsId}]: No boundary found in batch delete response. Resp text: ${batchResult.responseText.substring(0,500)}`);
            errorCount = eventIdsToDelete.length;
        } else {
            logger.debug(`GAPI Batch [${deleteEventsId}]: Parsing batch delete response with boundary: ${responseBoundary}`);
            const responseParts = batchResult.responseText.split(`--${responseBoundary}`);

            for (let i = 1; i < responseParts.length - 1; i++) {
                const part = responseParts[i].trim();
                if (!part) continue;

                try {
                    const httpStatusLineMatch = part.match(/^HTTP\/[\d\.]+\s+(\d+)/im);
                    const statusCode = httpStatusLineMatch?.[1] ? parseInt(httpStatusLineMatch[1], 10) : -1;

                    if (statusCode === 204) {
                        deletedCount++;
                    } else if (statusCode !== -1) {
                        errorCount++;
                        logger.error(`GAPI Batch [${deleteEventsId}]: Sub-request delete FAIL. Status: ${statusCode}. Part content (first 300 chars): ${part.substring(0, 300)}`);
                    } else {
                        errorCount++;
                        logger.error(`GAPI Batch [${deleteEventsId}]: Sub-request delete FAIL. Could not parse status from part. Part content (first 300 chars): ${part.substring(0, 300)}`);
                    }
                } catch (parseErr) {
                    errorCount++;
                    logger.error(`GAPI Batch [${deleteEventsId}]: Error parsing individual batch delete response part: ${parseErr}. Part: ${part.substring(0,200)}`);
                }
            }
             if (deletedCount + errorCount !== eventIdsToDelete.length) {
                logger.warn(`GAPI Batch [${deleteEventsId}]: Count mismatch after parsing delete response. Expected ${eventIdsToDelete.length}, got ${deletedCount} deleted, ${errorCount} errors.`);
            }
        }
    } catch (batchError) {
        logger.error(`GAPI Batch [${deleteEventsId}]: Batch delete request itself failed:`, batchError);
        errorCount = eventIdsToDelete.length;
        deletedCount = 0;
    }

    logger.info(`GAPI Batch [${deleteEventsId}]: Finished Deletion. Deleted: ${deletedCount}, Errors: ${errorCount}`);
    return { deleted: deletedCount, errors: errorCount };
}


/** Adds new events to Google Calendar using Batch requests. */
export async function addEventsToCalendar(eventsToAdd, accessToken) {
    const addEventsId = `addEventsBatch-${Date.now().toString().slice(-6)}`;
    if (!eventsToAdd || eventsToAdd.length === 0) { logger.info(`GAPI Events [${addEventsId}]: No events.`); return { added: 0, errors: 0 }; }

    logger.info(`GAPI Events [${addEventsId}]: Adding ${eventsToAdd.length} via Batch (using extendedProperty)...`);
    let addedCount = 0; let errorCount = 0;
    const subjectColorMap = {}; let nextColorIndex = 0; const numColors = constants.AVAILABLE_EVENT_COLORS.length;

    const batchBoundary = `batch_add_${Date.now()}`;
    const insertUrlRelative = `/calendar/v3/calendars/primary/events`;
    let batchRequestBody = ''; let contentIdCounter = 0;

    for (const eventData of eventsToAdd) {
        contentIdCounter++;
        const subjectName = eventData.subject || "Sự kiện KCL";
        let colorId = subjectColorMap[subjectName];
        if (!colorId) { colorId = constants.AVAILABLE_EVENT_COLORS[nextColorIndex % numColors]; subjectColorMap[subjectName] = colorId; nextColorIndex++; }
        const desc = `GV: ${eventData.teacher || 'N/A'}\nCS: ${eventData.location || 'N/A'}${eventData.periods ? `\nTiết: ${eventData.periods}` : ''}\nPhòng: ${eventData.room || 'N/A'}${eventData.description_extra || ''}`;

        const eventBody = {
            summary: subjectName, // Summary gốc, không prefix
            location: eventData.room || '',
            description: desc,
            start: { dateTime: eventData.start_datetime_iso, timeZone: constants.VIETNAM_TIMEZONE_IANA },
            end: { dateTime: eventData.end_datetime_iso, timeZone: constants.VIETNAM_TIMEZONE_IANA },
            colorId: colorId,
            reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
            extendedProperties: {
                private: {
                    [EXT_PROP_APP_SOURCE_KEY]: EXT_PROP_APP_SOURCE_VALUE
                }
            }
        };
        const eventBodyString = JSON.stringify(eventBody);
        batchRequestBody += `--${batchBoundary}\r\n`;
        batchRequestBody += `Content-Type: application/http\r\n`;
        batchRequestBody += `Content-ID: item-add-${contentIdCounter}\r\n\r\n`;
        batchRequestBody += `POST ${insertUrlRelative}\r\n`;
        batchRequestBody += `Content-Type: application/json; charset=UTF-8\r\n`;
        batchRequestBody += `Content-Length: ${new TextEncoder().encode(eventBodyString).length}\r\n\r\n`;
        batchRequestBody += `${eventBodyString}\r\n`;
    }
    batchRequestBody += `--${batchBoundary}--\r\n`;
    logger.debug(`GAPI Batch [${addEventsId}]: Built ${contentIdCounter} sub-requests. Len: ${batchRequestBody.length}`);

    try {
        const batchResult = await fetchGoogleApiBatch(constants.BATCH_CALENDAR_ENDPOINT, batchBoundary, batchRequestBody, accessToken);
        if (!batchResult || !batchResult.responseText || !batchResult.responseContentType) {
             logger.warn(`GAPI Batch [${addEventsId}]: Add call skipped/null or invalid response.`);
             errorCount = eventsToAdd.length;
             return { added: 0, errors: errorCount };
        }

        const responseBoundaryMatch = batchResult.responseContentType.match(/boundary=(.+)/i);
        const responseBoundary = responseBoundaryMatch?.[1]?.trim();
        if (!responseBoundary) {
            logger.error(`GAPI Batch [${addEventsId}]: No boundary in add response. Resp text: ${batchResult.responseText.substring(0,500)}`);
            errorCount = eventsToAdd.length;
        } else {
            logger.debug(`GAPI Batch [${addEventsId}]: Parsing add response boundary: ${responseBoundary}`);
            const responseParts = batchResult.responseText.split(`--${responseBoundary}`);
            for (let i = 1; i < responseParts.length - 1; i++) {
                const part = responseParts[i].trim(); if (!part) continue;
                try {
                    const contentIdMatch = part.match(/Content-ID:\s*(?:<)?response-item-add-(\d+)(?:>)?/i);
                    const respId = contentIdMatch?.[1] ? parseInt(contentIdMatch[1], 10) : -1;

                    let httpStartIndex = part.indexOf('HTTP/'); if (httpStartIndex === -1) { logger.warn(`[${addEventsId}] No HTTP status line part ${i}.`); errorCount++; continue; }
                    const httpResponsePart = part.substring(httpStartIndex);
                    const statusMatch = httpResponsePart.match(/^HTTP\/[\d\.]+\s+(\d+)/i);
                    const statusCode = statusMatch?.[1] ? parseInt(statusMatch[1], 10) : -1;

                    let bodyStartIndex = httpResponsePart.indexOf('\r\n\r\n'); if (bodyStartIndex === -1) bodyStartIndex = httpResponsePart.indexOf('\n\n');
                    const httpBodyString = (bodyStartIndex !== -1) ? httpResponsePart.substring(bodyStartIndex + (httpResponsePart.includes('\r\n\r\n') ? 4 : 2)).trim() : "";

                    const origIdx = respId - 1;
                    const origSubj = (origIdx >= 0 && origIdx < eventsToAdd.length) ? eventsToAdd[origIdx].subject : `Unknown (Add ID ${respId})`;
                    logger.debug(`GAPI Batch [${addEventsId}]: Add Part ${i} - ID:${respId}, Status:${statusCode}, Subj:${origSubj}`);

                    if (respId === -1 || statusCode === -1) { logger.error(`[${addEventsId}] Failed parse Add ID/Status part ${i}.`); errorCount++; continue; }

                    if (statusCode >= 200 && statusCode < 300) {
                        addedCount++;
                        try {
                            const res = JSON.parse(httpBodyString); logger.info(`[${addEventsId}] Sub-req Add ${respId} (${origSubj}) OK. GCal ID: ${res?.id}`);
                        } catch(e){ logger.info(`[${addEventsId}] Sub-req Add ${respId} (${origSubj}) OK (${statusCode}), but failed to parse response body.`);}
                    } else {
                        errorCount++;
                        logger.error(`[${addEventsId}] Sub-req Add ${respId} (${origSubj}) FAIL. Status: ${statusCode}. Body: ${httpBodyString.substring(0, 300)}`);
                        if (statusCode === 403 || statusCode === 429) { logger.warn(`[${addEventsId}] Rate Limit/Quota (${statusCode}) for Add sub-req ${respId}?`); await delay(250); }
                    }
                } catch(parseErr) {
                    logger.error(`[${addEventsId}] Error parsing Add part ${i}: ${parseErr}. Part: ${part.substring(0,200)}`);
                    errorCount++;
                }
            }
             if (addedCount + errorCount !== eventsToAdd.length) {
                logger.warn(`[${addEventsId}] Add Count mismatch: ${addedCount} added + ${errorCount} errors != ${eventsToAdd.length} total.`);
            }
        }
    } catch (batchError) {
        logger.error(`GAPI Batch [${addEventsId}]: Batch Add request failed:`, batchError);
        errorCount = eventsToAdd.length;
        addedCount = 0;
        if (batchError.status === 403 || batchError.status === 429) { logger.warn(`[${addEventsId}] Rate Limit/Quota (${batchError.status}) for Batch Add? Delaying...`); await delay(1500); }
    }

    logger.info(`GAPI Batch [${addEventsId}]: Finished Adding. Added: ${addedCount}, Errors: ${errorCount}`);
    return { added: addedCount, errors: errorCount };
}