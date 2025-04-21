// google-auth.js
'use strict';

import { logger } from './logger.js';
import * as constants from './constants.js';
// showNotification needs to be passed or imported if moved from background.js
// Assuming showNotification remains in background.js for now and is accessible

/**
 * Forces interactive Google login and returns an OAuth2 access token.
 * Uses Manifest V3 compatible chrome.identity.launchWebAuthFlow.
 * @param {string} [userIdHint] - Optional email hint for the login screen.
 * @param {Function} showNotificationRef - Reference to the showNotification function.
 * @returns {Promise<string>} Resolves with the access token.
 * @throws {Error} If authentication fails or is cancelled.
 */
export function forceGoogleLoginAndGetToken(userIdHint, showNotificationRef) {
    const authUniqueId = `auth-${Date.now()}`;
    logger.info(`BG AUTH [${authUniqueId}]: --- ENTERING forceGoogleLoginAndGetToken V3 ---`);
    logger.debug(`BG AUTH [${authUniqueId}]: Hint: ${userIdHint}`);

    return new Promise((resolve, reject) => {
        logger.debug(`BG AUTH [${authUniqueId}]: Inside Promise V3.`);

        if (!constants.GOOGLE_CLIENT_ID || !constants.GOOGLE_SCOPES || constants.GOOGLE_CLIENT_ID.includes("YOUR_")) {
            const errorMsg = "BG AUTH FATAL V3: Client ID/Scopes invalid/missing.";
            logger.error(`BG AUTH [${authUniqueId}]: ${errorMsg}`);
            showNotificationRef("Lỗi Cấu Hình Auth", errorMsg, 'basic', `cfg_fatal_${authUniqueId}`);
            return reject(new Error(errorMsg));
        }
        logger.debug(`BG AUTH [${authUniqueId}]: Config check OK.`);

        let finalAuthUrl;
        try {
            const extensionId = chrome.runtime.id;
            if (!extensionId) throw new Error("Cannot get Extension ID.");
            const specificRedirectUri = `https://${extensionId}.chromiumapp.org/google`;
            logger.info(`BG AUTH [${authUniqueId}]: Redirect URI: ${specificRedirectUri}`);

            const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
            authUrl.searchParams.set('client_id', constants.GOOGLE_CLIENT_ID);
            authUrl.searchParams.set('response_type', 'token');
            authUrl.searchParams.set('redirect_uri', specificRedirectUri);
            authUrl.searchParams.set('scope', constants.GOOGLE_SCOPES);
            authUrl.searchParams.set('prompt', 'consent select_account');
            if (userIdHint) authUrl.searchParams.set('login_hint', userIdHint);
            finalAuthUrl = authUrl.toString();
            logger.info(`BG AUTH [${authUniqueId}]: Auth URL Built (start): ${finalAuthUrl.substring(0, 200)}...`);
        } catch (setupError) {
            logger.error(`BG AUTH [${authUniqueId}]: Auth URL setup error:`, setupError);
            return reject(new Error(`Setup Auth URL Error: ${setupError.message}`));
        }

        try {
            logger.debug(`BG AUTH [${authUniqueId}]: CALLING launchWebAuthFlow NOW...`);
            chrome.identity.launchWebAuthFlow({ url: finalAuthUrl, interactive: true }, (redirectUrl) => {
                // ... (rest of the launchWebAuthFlow callback logic - unchanged) ...
                 logger.info(`BG AUTH [${authUniqueId}]: --- launchWebAuthFlow CALLBACK START ---`);
                const lastError = chrome.runtime.lastError;
                logger.debug(`BG AUTH [${authUniqueId}]: Callback - lastError:`, lastError);
                logger.debug(`BG AUTH [${authUniqueId}]: Callback - redirectUrl:`, redirectUrl ? redirectUrl.substring(0, 100) + '...' : redirectUrl);

                if (lastError || !redirectUrl) {
                    const errorMsg = lastError?.message || "Auth failed/cancelled (No redirect URL received).";
                    logger.error(`BG AUTH [${authUniqueId}]: Callback - FAILED/Cancelled. Msg: ${errorMsg}`);
                    return reject(new Error(errorMsg));
                }

                logger.info(`BG AUTH [${authUniqueId}]: Callback - Auth successful, processing redirect URL...`);
                try {
                    const fragmentIndex = redirectUrl.indexOf('#');
                    if (fragmentIndex === -1) {
                        return reject(new Error("Auth Callback Error: No fragment (#) found in redirect URL."));
                    }
                    const params = new URLSearchParams(redirectUrl.substring(fragmentIndex + 1));
                    const accessToken = params.get('access_token');
                    const errorParam = params.get('error');
                    logger.debug(`BG AUTH [${authUniqueId}]: Callback - Parsed params:`, Object.fromEntries(params.entries()));
                    if (errorParam) {
                        return reject(new Error(`Google Auth Error: ${errorParam}`));
                    }
                    if (!accessToken) {
                        return reject(new Error("Auth Callback Error: No access_token found in redirect URL fragment."));
                    }
                    logger.info(`BG AUTH [${authUniqueId}]: Callback - Access Token received successfully! Resolving promise.`);
                    resolve(accessToken);
                } catch (parseError) {
                    logger.error(`BG AUTH [${authUniqueId}]: Callback - Error parsing redirect URL fragment:`, parseError);
                    return reject(new Error("Auth Callback Error: Failed to process redirect URL fragment."));
                } finally {
                    logger.info(`BG AUTH [${authUniqueId}]: --- launchWebAuthFlow CALLBACK END ---`);
                }
            });
            logger.debug(`BG AUTH [${authUniqueId}]: Called launchWebAuthFlow, waiting...`);
        } catch (launchError) {
            logger.error(`BG AUTH [${authUniqueId}]: Error calling launchWebAuthFlow API:`, launchError);
            return reject(new Error(`Error initiating auth flow: ${launchError.message}`));
        }
    });
}