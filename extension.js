const vscode = require('vscode');
const { UsageDataProvider } = require('./src/dataProvider');
const { createStatusBarItem, updateStatusBar, startSpinner, stopSpinner } = require('./src/statusBar');
const { ActivityMonitor } = require('./src/activityMonitor');
const { SessionTracker } = require('./src/sessionTracker');
const { ClaudeDataLoader } = require('./src/claudeDataLoader');
const { CONFIG_NAMESPACE, COMMANDS, getTokenLimit, setDevMode, isDebugEnabled, getDebugChannel, disposeDebugChannel } = require('./src/utils');

let statusBarItem;
let dataProvider;
let autoRefreshTimer;
let activityMonitor;
let sessionTracker;
let claudeDataLoader;
let jsonlWatcher;

// Lazy-created diagnostic channel for token monitoring
let tokenDiagnosticChannel = null;
function getTokenDiagnosticChannel() {
    if (!tokenDiagnosticChannel) {
        tokenDiagnosticChannel = vscode.window.createOutputChannel('Claude Usage - Token Monitor');
    }
    return tokenDiagnosticChannel;
}

/**
 * Debug logger - only logs when debug mode is enabled
 * @param {string} message - Message to log
 */
function debugLog(message) {
    if (isDebugEnabled()) {
        getTokenDiagnosticChannel().appendLine(message);
    }
}

/**
 * Perform a usage fetch with spinner and error handling
 * @returns {Promise<{webError: Error|null, tokenError: Error|null}>}
 */
async function performFetch() {
    let webError = null;
    let tokenError = null;

    try {
        startSpinner();
        const result = await dataProvider.fetchUsage();
        webError = result.webError;

        // Check if token data is available
        const sessionData = sessionTracker ? await sessionTracker.getCurrentSession() : null;
        if (!sessionData || !sessionData.tokenUsage) {
            tokenError = new Error('No token data available');
        }
    } catch (error) {
        webError = webError || error;
        console.error('Failed to fetch usage:', error);
    } finally {
        stopSpinner(webError, tokenError);
        // Update status bar AFTER spinner stops so tooltip gets set correctly
        await updateStatusBarWithAllData();
    }

    return { webError, tokenError };
}

/**
 * Helper function to update status bar and tree view with all data
 */
async function updateStatusBarWithAllData() {
    const sessionData = sessionTracker ? await sessionTracker.getCurrentSession() : null;
    const activityStats = activityMonitor ? activityMonitor.getStats(dataProvider.usageData, sessionData) : null;
    updateStatusBar(statusBarItem, dataProvider.usageData, activityStats, sessionData);

    // Update tree view with session data and activity stats
    dataProvider.updateSessionData(sessionData, activityStats);
}

/**
 * Create auto-refresh timer
 * @param {number} minutes - Interval in minutes (1-60)
 * @returns {NodeJS.Timer|null}
 */
function createAutoRefreshTimer(minutes) {
    // Validate and clamp to 1-60 minute range
    const clampedMinutes = Math.max(1, Math.min(60, minutes));

    if (clampedMinutes <= 0) return null;

    console.log(`Auto-refresh enabled: checking usage every ${clampedMinutes} minutes`);

    return setInterval(async () => {
        await performFetch();
    }, clampedMinutes * 60 * 1000);
}

/**
 * Set up monitoring for Claude Code token usage via JSONL files
 * Monitors ~/.config/claude/projects/*.jsonl for usage data
 * @param {vscode.ExtensionContext} context
 */
