// logger.js
'use strict';

export const logger = {
    info: (...args) => console.log("[BACKGROUND INFO]", new Date().toISOString(), ...args),
    warn: (...args) => console.warn("[BACKGROUND WARN]", new Date().toISOString(), ...args),
    error: (...args) => console.error("[BACKGROUND ERROR]", new Date().toISOString(), ...args),
    debug: (...args) => console.debug("[BACKGROUND DEBUG]", new Date().toISOString(), ...args)
};