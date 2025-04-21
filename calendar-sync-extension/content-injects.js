// content-injects.js
// Defines functions intended for injection into the MyUEL page.
// These are EXPORTED so background.js can reference them, but
// they are NOT intended to be run in the background context directly.
'use strict';

import { MUTATION_OBSERVER_TIMEOUT_MS } from './constants.js';

/** Injected function to get week options from the dropdown. */
export function getContent_getWeekOptions(dropdownId) {
    // ... (code for getContent_getWeekOptions - unchanged) ...
    console.log('[CS getContent_getWeekOptions] Running...');
    const weekDropdown = document.getElementById(dropdownId);
    if (!weekDropdown) { console.error(`[CS] Dropdown ID '${dropdownId}' not found!`); return { error: `Dropdown ID '${dropdownId}' không thấy!` }; }
    const options = [];
    for (let i = 0; i < weekDropdown.options.length; i++) {
        const option = weekDropdown.options[i];
        if (option.value && option.value !== "-1" && option.value !== "" && option.value !== "0") { options.push({ value: option.value, text: option.text }); }
    }
    console.log(`[CS] Found ${options.length} valid week options.`);
    return options;
}

/**
 * Injected function to select a week, wait via MutationObserver, and return data.
 */
export async function getContent_selectWeekAndGetData(dropdownId, weekValue, tableId, dateId) {
    // ... (code for getContent_selectWeekAndGetData - MutationObserver version - unchanged) ...
     const uniqueLogPrefix = `[CS MO ${Date.now().toString().slice(-5)}]`;
    console.log(`${uniqueLogPrefix} Selecting week value: ${weekValue}`);
    const weekDropdown = document.getElementById(dropdownId);
    const initialDateSpan = document.getElementById(dateId);
    if (!weekDropdown) return { error: `[CS MO] Dropdown not found: ${dropdownId}` };
    if (!initialDateSpan) return { error: `[CS MO] Initial date span not found: ${dateId}` };
    const oldDateText = initialDateSpan.innerText.trim();
    console.log(`${uniqueLogPrefix} Old date text: "${oldDateText}"`);
    const centerPanelId = "pnCenter"; let nodeToObserve = document.getElementById(centerPanelId);
    if (!nodeToObserve) { console.error(`${uniqueLogPrefix} Cannot find #${centerPanelId}. Falling back to body.`); nodeToObserve = document.body; if (!nodeToObserve) return { error: `[CS MO] Cannot find #${centerPanelId} or body.` }; }
    console.log(`${uniqueLogPrefix} Observing node: ${nodeToObserve.tagName}${nodeToObserve.id ? '#' + nodeToObserve.id : ''}`);

    return new Promise((resolve, reject) => {
        let observer = null; let timeoutId = null; const TIMEOUT_MS = MUTATION_OBSERVER_TIMEOUT_MS;
        const cleanup = (reason) => { if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; } if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; } };
        const mutationCallback = (mutationsList, obs) => {
            const currentDateSpan = document.getElementById(dateId); if (!currentDateSpan) { console.warn(`${uniqueLogPrefix} Date span disappeared.`); return; }
            const newDateText = currentDateSpan.innerText.trim();
            if (newDateText && newDateText !== oldDateText) {
                console.log(`${uniqueLogPrefix} Date change detected via observer: "${newDateText}"`); cleanup("Date changed (Observer)");
                setTimeout(() => {
                    const finalTable = document.getElementById(tableId); const finalDateSpan = document.getElementById(dateId);
                    if (!finalTable || !finalDateSpan) { const missing = [!finalTable && `Table#${tableId}`, !finalDateSpan && `DateSpan#${dateId}`].filter(Boolean).join(', '); reject({ error: `[CS MO] Elements lost (${missing}).` }); return; }
                    const finalTimetableHtml = finalTable.outerHTML; const finalDateRangeText = finalDateSpan.innerText.trim();
                    if (!finalTimetableHtml || !finalDateRangeText) { const missingData = [!finalTimetableHtml && "HTML", !finalDateRangeText && "Date"].filter(Boolean).join('/'); reject({ error: `[CS MO] Failed get final ${missingData}.` }); return; }
                    console.log(`${uniqueLogPrefix} Final extraction OK (via Observer).`); resolve({ timetableHtml: finalTimetableHtml, dateRangeText: finalDateRangeText });
                }, 150);
            }
        };
        try { observer = new MutationObserver(mutationCallback); } catch (error) { reject({ error: `[CS MO] Create Observer fail: ${error.message}` }); return; }
        const observerConfig = { childList: true, subtree: true };
        try { observer.observe(nodeToObserve, observerConfig); console.log(`${uniqueLogPrefix} Observer started.`); } catch (error) { cleanup("Observe Start Fail"); reject({ error: `[CS MO] Observer start fail: ${error.message}` }); return; }
        timeoutId = setTimeout(() => {
            console.warn(`${uniqueLogPrefix} Timeout (${TIMEOUT_MS}ms) week ${weekValue}.`); cleanup("Timeout (Observer)");
            const lastDateSpan = document.getElementById(dateId); const lastTable = document.getElementById(tableId);
            if (lastDateSpan && lastTable) { const lastDateText = lastDateSpan.innerText.trim(); if (lastDateText && lastDateText !== oldDateText) { console.log(`${uniqueLogPrefix} [Timeout Check] Change detected!`); resolve({ timetableHtml: lastTable.outerHTML, dateRangeText: lastDateText }); return; } }
            reject({ error: `[CS MO] Timeout (${TIMEOUT_MS / 1000}s) week ${weekValue}. Observer failed.` });
        }, TIMEOUT_MS);
        console.log(`${uniqueLogPrefix} Dispatching 'change' event week ${weekValue}...`);
        try { weekDropdown.value = weekValue; weekDropdown.dispatchEvent(new Event('change', { bubbles: true })); console.log(`${uniqueLogPrefix} 'change' dispatched. Waiting...`); }
        catch (error) { cleanup("Dispatch Error"); reject({ error: `[CS MO] Dispatch event fail: ${error.message}` }); }
    });
}