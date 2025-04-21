// popup.js

// Get references to HTML elements
const userIdInput = document.getElementById('userId');
const syncWeekButton = document.getElementById('syncWeekButton');
const syncSemesterButton = document.getElementById('syncSemesterButton');
const statusDiv = document.getElementById('status');
const loader = document.getElementById('loader');
const versionDisplay = document.getElementById('versionDisplay');
const clearEmailLink = document.getElementById('clearEmailLink');

// --- Configuration ---
const MYUEL_TKB_URL_PATTERN = 'https://myuel.uel.edu.vn/Default.aspx?PageId='; // URL pattern for validation

// Simple logger for popup context
const logger = {
    info: (...args) => console.log("[POPUP INFO]", ...args),
    warn: (...args) => console.warn("[POPUP WARN]", ...args),
    error: (...args) => console.error("[POPUP ERROR]", ...args),
    debug: (...args) => console.debug("[POPUP DEBUG]", ...args)
};

// --- UI State Management ---

// <<< ADDED: Function to centralize locking/unlocking the UI >>>
/**
 * Locks or unlocks the main action buttons.
 * @param {boolean} isLocked - True to disable buttons, false to enable.
 */
function setUiLockedState(isLocked) {
    logger.debug(`Setting UI Lock State: ${isLocked}`);
    syncWeekButton.disabled = isLocked;
    syncSemesterButton.disabled = isLocked;
    // Note: Loader visibility is handled by updateStatus based on message type ('info')
}
// <<< END ADDED Function >>>


/**
 * Updates the status message display area.
 * @param {string} message - The message to display.
 * @param {'info'|'success'|'error'|'warn'} [type='info'] - The type of message, affecting styling and potentially UI locking.
 */
function updateStatus(message, type = 'info') {
    statusDiv.textContent = message;
    // Apply CSS class based on message type for styling
    statusDiv.className = `status-message status-${type}`;

    // Only 'info' type messages from *this popup* initiating an action should show the loader and lock UI immediately.
    // Other types (success, error, warn) represent final states or warnings.
    const isProcessingLocally = (type === 'info');

    if (isProcessingLocally) {
        loader.classList.remove('hidden'); // Show loader
        setUiLockedState(true); // Lock buttons immediately
    } else {
        loader.classList.add('hidden'); // Hide loader
        // When receiving a final status (success/error/warn), we need to check the *actual* background
        // state before unlocking, as another process might still be running.
        // We request the state asynchronously. The UI might remain locked briefly until the response comes.
        chrome.runtime.sendMessage({ action: "getSyncState" }, (response) => {
            if (chrome.runtime.lastError) {
                logger.error("Error checking sync state in updateStatus:", chrome.runtime.lastError.message);
                 setUiLockedState(false); // Safer to unlock if state check fails? Or keep locked? Let's unlock.
            } else if (response && !response.isRunning) {
                 setUiLockedState(false); // Unlock only if background confirms nothing is running
            } else if (response && response.isRunning) {
                 setUiLockedState(true);  // Keep locked if background is still busy
                 // Optionally update status again if it wasn't the "busy" message
                 if (!statusDiv.textContent.includes("already running")) {
                     // updateStatus("Another sync operation is still running...", "warn");
                 }
            } else {
                logger.warn("No response or invalid response for getSyncState in updateStatus.");
                setUiLockedState(false); // Assume not locked if no response
            }
        });
    }
}

// --- Initialization on Popup Load ---
document.addEventListener('DOMContentLoaded', () => {
    // Display extension version
    const manifest = chrome.runtime.getManifest();
    versionDisplay.textContent = `Version: ${manifest.version}`;

    // Restore saved User ID
    chrome.storage.local.get(['userId'], (result) => {
        if (result.userId) {
            userIdInput.value = result.userId;
            logger.info('Restored userId:', result.userId);
        }

        // <<< MODIFIED: Check Initial Sync State from Background >>>
        logger.debug("Requesting initial sync state...");
        chrome.runtime.sendMessage({ action: "getSyncState" }, (response) => {
            let isInitiallyLocked = false;
            if (chrome.runtime.lastError) {
                // Handle error fetching initial state
                logger.error("Error getting initial sync state:", chrome.runtime.lastError.message);
                updateStatus("Error checking sync status. Please reopen popup.", "error");
                setUiLockedState(false); // Default to unlocked on error
            } else if (response) {
                // Got state response from background
                logger.info("Initial sync state received:", response.isRunning);
                isInitiallyLocked = response.isRunning;
                setUiLockedState(isInitiallyLocked); // Set button state accordingly
                if (isInitiallyLocked) {
                    // If a sync is running in the background, inform the user
                    updateStatus("A sync operation is currently in progress...", "warn"); // Use 'warn' or 'info'
                } else {
                    // If not locked, set the default initial message
                    updateStatus('Enter email and choose an option.');
                    loader.classList.add('hidden'); // Ensure loader is hidden initially
                }
            } else {
                // Handle case where background didn't respond (shouldn't normally happen)
                logger.warn("No response received for initial getSyncState.");
                updateStatus("Could not determine sync status.", "warn");
                setUiLockedState(false); // Assume unlocked if no response
                loader.classList.add('hidden');
            }
        });
        // <<< END Check Initial Sync State >>>
    });
});