async function setupTokenMonitoring(context) {
    // Register diagnostic channel for disposal if it gets created
    context.subscriptions.push({
        dispose: () => {
            if (tokenDiagnosticChannel) {
                tokenDiagnosticChannel.dispose();
                tokenDiagnosticChannel = null;
            }
        }
    });

    // Get current workspace path for project-specific token tracking
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || null;
    if (workspacePath) {
        debugLog(`📂 Workspace path: ${workspacePath}`);
    } else {
        debugLog('⚠️ No workspace folder open - will use global token search');
    }

    // Initialize the Claude data loader with workspace path and debug logger
    claudeDataLoader = new ClaudeDataLoader(workspacePath, debugLog);

    // Try to find Claude data directory
    const claudeDir = await claudeDataLoader.findClaudeDataDirectory();
    if (!claudeDir) {
        debugLog('⚠️ Claude data directory not found');
        debugLog('Checked locations:');
        claudeDataLoader.claudeConfigPaths.forEach(p => debugLog(`  - ${p}`));
        debugLog('Token monitoring will not be available.');
        return;
    }

    debugLog(`✅ Found Claude data directory: ${claudeDir}`);

    // ONLY watch project-specific directory - never fall back to global
    // This prevents cross-project contamination when multiple VS Code windows are open
    const projectDir = await claudeDataLoader.getProjectDataDirectory();

    if (!projectDir) {
        debugLog(`⚠️ Project directory not found for workspace: ${workspacePath}`);
        debugLog(`   Expected: ${claudeDataLoader.projectDirName}`);
        debugLog('   Token monitoring will only work once Claude Code creates data for this project.');
        debugLog('   Will retry on next refresh cycle.');
        // Still do initial load attempt (will return zeros)
        await updateTokensFromJsonl(false);
        return;
    }

    debugLog(`📂 Watching project-specific directory ONLY: ${projectDir}`);

    // Initial load of usage data
    await updateTokensFromJsonl(false);

    // Set up file watcher for project-specific JSONL directory ONLY
    const fs = require('fs');
    if (fs.existsSync(projectDir)) {
        jsonlWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(projectDir, '*.jsonl')
        );

        // Watch for file changes
        jsonlWatcher.onDidChange(async (uri) => {
            debugLog(`📝 JSONL file changed: ${uri.fsPath}`);
            await updateTokensFromJsonl(false);
        });

        // Watch for new files
        jsonlWatcher.onDidCreate(async (uri) => {
            debugLog(`📝 New JSONL file created: ${uri.fsPath}`);
            await updateTokensFromJsonl(false);
        });

        context.subscriptions.push(jsonlWatcher);
        debugLog('✅ File watcher active for project JSONL changes');
    }

    debugLog('✅ Token monitoring initialized');
    debugLog(`   Watching: ${projectDir}/*.jsonl`);
}

/**
 * Update token usage from JSONL data
 * @param {boolean} silent - If true, don't log updates (used for polling)
 */
