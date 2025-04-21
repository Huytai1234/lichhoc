// script-injection.js
'use strict';
import { logger } from './logger.js';

/**
 * Executes a script (function or file) on a specific tab in the MAIN world.
 * It's recommended to pass the actual function reference rather than its name as a string.
 * @param {number} tabId - The ID of the target tab.
 * @param {Function|string} targetScript - The function to execute or the path to the script file (ending in .js).
 * @param {Array} [args=[]] - Arguments to pass to the target function.
 * @returns {Promise<any>} Resolves with the result of the executed script's main world execution.
 * @throws {Error} If injection or execution fails, or if targetScript type is invalid.
 */
export async function executeScriptOnTab(tabId, targetScript, args = []) {
    let scriptExecutionConfig;

    if (typeof targetScript === 'function') {
        // Pass the function reference directly
        scriptExecutionConfig = { func: targetScript, args: args };
        logger.debug(`Script injection config: Injecting function '${targetScript.name || 'anonymous'}'.`);
    } else if (typeof targetScript === 'string' && targetScript.endsWith('.js')) {
        // Pass the file path
        scriptExecutionConfig = { files: [targetScript] };
        logger.debug(`Script injection config: Injecting file '${targetScript}'.`);
    } else {
        // Reject other types, including function names as strings
        logger.error(`Invalid targetScript type: ${typeof targetScript}. Expected function reference or .js file path.`);
        throw new Error(`Invalid target script type provided. Pass function reference or file path.`);
    }

    const injection = {
        target: { tabId: tabId },
        world: "MAIN", // Execute in the page's main world to interact with page scripts/events
        ...scriptExecutionConfig
    };

    logger.debug(`Executing script on tab ${tabId}:`, { target: injection.target, world: injection.world, args: args });

    try {
        const results = await chrome.scripting.executeScript(injection);

        // executeScript returns an array of results, one for each frame injected.
        // We are usually interested in the main frame (index 0).
        logger.debug(`Raw executeScript result from tab ${tabId}:`, results);

        if (!results || results.length === 0) {
            // This might happen if the tab was closed or navigated away during injection
            logger.warn(`No result frames returned from executeScript on tab ${tabId}.`);
            return null; // Or throw an error if a result is always expected
        }

        const mainFrameResult = results[0];

        // Check for errors within the injected script's execution
        if (mainFrameResult.error) {
            logger.error(`Error reported from injected script frame (tab ${tabId}):`, mainFrameResult.error);
            // Provide a more informative error message
            throw new Error(`Injected script execution failed: ${mainFrameResult.error.message || mainFrameResult.error}`);
        }

        // Log and return the successful result
        logger.debug(`Script result from main frame (tab ${tabId}):`, mainFrameResult.result);
        return mainFrameResult.result;

    } catch (err) {
        // Catch errors from the chrome.scripting.executeScript call itself
        // (e.g., permission denied, invalid tab ID, file not found)
        logger.error(`Error calling executeScript for tab ${tabId}:`, err);
        // Provide a more informative error message
        throw new Error(`Script injection/execution API call failed: ${err.message || "Unknown error"}`);
    }
}