// Save User ID whenever it changes
userIdInput.addEventListener('input', () => {
    chrome.storage.local.set({ userId: userIdInput.value.trim() });
});


// --- Sync Request Handling ---
/**
 * Handles sending sync requests (Week or Semester) to the background script.
 * @param {'startSync'|'startSemesterSync'} action - The sync action to perform.
 * @param {string} userId - The user's email address.
 * @param {object} [options={}] - Additional options (e.g., tabId).
 */
async function handleSyncRequest(action, userId, options = {}) {
    logger.info(`handleSyncRequest called for action: ${action}`);

    // <<< ADDED: Early check if buttons are already disabled >>>
    // Prevents sending messages if the UI is clearly locked. Background also checks, but this is faster UX.
    if (syncWeekButton.disabled || syncSemesterButton.disabled) {
        logger.warn(`handleSyncRequest: Attempted to sync while UI is locked. Action: ${action}. Ignoring.`);
        // Optionally briefly show a message, but might be handled by the existing status.
        // updateStatus("Operation already in progress.", "warn"); // Could uncomment this
        return; // Do nothing if locked
    }
    // <<< END Early Check >>>

    // Validate User ID format
    if (!userId || !userId.includes('@st.uel.edu.vn')) {
        updateStatus('Please enter a valid UEL student email.', 'error');
        userIdInput.focus();
        return; // Stop if email is invalid
    }
    // Save valid email
    chrome.storage.local.set({ userId: userId });

    // Set initial "processing" message based on action
    let initialProcessingMessage = '';
    if (action === 'startSync') {
        initialProcessingMessage = 'Sending week sync request...';
    } else if (action === 'startSemesterSync') {
        // Explain the random delay for semester sync
        initialProcessingMessage = 'Sending semester sync request...\n(Includes a random delay to avoid overloading the server. Please wait!)';
    } else {
        // Should not happen with current buttons
        updateStatus('Unknown action.', 'error');
        return;
    }
    // Display the initial message and lock the UI (type 'info' does this)
    updateStatus(initialProcessingMessage, 'info');

    try {
        // Prepare the message payload for the background script
        let messagePayload = { action: action, userId: userId, ...options };

        // For 'startSync' (Week Sync), check if the active tab is the correct MyUEL page
        if (action === "startSync") {
            const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!currentTab) { updateStatus('Error: Cannot find the active tab.', 'error'); return; }
            logger.info("Popup: Current active tab:", currentTab.id, currentTab.url);
            // Validate URL
            if (!currentTab.url || !currentTab.url.startsWith(MYUEL_TKB_URL_PATTERN)) {
                updateStatus(`Error: Please navigate to the MyUEL Timetable page (\n${MYUEL_TKB_URL_PATTERN}... \n) on the active tab first.`, 'error');
                return;
            }
            messagePayload.tabId = currentTab.id; // Add tabId to payload
            logger.debug("Payload for startSync:", messagePayload);
        } else { // For 'startSemesterSync'
            logger.debug("Payload for startSemesterSync:", messagePayload);
        }

        // Send the message to the background script
        chrome.runtime.sendMessage(messagePayload, (response) => {
            // --- Callback handles the FINAL response from the background ---
            let finalMessage = "Received an unknown response.";
            let finalType = 'warn'; // Default type for unexpected responses
            const duration = response?.duration; // Get duration if provided
            let isStillLockedByBackground = false; // Flag to check if background reported still busy

            if (chrome.runtime.lastError) {
                // Handle errors during message sending/receiving itself
                logger.error(`Error sending/receiving message (${action}):`, chrome.runtime.lastError);
                finalMessage = `Communication Error (${action === 'startSync' ? 'Week' : 'Semester'}): ${chrome.runtime.lastError.message || 'Unknown'}`;
                finalType = 'error';
            } else if (response?.status === "success") {
                // Handle successful response from background
                logger.info(`Background success (${action}):`, response.message);
                finalMessage = response.message;
                finalType = 'success';
            } else if (response?.status === "error") {
                // Handle error response from background
                logger.error(`Background error (${action}):`, response.message);
                // <<< MODIFIED: Check specifically for the "busy" message >>>
                if (response.message && response.message.includes("already running")) {
                    finalMessage = response.message; // Use the message from background
                    finalType = 'warn'; // Display as a warning or info
                    isStillLockedByBackground = true; // Mark that we should keep UI locked
                } else {
                    finalMessage = response.message; // Use other error messages from background
                    finalType = 'error';
                }
                 // <<< END MODIFIED Check >>>
            } else {
                // Handle unexpected response format
                logger.warn(`Unexpected response format (${action}):`, response);
                finalMessage = "Received an unexpected response from the background process.";
                finalType = 'warn';
            }

            // Display the final status message (includes duration if available)
            updateStatus(`${finalMessage}${duration ? ` (Time: ${duration}s)` : ''}`, finalType);

            // --- UI Unlocking Logic ---
            // updateStatus hides the loader but might keep buttons locked based on background state check.
            // If the background specifically told us it's still busy, keep it locked.
            if (isStillLockedByBackground) {
                 setUiLockedState(true);
            } else {
                 // Otherwise, rely on the check inside updateStatus or the broadcast listener to unlock.
                 // We could force another check here, but it might be redundant with updateStatus's check.
                 // chrome.runtime.sendMessage({ action: "getSyncState" }, (stateResponse) => {
                 //    setUiLockedState(stateResponse?.isRunning || false);
                 // });
            }
        });

    } catch (error) {
        // Catch errors that happen *before* sending the message (e.g., tab query fails)
        logger.error(`Error before sending message (${action}):`, error);
        updateStatus(`Error: ${error.message || 'Unknown error in popup.'}`, 'error');
        // updateStatus will hide loader; re-check lock state for safety.
         chrome.runtime.sendMessage({ action: "getSyncState" }, (stateResponse) => {
             setUiLockedState(stateResponse?.isRunning || false);
         });
    }
}