async function updateTokensFromJsonl(silent = false) {
    try {
        // Get current session usage (from project-specific or global directory)
        const usage = await claudeDataLoader.getCurrentSessionUsage();

        if (!silent) {
            if (usage.isActive) {
                debugLog(`📊 Active session: ${usage.totalTokens.toLocaleString()} tokens (${usage.messageCount} messages)`);
                debugLog(`   Cache read: ${usage.cacheReadTokens.toLocaleString()}, Cache creation: ${usage.cacheCreationTokens.toLocaleString()}`);
            } else {
                debugLog(`⏸️  No active session detected (no recent JSONL activity)`);
            }
        }

        // Update status bar based on session activity
        if (statusBarItem) {
            if (usage.isActive && usage.totalTokens > 0) {
                // Active session - update with current tokens
                if (sessionTracker) {
                    let currentSession = await sessionTracker.getCurrentSession();
                    if (!currentSession) {
                        currentSession = await sessionTracker.startSession('Claude Code session (auto-created)');
                        debugLog(`✨ Created new session: ${currentSession.sessionId}`);
                    }
                    await sessionTracker.updateTokens(usage.totalTokens, getTokenLimit());
                }

                const sessionData = await sessionTracker.getCurrentSession();
                const activityStats = activityMonitor ? activityMonitor.getStats(dataProvider?.usageData, sessionData) : null;
                updateStatusBar(statusBarItem, dataProvider?.usageData, activityStats, sessionData);

                if (dataProvider) {
                    dataProvider.updateSessionData(sessionData, activityStats);
                }
            } else {
                // No active session - clear token display (pass null for sessionData)
                const activityStats = activityMonitor ? activityMonitor.getStats(dataProvider?.usageData, null) : null;
                updateStatusBar(statusBarItem, dataProvider?.usageData, activityStats, null);

                if (dataProvider) {
                    dataProvider.updateSessionData(null, activityStats);
                }
            }
        }
    } catch (error) {
        debugLog(`❌ Error updating tokens: ${error.message}`);
    }
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    // Enable debug mode if running in Extension Development Host (F5)
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        setDevMode(true);
    }

    // Create status bar item
    statusBarItem = createStatusBarItem(context);

    // Initialize data provider
    dataProvider = new UsageDataProvider();

    // Initialize activity monitor
    activityMonitor = new ActivityMonitor();
    activityMonitor.startMonitoring(context);

    // Initialize session tracker
    sessionTracker = new SessionTracker();

    // Monitor for Claude Code token usage updates via JSONL files
    await setupTokenMonitoring(context);

    // Register tree data provider
    const treeView = vscode.window.createTreeView('claude-usage-view', {
        treeDataProvider: dataProvider
    });
    context.subscriptions.push(treeView);

    // Register disposal for Puppeteer browser - ensures it closes when extension stops
    context.subscriptions.push({
        dispose: () => {
            if (dataProvider && dataProvider.scraper) {
                dataProvider.scraper.close().catch(err => {
                    console.error('Error closing browser on dispose:', err);
                });
            }
        }
    });

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.FETCH_NOW, async () => {
            const { webError } = await performFetch();
            if (webError) {
                vscode.window.showErrorMessage(`Failed to fetch Claude usage: ${webError.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.OPEN_SETTINGS, async () => {
            await vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/settings'));
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.START_SESSION, async () => {
            try {
                // Prompt user for optional session description
                const description = await vscode.window.showInputBox({
                    prompt: 'Enter a description for this Claude Code session (optional)',
                    placeHolder: 'e.g., Implementing user authentication feature',
                    value: 'Claude Code development session'
                });

                // User cancelled the input
                if (description === undefined) {
                    return;
                }

                // Start new session
                const newSession = await sessionTracker.startSession(description);

                // Update status bar to show new session
                await updateStatusBarWithAllData();

                vscode.window.showInformationMessage(
                    `✅ New session started: ${newSession.sessionId}`,
                    { modal: false }
                );
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to start new session: ${error.message}`);
            }
        })
    );

    // Show Debug Output command
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.SHOW_DEBUG, async () => {
            const debugChannel = getDebugChannel();

            // Add diagnostic info
            debugChannel.appendLine(`\n=== DIAGNOSTICS (${new Date().toLocaleString()}) ===`);

            if (dataProvider && dataProvider.scraper) {
                const diag = dataProvider.scraper.getDiagnostics();
                debugChannel.appendLine('Scraper State:');
                debugChannel.appendLine(`  Initialized: ${diag.isInitialized}`);
                debugChannel.appendLine(`  Connected Browser: ${diag.isConnectedBrowser}`);
                debugChannel.appendLine(`  Has Browser: ${diag.hasBrowser}`);
                debugChannel.appendLine(`  Has Page: ${diag.hasPage}`);
                debugChannel.appendLine(`  Has API Endpoint: ${diag.hasApiEndpoint}`);
                debugChannel.appendLine(`  Has API Headers: ${diag.hasApiHeaders}`);
                debugChannel.appendLine(`  Has Credits Endpoint: ${diag.hasCreditsEndpoint}`);
                debugChannel.appendLine(`  Has Overage Endpoint: ${diag.hasOverageEndpoint}`);
                debugChannel.appendLine(`  Captured Endpoints: ${diag.capturedEndpointsCount}`);
                debugChannel.appendLine(`  Session Dir: ${diag.sessionDir}`);
                debugChannel.appendLine(`  Has Existing Session: ${diag.hasExistingSession}`);
            } else {
                debugChannel.appendLine('Scraper not initialized');
            }

            // Show usage data state
            debugChannel.appendLine('');
            debugChannel.appendLine('Usage Data State:');
            if (dataProvider && dataProvider.usageData) {
                debugChannel.appendLine(`  Last Updated: ${dataProvider.usageData.timestamp}`);
                debugChannel.appendLine(`  5hr Usage: ${dataProvider.usageData.usagePercent}%`);
                debugChannel.appendLine(`  Weekly Usage: ${dataProvider.usageData.usagePercentWeek}%`);
                debugChannel.appendLine(`  Has Monthly Credits: ${!!dataProvider.usageData.monthlyCredits}`);
            } else {
                debugChannel.appendLine('  No usage data available');
            }

            debugChannel.appendLine('=== END DIAGNOSTICS ===');
            debugChannel.show(true);
        })
    );

    // Reset Connection command
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.RESET_CONNECTION, async () => {
            try {
                if (dataProvider && dataProvider.scraper) {
                    const result = await dataProvider.scraper.reset();
                    // Reset first fetch flag so it re-authenticates
                    dataProvider.isFirstFetch = true;
                    vscode.window.showInformationMessage(result.message);
                } else {
                    vscode.window.showWarningMessage('Scraper not initialized');
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Reset failed: ${error.message}`);
            }
        })
    );

    // Clear Session command - deletes stored browser session for fresh login
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.CLEAR_SESSION, async () => {
            try {
                if (dataProvider && dataProvider.scraper) {
                    const confirm = await vscode.window.showWarningMessage(
                        'This will delete your saved browser session. You will need to log in to Claude.ai again. Continue?',
                        { modal: true },
                        'Yes, Clear Session'
                    );
                    if (confirm === 'Yes, Clear Session') {
                        const result = await dataProvider.scraper.clearSession();
                        dataProvider.isFirstFetch = true;
                        vscode.window.showInformationMessage(result.message);
                    }
                } else {
                    vscode.window.showWarningMessage('Scraper not initialized');
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Clear session failed: ${error.message}`);
            }
        })
    );

    // Open Browser command - force open browser for login
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.OPEN_BROWSER, async () => {
            try {
                if (dataProvider && dataProvider.scraper) {
                    vscode.window.showInformationMessage('Opening browser for Claude.ai login...');
                    const result = await dataProvider.scraper.forceOpenBrowser();
                    if (result.success) {
                        vscode.window.showInformationMessage(result.message);
                    } else {
                        vscode.window.showErrorMessage(result.message);
                    }
                } else {
                    vscode.window.showWarningMessage('Scraper not initialized');
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to open browser: ${error.message}`);
            }
        })
    );

    // Get configuration
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    // Fetch on startup if configured
    if (config.get('fetchOnStartup', true)) {
        setTimeout(async () => {
            await performFetch();
        }, 2000); // Wait 2 seconds after activation
    }

    // Set up auto-refresh interval for usage checks
    const autoRefreshMinutes = config.get('autoRefreshMinutes', 5);
    autoRefreshTimer = createAutoRefreshTimer(autoRefreshMinutes);

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`${CONFIG_NAMESPACE}.autoRefreshMinutes`)) {
                // Clear existing timer
                if (autoRefreshTimer) {
                    clearInterval(autoRefreshTimer);
                    autoRefreshTimer = null;
                }

                // Restart with new configuration
                const newConfig = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
                const newAutoRefresh = newConfig.get('autoRefreshMinutes', 5);
                autoRefreshTimer = createAutoRefreshTimer(newAutoRefresh);
            }
        })
    );

    // Register disposal of debug channel
    context.subscriptions.push({
        dispose: () => disposeDebugChannel()
    });
}

async function deactivate() {
    // Clean up timer
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }

    // Close scraper browser if open
    if (dataProvider && dataProvider.scraper) {
        try {
            await dataProvider.scraper.close();
        } catch (err) {
            console.error('Error closing scraper:', err);
        }
    }
}

module.exports = {
    activate,
    deactivate
};
