// offscreen-helpers.js
'use strict';

import { logger } from './logger.js';
import { OFFSCRREN_DOCUMENT_PATH, OFFSCREEN_PARSE_TIMEOUT_MS } from './constants.js';

let creatingOffscreenDocument = null; // Promise semaphore

/** Checks if the offscreen document currently exists. */
export async function hasOffscreenDocument() {
    try {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL(OFFSCRREN_DOCUMENT_PATH)]
        });
        return !!contexts?.length;
    } catch (err) {
        if (!err.message.includes('No matching contexts found')) {
            logger.error("BG Offscreen: Error checking contexts:", err);
        }
        return false;
    }
}

/** Creates the offscreen document if it doesn't exist. Handles race conditions. */
export async function setupOffscreenDocument() {
    // Use chrome.offscreen.hasDocument() if available (Chrome 116+) for efficiency
    // Fallback to getContexts otherwise
    const hasDoc = await (chrome.offscreen.hasDocument
      ? chrome.offscreen.hasDocument()
      : hasOffscreenDocument() // Use the getContexts based one if hasDocument not supported
    );

    if (hasDoc) {
      logger.debug("BG Offscreen: Doc exists.");
      return;
    }

    if (creatingOffscreenDocument) {
        logger.debug("BG Offscreen: Waiting for existing create promise...");
        try { await creatingOffscreenDocument; } catch (err) {}
        return;
    }

    logger.info("BG Offscreen: Creating document...");
    creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCRREN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Parse timetable HTML structure'
    });

    try {
        await creatingOffscreenDocument;
        logger.info("BG Offscreen: Doc created successfully.");
    } catch (error) {
        logger.error("BG Offscreen: Create document failed:", error);
        throw new Error(`Failed to create offscreen document: ${error.message}`);
    } finally {
        creatingOffscreenDocument = null;
    }
}

/** Closes the offscreen document if it exists. */
export async function closeOffscreenDocument() {
     const hasDoc = await (chrome.offscreen.hasDocument
      ? chrome.offscreen.hasDocument()
      : hasOffscreenDocument()
    );
    if (!hasDoc) {
        logger.debug("BG Offscreen: No doc to close.");
        return;
    }
    try {
        logger.info("BG Offscreen: Closing document...");
        await chrome.offscreen.closeDocument();
        logger.info("BG Offscreen: closeDocument() called.");
    } catch (err) {
        logger.error("BG Offscreen: Error attempting to close document:", err);
    }
}

/** Sends HTML and date string to the offscreen document for parsing. */
export async function parseHtmlViaOffscreen(timetableHtml, dateRangeText) {
    const offscreenParseId = `offParse-${Date.now().toString().slice(-6)}`;
    logger.debug(`BG Offscreen [${offscreenParseId}]: Requesting parse...`);
    await setupOffscreenDocument();

    let response = null;
    let timeoutId = null;

    try {
        response = await Promise.race([
            chrome.runtime.sendMessage({
                type: 'parse-html-offscreen',
                target: 'offscreen',
                data: { timetableHtml, dateRangeText }
            }),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`Timeout (${OFFSCREEN_PARSE_TIMEOUT_MS}ms) waiting for offscreen response.`)), OFFSCREEN_PARSE_TIMEOUT_MS);
            })
        ]);

        clearTimeout(timeoutId);
        logger.debug(`BG Offscreen [${offscreenParseId}]: Received response. Type: ${typeof response}`);

        if (chrome.runtime.lastError) {
             throw new Error(`Offscreen sendMessage error: ${chrome.runtime.lastError.message}`);
        }
        if (response?.error) {
            throw new Error(`Offscreen Parser Error: ${response.error}`);
        }
        if (!response?.scheduleList || typeof response.weekStartDate !== 'string' || typeof response.weekEndDate !== 'string') {
            throw new Error("Invalid response structure received from Offscreen Parser.");
        }
        return response;

    } catch (error) {
        clearTimeout(timeoutId);
        logger.error(`BG Offscreen [${offscreenParseId}]: Error during parseHtmlViaOffscreen:`, error);
        throw new Error(`Offscreen Comm/Parse Error: ${error.message}`);
    }
}