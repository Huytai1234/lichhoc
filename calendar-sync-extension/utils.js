// utils.js
'use strict';

/** Simple delay function */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parses DD/MM/YYYY date string to Date object */
export function parseLocalDate(dateString) {
    const parts = dateString.split('/');
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
    const year = parseInt(parts[2], 10);
    if (isNaN(day) || isNaN(month) || isNaN(year) || month < 0 || month > 11 || day < 1 || day > 31) {
        return null;
    }
    const date = new Date(year, month, day);
    // Verify the date wasn't invalid (e.g., 31/02/2023)
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
        return null;
    }
    return date;
}


/**
 * Generates a random integer between min (inclusive) and max (inclusive).
 * @param {number} min - Minimum value.
 * @param {number} max - Maximum value.
 * @returns {number} Random integer.
 */
export function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}