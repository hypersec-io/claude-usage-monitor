/** @format */

const vscode = require('vscode');
const path = require('path');
const os = require('os');

/**
 * Shared utility functions and constants for the Claude Usage extension
 */

// ============================================================================
// EXTENSION CONSTANTS - Centralized strings to avoid duplication
// ============================================================================

// VS Code configuration namespace
const CONFIG_NAMESPACE = 'claudeMonitor';

// Command IDs (must match package.json)
const COMMANDS = {
    FETCH_NOW: 'claude-usage.fetchNow',
    OPEN_SETTINGS: 'claude-usage.openSettings',
    START_SESSION: 'claude-usage.startNewSession',
    SHOW_DEBUG: 'claude-usage.showDebug',
    RESET_CONNECTION: 'claude-usage.resetConnection',
    CLEAR_SESSION: 'claude-usage.clearSession',
    OPEN_BROWSER: 'claude-usage.openBrowser'
};

// File/directory paths
const PATHS = {
    BROWSER_SESSION_DIR: path.join(os.homedir(), '.claude-browser-session'),
    SESSION_DATA_FILE: path.join(os.tmpdir(), 'claude-session-data.json'),
    USAGE_HISTORY_FILE: path.join(os.tmpdir(), 'claude-usage-history.json')
};

// Claude Code default context window limit (tokens) - fallback if setting not available
const DEFAULT_TOKEN_LIMIT = 200000;

// Timeouts and intervals (in milliseconds)
const TIMEOUTS = {
    PAGE_LOAD: 30000,           // 30 seconds - max wait for page to load
    LOGIN_WAIT: 300000,         // 5 minutes - max wait for user to complete login
    LOGIN_POLL: 2000,           // 2 seconds - interval between login status checks
    API_RETRY_DELAY: 2000,      // 2 seconds - delay before retrying API calls
    SESSION_DURATION: 3600000   // 1 hour - duration to consider a session "active"
};

// Browser viewport settings
const VIEWPORT = {
    WIDTH: 1280,
    HEIGHT: 800
};

// Claude.ai URLs
const CLAUDE_URLS = {
    BASE: 'https://claude.ai',
    LOGIN: 'https://claude.ai/login',
    USAGE: 'https://claude.ai/settings/usage',
    API_ORGS: 'https://claude.ai/api/organizations'
};

/**
 * Get the configured token limit from settings
 * Falls back to DEFAULT_TOKEN_LIMIT if setting not available
 * @returns {number} Token limit
 */
function getTokenLimit() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return config.get('tokenLimit', DEFAULT_TOKEN_LIMIT);
}

// Debug output channel (lazy creation)
let debugChannel = null;

// Track if running in development mode
let runningInDevMode = false;

/**
 * Set development mode flag
 * @param {boolean} isDev
 */
function setDevMode(isDev) {
    runningInDevMode = isDev;
}

/**
 * Check if debug mode is enabled via settings OR running in development mode
 * @returns {boolean}
 */
function isDebugEnabled() {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const userEnabled = config.get('debug', false);
    return userEnabled || runningInDevMode;
}

/**
 * Get or create the debug output channel
 * @returns {vscode.OutputChannel}
 */
function getDebugChannel() {
    if (!debugChannel) {
        debugChannel = vscode.window.createOutputChannel('Claude Usage - API Debug');
    }
    return debugChannel;
}

/**
 * Dispose debug channel (call on deactivation)
 */
function disposeDebugChannel() {
    if (debugChannel) {
        debugChannel.dispose();
        debugChannel = null;
    }
}

/**
 * Sleep/wait helper
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate the actual clock time when reset will occur
 * @param {string} resetTime - Relative time like "2h 30m" or "5d 21h"
 * @returns {string} Clock time with optional day
 */
function calculateResetClockTime(resetTime) {
    try {
        const days = resetTime.match(/(\d+)d/);
        const hours = resetTime.match(/(\d+)h/);
        const minutes = resetTime.match(/(\d+)m/);

        let totalMinutes = 0;
        if (days) totalMinutes += parseInt(days[1]) * 24 * 60;
        if (hours) totalMinutes += parseInt(hours[1]) * 60;
        if (minutes) totalMinutes += parseInt(minutes[1]);

        const now = new Date();
        const resetDate = new Date(now.getTime() + totalMinutes * 60 * 1000);

        const hour = resetDate.getHours().toString().padStart(2, '0');
        const minute = resetDate.getMinutes().toString().padStart(2, '0');
        const timeStr = `${hour}:${minute}`;

        if (totalMinutes >= 24 * 60) {
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const dayName = dayNames[resetDate.getDay()];
            const date = resetDate.getDate();
            return `${dayName} ${date} ${timeStr}`;
        }

        return timeStr;
    } catch (error) {
        return '??:??';
    }
}

/**
 * Get currency symbol for a currency code
 * @param {string} currency - ISO 4217 currency code (e.g., "USD", "AUD", "EUR")
 * @returns {string} Currency symbol
 */
function getCurrencySymbol(currency) {
    const symbols = {
        USD: '$',
        AUD: '$',
        CAD: '$',
        EUR: '€',
        GBP: '£',
        JPY: '¥',
        CNY: '¥',
        KRW: '₩',
        INR: '₹',
        BRL: 'R$',
        MXN: '$',
        CHF: 'CHF ',
        SEK: 'kr',
        NOK: 'kr',
        DKK: 'kr',
        NZD: '$',
        SGD: '$',
        HKD: '$',
    };
    return symbols[currency] || '';
}

/**
 * Format a number with K/M suffix for compact display
 * @param {number} value - Number to format
 * @returns {string} Formatted string
 */
function formatCompact(value) {
    if (value >= 1000000) {
        return `${(value / 1000000).toFixed(1)}M`;
    } else if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}K`;
    }
    return Math.round(value).toString();
}

module.exports = {
    // Constants
    CONFIG_NAMESPACE,
    COMMANDS,
    PATHS,
    DEFAULT_TOKEN_LIMIT,
    TIMEOUTS,
    VIEWPORT,
    CLAUDE_URLS,
    // Functions
    getTokenLimit,
    setDevMode,
    isDebugEnabled,
    getDebugChannel,
    disposeDebugChannel,
    sleep,
    calculateResetClockTime,
    getCurrencySymbol,
    formatCompact
};
