// script-injection.js
'use strict';
import { logger } from './logger.js';

/**
 * Executes a script (function or file) on a specific tab.
 * Requires the targetScript function to be accessible in its scope if passed directly.
 * @param {number} tabId - The ID of the target tab.
 * @param {Function|string} targetScript - The function to execute or the path to the script file.
 * @param {Array} [args=[]] - Arguments to pass to the function if targetScript is a function.
 * @returns {Promise<any>} Resolves with the result of the executed script.
 * @throws {Error} If injection or execution fails.
 */
export async function executeScriptOnTab(tabId, targetScript, args = []) {
    let scriptExecutionConfig;

    // IMPORTANT: If passing function references (like getContent_...),
    // those functions must be defined/imported in the scope calling this function (background.js)
    // OR, the function body needs to be passed as a string which is less ideal.
    // The current structure relies on background.js having access to contentInjects.

    if (typeof targetScript === 'function') {
        scriptExecutionConfig = { func: targetScript, args: args };
    } else if (typeof targetScript === 'string' && targetScript.endsWith('.js')) {
        scriptExecutionConfig = { files: [targetScript] };
    }
    // Removed the special handling for string function names here for simplicity
    // Callers should pass the actual function reference.
     else {
        throw new Error(`Invalid target script type provided: ${typeof targetScript}`);
    }

    const injection = {
        target: { tabId: tabId },
        world: "MAIN",
        ...scriptExecutionConfig
    };

    logger.debug(`BG Scripting: Executing on tab ${tabId}:`, { funcName: scriptExecutionConfig.func?.name, files: scriptExecutionConfig.files, args: args });

    try {
        const results = await chrome.scripting.executeScript(injection);
        logger.debug(`BG Scripting: Raw result from tab ${tabId}:`, results);
        if (!results || results.length === 0) { logger.warn(`BG Scripting: No result frames returned.`); return null; }
        const mainFrameResult = results[0];
        if (mainFrameResult.error) { throw new Error(`Injected script error: ${mainFrameResult.error.message || mainFrameResult.error}`); }
        logger.debug(`BG Scripting: Script result from frame 0:`, mainFrameResult.result);
        return mainFrameResult.result;
    } catch (err) {
        logger.error(`BG Scripting: Inject/Exec error for tab ${tabId}:`, err);
        throw new Error(`Script injection/execution failed: ${err.message || "Unknown error"}`);
    }
}