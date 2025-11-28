/** @format */

const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const vscode = require('vscode');

const { ClaudeAuth } = require('./auth');
const {
    CONFIG_NAMESPACE,
    TIMEOUTS,
    VIEWPORT,
    CLAUDE_URLS,
    isDebugEnabled,
    getDebugChannel,
    setDevMode,
    sleep
} = require('./utils');
const {
    USAGE_API_SCHEMA,
    API_ENDPOINTS,
    extractFromSchema,
    matchesEndpoint,
    processOverageData,
    getSchemaInfo,
} = require('./apiSchema');

/**
 * Claude.ai Usage Scraper
 * Handles browser automation for fetching usage data from Claude.ai
 */
class ClaudeUsageScraper {
    constructor() {
        this.browser = null;
        this.page = null;
        this.isInitialized = false;
        this.browserPort = null; // Will be set dynamically for browser remote debugging
        this.isConnectedBrowser = false;

        // API endpoint capture
        this.apiEndpoint = null;
        this.apiHeaders = null;
        this.creditsEndpoint = null;
        this.overageEndpoint = null;
        this.capturedEndpoints = [];

        // Auth module
        this.auth = new ClaudeAuth();
    }

    /**
     * Find an available port for browser remote debugging
     * @returns {Promise<number>}
     */
    async findAvailablePort() {
        const net = require('net');
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.unref();
            server.on('error', reject);
            server.listen(0, () => {
                const port = server.address().port;
                server.close(() => resolve(port));
            });
        });
    }

    /**
     * Get session directory (delegate to auth)
     */
    get sessionDir() {
        return this.auth.getSessionDir();
    }

    /**
     * Find Chrome/Chromium executable on the system
     * @returns {string|null} Path to Chrome executable, or null if not found
     */
    findChrome() {
        const chromePaths = [];

        if (process.platform === 'win32') {
            chromePaths.push(
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
                'C:\\AppInstall\\scoop\\apps\\googlechrome\\current\\chrome.exe',
                // Edge is Chromium-based, works as fallback
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
            );
        } else if (process.platform === 'darwin') {
            chromePaths.push(
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
            );
        } else {
            // Linux
            chromePaths.push(
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/snap/bin/chromium',
                '/usr/bin/microsoft-edge',
                '/usr/bin/microsoft-edge-stable'
            );
        }

        for (const chromePath of chromePaths) {
            try {
                if (fs.existsSync(chromePath)) {
                    console.log(`Found Chrome at: ${chromePath}`);
                    return chromePath;
                }
            } catch (err) {
                // Continue to next path
            }
        }

        return null;
    }

    /**
     * Try to connect to an existing browser instance
     * @returns {Promise<boolean>}
     */
    async tryConnectToExisting() {
        try {
            const browserURL = `http://127.0.0.1:${this.browserPort}`;
            this.browser = await puppeteer.connect({
                browserURL,
                defaultViewport: null
            });

            const pages = await this.browser.pages();
            if (pages.length > 0) {
                for (const page of pages) {
                    const url = page.url();
                    if (url.includes(CLAUDE_URLS.BASE)) {
                        this.page = page;
                        break;
                    }
                }
                if (!this.page) {
                    this.page = pages[0];
                }
            } else {
                this.page = await this.browser.newPage();
            }

            await this.page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            );

            await this.setupRequestInterception();

            this.isInitialized = true;
            this.isConnectedBrowser = true;
            this.auth.setPageAndBrowser(this.page, this.browser);

            console.log('Successfully connected to existing browser');
            return true;
        } catch (error) {
            console.log('Could not connect to existing browser:', error.message);
            return false;
        }
    }

    /**
     * Check if session exists (delegate to auth)
     * @returns {boolean}
     */
    hasExistingSession() {
        return this.auth.hasExistingSession();
    }

    /**
     * Initialize the Puppeteer browser instance
     * @param {boolean} forceHeaded - Force browser to show
     */
    async initialize(forceHeaded = false) {
        // If already initialized with a valid browser, skip
        if (this.isInitialized && this.browser) {
            try {
                await this.browser.version();
                return;
            } catch (error) {
                this.browser = null;
                this.page = null;
                this.isInitialized = false;
            }
        }

        // Note: We no longer try to connect to existing browsers since we close
        // the browser after each fetch to save resources

        const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        const userHeadless = config.get('headless', true);
        const headless = forceHeaded ? false : userHeadless;

        try {
            const chromePath = this.findChrome();

            // Chrome is required for web scraping
            if (!chromePath) {
                throw new Error('CHROME_NOT_FOUND');
            }

            // Find an available port dynamically to avoid conflicts
            this.browserPort = await this.findAvailablePort();

            const launchOptions = {
                headless: headless ? 'new' : false,
                userDataDir: this.sessionDir,
                executablePath: chromePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    `--remote-debugging-port=${this.browserPort}`
                ],
                defaultViewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT }
            };

            console.log(`Launching Chrome on port ${this.browserPort}`);
            this.browser = await puppeteer.launch(launchOptions);
            this.page = await this.browser.newPage();

            await this.page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            );

            await this.setupRequestInterception();

            this.isInitialized = true;
            this.isConnectedBrowser = false;
            this.auth.setPageAndBrowser(this.page, this.browser);

            console.log('Successfully launched new browser');
        } catch (error) {
            if (error.message.includes('already running')) {
                throw new Error('Browser session is locked by another process. Please close all Chrome/Edge windows and try again, or restart VSCode.');
            }
            throw new Error(`Failed to launch browser: ${error.message}. Make sure Chromium is installed.`);
        }
    }

    /**
     * Ensure user is logged into Claude.ai
     * Uses fast cookie validation, falls back to login flow
     */
    async ensureLoggedIn() {
        const debug = isDebugEnabled();

        try {
            // Fast path: validate session with API call (no page navigation)
            const validation = await this.auth.validateSession();

            if (validation.valid) {
                if (debug) {
                    getDebugChannel().appendLine('Auth: Session valid (fast path)');
                }
                // Navigate to usage page now that we know we're authenticated
                await this.page.goto(CLAUDE_URLS.USAGE, {
                    waitUntil: 'networkidle2',
                    timeout: TIMEOUTS.PAGE_LOAD
                });
                return;
            }

            if (debug) {
                getDebugChannel().appendLine(`Auth: Session invalid (${validation.reason}), need login`);
            }

            // Need login - open headed browser with progress notification
            await this.forceOpenBrowser();

            // Wait for login with dismissable progress notification
            const loggedIn = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Login required. Please log in to Claude.ai in the browser window...',
                    cancellable: false
                },
                async () => {
                    return await this.auth.waitForLogin();
                }
            );

            if (loggedIn) {
                // Show success message that auto-dismisses after 3 seconds
                vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: '✓ Login successful! Session saved.',
                        cancellable: false
                    },
                    () => new Promise(resolve => setTimeout(resolve, 3000))
                );

                // Close the headed browser and relaunch in headless mode
                // Session is saved in userDataDir so we stay logged in
                await this.close();
                await this.initialize(false); // false = use headless setting

                await this.page.goto(CLAUDE_URLS.USAGE, {
                    waitUntil: 'networkidle2',
                    timeout: TIMEOUTS.PAGE_LOAD
                });
            } else {
                throw new Error('Login timeout. Please try again and complete the login process.');
            }
        } catch (error) {
            if (error.message.includes('timeout')) {
                throw new Error('Failed to load Claude.ai. Please check your internet connection.');
            }
            throw error;
        }
    }

    /**
     * Set up request interception to capture Claude API calls
     */
    async setupRequestInterception() {
        try {
            await this.page.setRequestInterception(true);
            this.capturedEndpoints = [];

            this.page.on('request', (request) => {
                const url = request.url();

                if (url.includes('/api/')) {
                    if (isDebugEnabled()) {
                        getDebugChannel().appendLine(`[REQUEST] ${request.method()} ${url}`);
                    }
                    this.capturedEndpoints.push({ method: request.method(), url });
                }

                if (matchesEndpoint(url, API_ENDPOINTS.usage)) {
                    this.apiEndpoint = url;
                    this.apiHeaders = {
                        ...request.headers(),
                        'Content-Type': 'application/json'
                    };
                    console.log('Captured usage endpoint:', this.apiEndpoint);
                }

                if (matchesEndpoint(url, API_ENDPOINTS.prepaidCredits)) {
                    this.creditsEndpoint = url;
                    console.log('Captured credits endpoint:', this.creditsEndpoint);
                }

                if (matchesEndpoint(url, API_ENDPOINTS.overageSpendLimit)) {
                    this.overageEndpoint = url;
                    console.log('Captured overage endpoint:', this.overageEndpoint);
                }

                request.continue();
            });

            this.page.on('response', async (response) => {
                const url = response.url();

                if (isDebugEnabled() && url.includes('/api/') && response.status() === 200) {
                    try {
                        const contentType = response.headers()['content-type'] || '';
                        if (contentType.includes('application/json')) {
                            const data = await response.json();
                            const debugOutput = getDebugChannel();
                            debugOutput.appendLine(`[RESPONSE] ${url}`);
                            debugOutput.appendLine(JSON.stringify(data, null, 2));
                            debugOutput.appendLine('---');
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            });

            console.log('Request interception enabled for API capture');
        } catch (error) {
            console.warn('Failed to set up request interception:', error.message);
        }
    }

    /**
     * Calculate human-readable reset time from ISO timestamp
     * @param {string} isoTimestamp
     * @returns {string}
     */
    calculateResetTime(isoTimestamp) {
        if (!isoTimestamp) return 'Unknown';

        try {
            const resetDate = new Date(isoTimestamp);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs <= 0) return 'Soon';

            const hours = Math.floor(diffMs / (1000 * 60 * 60));
            const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            if (hours > 24) {
                const days = Math.floor(hours / 24);
                const remainingHours = hours % 24;
                return `${days}d ${remainingHours}h`;
            } else if (hours > 0) {
                return `${hours}h ${minutes}m`;
            } else {
                return `${minutes}m`;
            }
        } catch (error) {
            console.error('Error calculating reset time:', error);
            return 'Unknown';
        }
    }

    /**
     * Process API response using schema
     * @param {object} apiResponse
     * @param {object} creditsData
     * @param {object} overageData
     * @returns {object}
     */
    processApiResponse(apiResponse, creditsData = null, overageData = null) {
        try {
            const data = extractFromSchema(apiResponse, USAGE_API_SCHEMA);
            const monthlyCredits = processOverageData(overageData);

            return {
                usagePercent: data.fiveHour.utilization,
                resetTime: this.calculateResetTime(data.fiveHour.resetsAt),
                usagePercentWeek: data.sevenDay.utilization,
                resetTimeWeek: this.calculateResetTime(data.sevenDay.resetsAt),
                usagePercentSonnet: data.sevenDaySonnet.utilization,
                resetTimeSonnet: this.calculateResetTime(data.sevenDaySonnet.resetsAt),
                usagePercentOpus: data.sevenDayOpus.utilization,
                resetTimeOpus: this.calculateResetTime(data.sevenDayOpus.resetsAt),
                extraUsage: data.extraUsage.value,
                prepaidCredits: creditsData ?? null,
                monthlyCredits: monthlyCredits,
                timestamp: new Date(),
                rawData: apiResponse,
                schemaVersion: getSchemaInfo().version,
            };
        } catch (error) {
            console.error('Error processing API response:', error);
            throw new Error('Failed to process API response data');
        }
    }

    /**
     * Fetch usage data from Claude.ai
     * @returns {Promise<object>}
     */
    async fetchUsageData() {
        const debug = isDebugEnabled();

        try {
            await this.page.goto(CLAUDE_URLS.USAGE, {
                waitUntil: 'networkidle2',
                timeout: TIMEOUTS.PAGE_LOAD
            });

            await sleep(TIMEOUTS.API_RETRY_DELAY);

            if (debug) {
                const debugOutput = getDebugChannel();
                debugOutput.appendLine(`\n=== FETCH ATTEMPT (${new Date().toLocaleString()}) ===`);
                debugOutput.appendLine(`API endpoint captured: ${this.apiEndpoint ? 'YES' : 'NO'}`);
                debugOutput.appendLine(`Credits endpoint captured: ${this.creditsEndpoint ? 'YES' : 'NO'}`);
                debugOutput.appendLine(`Overage endpoint captured: ${this.overageEndpoint ? 'YES' : 'NO'}`);
            }

            if (this.apiEndpoint && this.apiHeaders) {
                try {
                    console.log('Using captured API endpoint for direct access');
                    if (debug) getDebugChannel().appendLine('Attempting direct API fetch...');

                    const cookies = await this.page.cookies();
                    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

                    const response = await this.page.evaluate(async (endpoint, headers, cookieStr) => {
                        const resp = await fetch(endpoint, {
                            method: 'GET',
                            headers: { ...headers, 'Cookie': cookieStr }
                        });
                        if (!resp.ok) throw new Error(`API request failed: ${resp.status}`);
                        return await resp.json();
                    }, this.apiEndpoint, this.apiHeaders, cookieString);

                    if (debug) {
                        getDebugChannel().appendLine('Direct API fetch SUCCESS!');
                        getDebugChannel().appendLine(JSON.stringify(response, null, 2));
                    }

                    // Fetch credits and overage data
                    let creditsData = null;
                    let overageData = null;

                    if (this.creditsEndpoint) {
                        try {
                            creditsData = await this.page.evaluate(async (endpoint, headers, cookieStr) => {
                                const resp = await fetch(endpoint, {
                                    method: 'GET',
                                    headers: { ...headers, 'Cookie': cookieStr }
                                });
                                return resp.ok ? await resp.json() : null;
                            }, this.creditsEndpoint, this.apiHeaders, cookieString);
                        } catch (e) {
                            if (debug) getDebugChannel().appendLine(`Credits fetch error: ${e.message}`);
                        }
                    }

                    if (this.overageEndpoint) {
                        try {
                            overageData = await this.page.evaluate(async (endpoint, headers, cookieStr) => {
                                const resp = await fetch(endpoint, {
                                    method: 'GET',
                                    headers: { ...headers, 'Cookie': cookieStr }
                                });
                                return resp.ok ? await resp.json() : null;
                            }, this.overageEndpoint, this.apiHeaders, cookieString);
                        } catch (e) {
                            if (debug) getDebugChannel().appendLine(`Overage fetch error: ${e.message}`);
                        }
                    }

                    console.log('Successfully fetched data via API');
                    return this.processApiResponse(response, creditsData, overageData);

                } catch (apiError) {
                    console.log('API call failed, falling back to HTML scraping:', apiError.message);
                    if (debug) getDebugChannel().appendLine(`Direct API fetch FAILED: ${apiError.message}`);
                }
            }

            // Fallback: HTML scraping
            console.log('Using HTML scraping method');
            if (debug) getDebugChannel().appendLine('Falling back to HTML scraping...');

            const data = await this.page.evaluate(() => {
                const bodyText = document.body.innerText;
                const usageMatch = bodyText.match(/(\d+)%\s*used/i);
                const resetMatch = bodyText.match(/Resets?\s+in\s+([^\n]+)/i);
                return {
                    usagePercent: usageMatch ? parseInt(usageMatch[1], 10) : null,
                    resetTime: resetMatch ? resetMatch[1].trim() : null
                };
            });

            if (data.usagePercent === null) {
                throw new Error('Could not find usage percentage. Page layout may have changed.');
            }

            return {
                usagePercent: data.usagePercent,
                resetTime: data.resetTime || 'Unknown',
                timestamp: new Date()
            };

        } catch (error) {
            if (error.message.includes('timeout')) {
                throw new Error('Usage page took too long to load. Please try again.');
            }
            throw error;
        }
    }

    /**
     * Close/disconnect from the browser
     */
    async close() {
        if (this.browser) {
            if (this.isConnectedBrowser) {
                await this.browser.disconnect();
                console.log('Disconnected from shared browser');
            } else {
                await this.browser.close();
                console.log('Closed browser instance');
            }
            this.browser = null;
            this.page = null;
            this.isInitialized = false;
            this.isConnectedBrowser = false;
        }
    }

    /**
     * Reset connection and clear captured endpoints
     * @returns {Promise<object>}
     */
    async reset() {
        const debug = isDebugEnabled();
        if (debug) {
            getDebugChannel().appendLine(`\n=== RESET CONNECTION (${new Date().toLocaleString()}) ===`);
        }

        await this.close();

        this.apiEndpoint = null;
        this.apiHeaders = null;
        this.creditsEndpoint = null;
        this.overageEndpoint = null;
        this.capturedEndpoints = [];

        if (debug) {
            getDebugChannel().appendLine('Browser connection closed');
            getDebugChannel().appendLine('All captured API endpoints cleared');
        }

        return { success: true, message: 'Connection reset successfully' };
    }

    /**
     * Clear session (delegate to auth + reset)
     * @returns {Promise<object>}
     */
    async clearSession() {
        await this.reset();
        return await this.auth.clearSession();
    }

    /**
     * Force open browser in headed mode for login
     * @returns {Promise<object>}
     */
    async forceOpenBrowser() {
        const debug = isDebugEnabled();
        if (debug) {
            getDebugChannel().appendLine(`\n=== FORCE OPEN BROWSER (${new Date().toLocaleString()}) ===`);
        }

        try {
            if (this.browser) {
                try {
                    if (this.isConnectedBrowser) {
                        await this.browser.disconnect();
                    } else {
                        await this.browser.close();
                    }
                } catch (e) {
                    // Ignore close errors
                }
                this.browser = null;
                this.page = null;
                this.isInitialized = false;
            }

            const chromePath = this.findChrome();

            if (!chromePath) {
                throw new Error('CHROME_NOT_FOUND');
            }

            // Get a fresh available port
            this.browserPort = await this.findAvailablePort();

            const launchOptions = {
                headless: false,
                userDataDir: this.sessionDir,
                executablePath: chromePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    `--remote-debugging-port=${this.browserPort}`
                ],
                defaultViewport: { width: VIEWPORT.WIDTH, height: VIEWPORT.HEIGHT }
            };

            if (debug) {
                getDebugChannel().appendLine(`Launching headed Chrome browser...`);
                getDebugChannel().appendLine(`Executable: ${chromePath}`);
            }

            this.browser = await puppeteer.launch(launchOptions);
            this.page = await this.browser.newPage();

            await this.page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            );

            await this.setupRequestInterception();

            this.isInitialized = true;
            this.isConnectedBrowser = false;
            this.auth.setPageAndBrowser(this.page, this.browser);

            await this.page.goto(CLAUDE_URLS.LOGIN, {
                waitUntil: 'networkidle2',
                timeout: TIMEOUTS.PAGE_LOAD
            });

            if (debug) {
                getDebugChannel().appendLine('Browser opened successfully - awaiting login');
            }

            return { success: true, message: 'Browser opened. Please log in to Claude.ai.' };
        } catch (error) {
            if (debug) {
                getDebugChannel().appendLine(`Failed to open browser: ${error.message}`);
            }
            return { success: false, message: `Failed to open browser: ${error.message}` };
        }
    }

    /**
     * Get diagnostic information
     * @returns {object}
     */
    getDiagnostics() {
        const schemaInfo = getSchemaInfo();
        const authDiag = this.auth.getDiagnostics();

        return {
            isInitialized: this.isInitialized,
            isConnectedBrowser: this.isConnectedBrowser,
            hasBrowser: !!this.browser,
            hasPage: !!this.page,
            hasApiEndpoint: !!this.apiEndpoint,
            hasApiHeaders: !!this.apiHeaders,
            hasCreditsEndpoint: !!this.creditsEndpoint,
            hasOverageEndpoint: !!this.overageEndpoint,
            capturedEndpointsCount: this.capturedEndpoints?.length || 0,
            ...authDiag,
            schemaVersion: schemaInfo.version,
            schemaFields: schemaInfo.usageFields,
            schemaEndpoints: schemaInfo.endpoints,
        };
    }
}

// Re-export from utils for backwards compatibility
module.exports = {
    ClaudeUsageScraper,
    getDebugChannel,
    setDevMode
};