// --- Button Event Listeners ---
syncWeekButton.addEventListener('click', () => {
    handleSyncRequest("startSync", userIdInput.value.trim());
});

syncSemesterButton.addEventListener('click', () => {
    handleSyncRequest("startSemesterSync", userIdInput.value.trim());
});

// --- Clear Email Link Listener ---
clearEmailLink.addEventListener('click', () => {
    chrome.storage.local.remove('userId', () => {
        userIdInput.value = ''; // Clear the input field
        logger.info('Stored userId cleared.');
        // updateStatus('Stored email cleared. Please re-enter.', 'info'); // Set status
        // Check lock state before enabling buttons and setting final status
        chrome.runtime.sendMessage({ action: "getSyncState" }, (response) => {
             if (response && response.isRunning) {
                  setUiLockedState(true);
                  updateStatus("A sync operation is currently in progress...", "warn"); // Inform user if still running
             } else {
                  setUiLockedState(false);
                  updateStatus('Stored email cleared. Please re-enter.', 'info'); // Set status only if not locked
             }
             loader.classList.add('hidden'); // Ensure loader is hidden
         });
        userIdInput.focus(); // Focus the input field
    });
});


// <<< ADDED: Listener for Sync State Updates from Background >>>
// This handles cases where the sync finishes while the popup is open.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Check if it's the state update message
    if (message.action === "syncStateUpdate") {
        logger.info(`[POPUP] Received sync state update from background: isRunning = ${message.isRunning}`);
        const currentlyLocked = syncWeekButton.disabled; // Check current UI state

        // Update the UI lock state based on the message
        setUiLockedState(message.isRunning);

        // If the state changed from locked to unlocked by this message
        if (currentlyLocked && !message.isRunning) {
            const currentStatusClass = statusDiv.className || "";
            // Only reset the status message if it wasn't a final success/error message,
            // or if it was the specific "in progress" warning.
            if (!currentStatusClass.includes('status-success') &&
                !currentStatusClass.includes('status-error') ||
                statusDiv.textContent.includes("currently in progress"))
            {
                updateStatus('Enter email and choose an option.'); // Reset to default prompt
                loader.classList.add('hidden'); // Ensure loader is hidden
            }
        }
        // If the state changed from unlocked to locked (less common, e.g., another popup started sync)
        else if (!currentlyLocked && message.isRunning) {
             updateStatus("A sync operation just started...", "warn"); // Update status
        }
    }
    // Indicate that the message listener doesn't need to keep the channel open
    return false;
});
// <<< END ADDED Listener >>>


// --- Add CSS for Status Message Wrapping ---
const style = document.createElement('style');
style.textContent = `
    .status-message {
        white-space: pre-wrap; /* Allow wrapping and preserve newlines */
        word-wrap: break-word; /* Break long words if necessary */
        line-height: 1.4;      /* Improve readability */
        text-align: left;      /* Better for multi-line messages */
        margin-top: 10px;      /* Space above status */
        padding: 8px 10px;     /* Inner padding */
    }
    /* Center loader */
    .loader {
         margin: 10px auto 5px auto;
    }
`;
document.head.appendChild(style);
// --- End CSS ---