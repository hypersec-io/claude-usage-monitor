/** @format */

const fs = require('fs');
const path = require('path');
const { PATHS, TIMEOUTS, CLAUDE_URLS, isDebugEnabled, getDebugChannel, sleep } = require('./utils');

/**
 * Claude.ai Authentication Manager
 * Handles cookie-based authentication, session validation, and login flow
 */
class ClaudeAuth {
    constructor() {
        this.sessionDir = PATHS.BROWSER_SESSION_DIR;
        this.page = null;
        this.browser = null;
    }

    /**
     * Set the page/browser references (injected from scraper)
     * @param {object} page - Puppeteer page
     * @param {object} browser - Puppeteer browser
     */
    setPageAndBrowser(page, browser) {
        this.page = page;
        this.browser = browser;
    }

    /**
     * Get session directory path
     * @returns {string}
     */
    getSessionDir() {
        return this.sessionDir;
    }

    /**
     * Check if session directory exists with cookie files
     * @returns {boolean}
     */
    hasExistingSession() {
        try {
            if (!fs.existsSync(this.sessionDir)) {
                return false;
            }

            // Check for Chromium cookie files (Chrome, Edge)
            const cookieFiles = [
                path.join(this.sessionDir, 'Default', 'Cookies'),
                path.join(this.sessionDir, 'Default', 'Network', 'Cookies')
            ];

            for (const cookieFile of cookieFiles) {
                if (fs.existsSync(cookieFile)) {
                    const stats = fs.statSync(cookieFile);
                    if (stats.size > 0) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error) {
            console.log('Error checking session:', error);
            return false;
        }
    }

    /**
     * Check if cookie exists and is not expired (local check only)
     * @returns {Promise<{exists: boolean, expired: boolean, cookie: object|null}>}
     */
    async checkCookie() {
        if (!this.page) {
            return { exists: false, expired: true, cookie: null };
        }

        try {
            // Navigate to base URL first to load cookies from userDataDir
            // This is required because Puppeteer doesn't expose cookies until
            // the browser has visited the domain
            const currentUrl = this.page.url();
            if (!currentUrl.includes('claude.ai')) {
                await this.page.goto(CLAUDE_URLS.BASE, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
            }

            const cookies = await this.page.cookies(CLAUDE_URLS.BASE);
            const sessionCookie = cookies.find(c => c.name === 'sessionKey');

            if (!sessionCookie) {
                return { exists: false, expired: true, cookie: null };
            }

            const isExpired = sessionCookie.expires <= Date.now() / 1000;
            return {
                exists: true,
                expired: isExpired,
                cookie: sessionCookie
            };
        } catch (error) {
            console.log('Error checking cookie:', error.message);
            return { exists: false, expired: true, cookie: null };
        }
    }

    /**
     * Validate session with lightweight API call (no page navigation)
     * This is the fast path - uses fetch() instead of goto()
     * @returns {Promise<{valid: boolean, reason: string}>}
     */
    async validateSession() {
        if (!this.page) {
            return { valid: false, reason: 'no_page' };
        }

        const debug = isDebugEnabled();

        // 1. Check cookie locally first (instant)
        const cookieCheck = await this.checkCookie();

        if (!cookieCheck.exists) {
            if (debug) {
                getDebugChannel().appendLine('Auth: No sessionKey cookie found');
            }
            return { valid: false, reason: 'no_cookie' };
        }

        if (cookieCheck.expired) {
            if (debug) {
                getDebugChannel().appendLine('Auth: sessionKey cookie expired');
            }
            return { valid: false, reason: 'cookie_expired' };
        }

        // 2. Validate with lightweight API fetch (no page navigation)
        try {
            if (debug) {
                getDebugChannel().appendLine('Auth: Validating session with API call...');
            }

            const apiUrl = CLAUDE_URLS.API_ORGS;
            const isValid = await this.page.evaluate(async (url) => {
                try {
                    const response = await fetch(url, {
                        method: 'GET',
                        credentials: 'include'
                    });
                    return response.ok;
                } catch {
                    return false;
                }
            }, apiUrl);

            if (debug) {
                getDebugChannel().appendLine(`Auth: API validation result: ${isValid ? 'valid' : 'invalid'}`);
            }

            return {
                valid: isValid,
                reason: isValid ? 'valid' : 'server_rejected'
            };
        } catch (error) {
            if (debug) {
                getDebugChannel().appendLine(`Auth: Validation error: ${error.message}`);
            }
            return { valid: false, reason: 'validation_error' };
        }
    }

    /**
     * Wait for login by polling for sessionKey cookie
     * Does not navigate or disturb the login page
     * @param {number} maxWaitMs - Maximum wait time in milliseconds
     * @param {number} pollIntervalMs - Polling interval in milliseconds
     * @returns {Promise<boolean>} True if login successful
     */
    async waitForLogin(maxWaitMs = TIMEOUTS.LOGIN_WAIT, pollIntervalMs = TIMEOUTS.LOGIN_POLL) {
        const debug = isDebugEnabled();
        const startTime = Date.now();

        if (debug) {
            getDebugChannel().appendLine(`Auth: Waiting for login (max ${maxWaitMs / 1000}s)...`);
        }

        while (Date.now() - startTime < maxWaitMs) {
            await sleep(pollIntervalMs);

            try {
                const cookies = await this.page.cookies(CLAUDE_URLS.BASE);
                const hasSessionKey = cookies.some(c => c.name === 'sessionKey');

                if (hasSessionKey) {
                    if (debug) {
                        getDebugChannel().appendLine('Auth: sessionKey cookie detected - login successful');
                    }
                    return true;
                }
            } catch (error) {
                console.log('Cookie check error:', error.message);
            }
        }

        if (debug) {
            getDebugChannel().appendLine('Auth: Login timeout');
        }
        return false;
    }

    /**
     * Clear session - delete stored browser session data
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async clearSession() {
        const debug = isDebugEnabled();

        if (debug) {
            getDebugChannel().appendLine(`\n=== CLEAR SESSION (${new Date().toLocaleString()}) ===`);
        }

        try {
            if (fs.existsSync(this.sessionDir)) {
                fs.rmSync(this.sessionDir, { recursive: true, force: true });
                if (debug) {
                    getDebugChannel().appendLine(`Deleted session directory: ${this.sessionDir}`);
                }
            }

            if (debug) {
                getDebugChannel().appendLine('Session cleared - next fetch will prompt for fresh login');
            }

            return { success: true, message: 'Session cleared successfully. Next fetch will prompt for login.' };
        } catch (error) {
            console.error('Failed to delete session directory:', error);
            if (debug) {
                getDebugChannel().appendLine(`Failed to delete session directory: ${error.message}`);
            }
            return { success: false, message: `Failed to clear session: ${error.message}` };
        }
    }

    /**
     * Get diagnostic information
     * @returns {object}
     */
    getDiagnostics() {
        return {
            sessionDir: this.sessionDir,
            hasExistingSession: this.hasExistingSession(),
            hasPage: !!this.page,
            hasBrowser: !!this.browser
        };
    }
}

module.exports = { ClaudeAuth };
