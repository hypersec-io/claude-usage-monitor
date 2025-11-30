const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { getTokenLimit, TIMEOUTS } = require('./utils');

/**
 * Loads and parses Claude Code's JSONL usage data files
 * Based on approach from other Claude monitoring extensions
 */
class ClaudeDataLoader {
    constructor(workspacePath = null, debugLogger = null) {
        this.claudeConfigPaths = this.getClaudeConfigPaths();
        this.workspacePath = workspacePath;
        this.projectDirName = workspacePath ? this.convertPathToClaudeDir(workspacePath) : null;
        // Use provided logger or fall back to console.log
        this.log = debugLogger || console.log.bind(console);
        this.log(`📂 ClaudeDataLoader initialized with workspace: ${workspacePath || '(none)'}`);
        if (this.projectDirName) {
            this.log(`   Looking for project dir: ${this.projectDirName}`);
        }
    }

    /**
     * Convert a workspace path to Claude's project directory name format
     * e.g., "/projects/claude-usage-monitor" -> "-projects-claude-usage-monitor"
     * @param {string} workspacePath - The workspace folder path
     * @returns {string} Claude's directory name format
     */
    convertPathToClaudeDir(workspacePath) {
        // Claude replaces forward slashes with dashes
        return workspacePath.replace(/\//g, '-');
    }

    /**
     * Set the workspace path for project-specific token tracking
     * @param {string} workspacePath - The workspace folder path
     */
    setWorkspacePath(workspacePath) {
        this.workspacePath = workspacePath;
        this.projectDirName = workspacePath ? this.convertPathToClaudeDir(workspacePath) : null;
        this.log(`📂 ClaudeDataLoader workspace set to: ${workspacePath}`);
        this.log(`   Project dir name: ${this.projectDirName}`);
    }

    /**
     * Get the project-specific data directory for this workspace
     * @returns {Promise<string|null>} Path to project's JSONL directory or null
     */
    async getProjectDataDirectory() {
        if (!this.projectDirName) {
            this.log('⚠️ No workspace path set, falling back to global search');
            return null;
        }

        const baseDir = await this.findClaudeDataDirectory();
        if (!baseDir) {
            return null;
        }

        const projectDir = path.join(baseDir, this.projectDirName);
        try {
            const stat = await fs.stat(projectDir);
            if (stat.isDirectory()) {
                this.log(`📂 Found project-specific directory: ${projectDir}`);
                return projectDir;
            }
        } catch (error) {
            this.log(`⚠️ Project directory not found: ${projectDir}`);
        }

        return null;
    }

    /**
     * Get possible Claude config directory paths
     * @returns {string[]} Array of paths to check
     */
    getClaudeConfigPaths() {
        const paths = [];
        const homeDir = os.homedir();

        // Check environment variable first
        const envPath = process.env.CLAUDE_CONFIG_DIR;
        if (envPath) {
            // Support comma-separated paths
            paths.push(...envPath.split(',').map(p => p.trim()));
        }

        // Standard XDG config location
        paths.push(path.join(homeDir, '.config', 'claude', 'projects'));

        // Legacy location
        paths.push(path.join(homeDir, '.claude', 'projects'));

        return paths;
    }

    /**
     * Find the first valid Claude data directory
     * @returns {Promise<string|null>} Path to Claude projects directory or null
     */
    async findClaudeDataDirectory() {
        for (const dirPath of this.claudeConfigPaths) {
            try {
                const stat = await fs.stat(dirPath);
                if (stat.isDirectory()) {
                    this.log(`Found Claude data directory: ${dirPath}`);
                    return dirPath;
                }
            } catch (error) {
                // Directory doesn't exist, try next
                continue;
            }
        }
        console.warn('Could not find Claude data directory in any standard location');
        return null;
    }

    /**
     * Recursively find all JSONL files in a directory
     * @param {string} dirPath - Directory to search
     * @returns {Promise<string[]>} Array of JSONL file paths
     */
    async findJsonlFiles(dirPath) {
        const jsonlFiles = [];

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    // Recurse into subdirectories
                    const subFiles = await this.findJsonlFiles(fullPath);
                    jsonlFiles.push(...subFiles);
                } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                    jsonlFiles.push(fullPath);
                }
            }
        } catch (error) {
            console.error(`Error reading directory ${dirPath}:`, error.message);
        }

        return jsonlFiles;
    }

    /**
     * Parse a single JSONL file and extract usage records
     * @param {string} filePath - Path to JSONL file
     * @returns {Promise<object[]>} Array of parsed usage records
     */
    async parseJsonlFile(filePath) {
        const records = [];

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());

            for (const line of lines) {
                try {
                    const record = JSON.parse(line);

                    // Validate record structure
                    if (this.isValidUsageRecord(record)) {
                        records.push(record);
                    }
                } catch (parseError) {
                    // Skip malformed JSON lines
                    console.warn(`Failed to parse line in ${filePath}:`, parseError.message);
                }
            }
        } catch (error) {
            console.error(`Error reading JSONL file ${filePath}:`, error.message);
        }

        return records;
    }

    /**
     * Validate if a record has the expected usage data structure
     * @param {object} record - Record to validate
     * @returns {boolean} True if valid
     */
    isValidUsageRecord(record) {
        return record &&
            record.message &&
            record.message.usage &&
            typeof record.message.usage.input_tokens === 'number' &&
            typeof record.message.usage.output_tokens === 'number' &&
            record.message.model !== '<synthetic>' && // Exclude synthetic messages
            !record.isApiErrorMessage; // Exclude error messages
    }

    /**
     * Generate a unique hash for deduplication
     * @param {object} record - Usage record
     * @returns {string} Unique hash
     */
    getRecordHash(record) {
        const messageId = record.message?.id || '';
        const requestId = record.requestId || '';
        return `${messageId}-${requestId}`;
    }

    /**
     * Calculate total tokens from usage object
     * @param {object} usage - Usage object from record
     * @returns {number} Total token count
     */
    calculateTotalTokens(usage) {
        return (usage.input_tokens || 0) +
               (usage.output_tokens || 0) +
               (usage.cache_creation_input_tokens || 0) +
               (usage.cache_read_input_tokens || 0);
    }

    /**
     * Load all usage records from Claude data directory
     * @param {number} sinceTimestamp - Optional timestamp to filter records (ms since epoch)
     * @returns {Promise<object>} Aggregated usage data
     */
    async loadUsageRecords(sinceTimestamp = null) {
        const dataDir = await this.findClaudeDataDirectory();
        if (!dataDir) {
            return {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                messageCount: 0,
                records: []
            };
        }

        const jsonlFiles = await this.findJsonlFiles(dataDir);
        this.log(`Found ${jsonlFiles.length} JSONL files in ${dataDir}`);

        const allRecords = [];
        for (const filePath of jsonlFiles) {
            const records = await this.parseJsonlFile(filePath);
            allRecords.push(...records);
        }

        // Filter by timestamp if provided
        let filteredRecords = allRecords;
        if (sinceTimestamp) {
            filteredRecords = allRecords.filter(record => {
                const recordTime = new Date(record.timestamp).getTime();
                return recordTime >= sinceTimestamp;
            });
        }

        // Deduplicate records
        const uniqueRecords = [];
        const seenHashes = new Set();
        for (const record of filteredRecords) {
            const hash = this.getRecordHash(record);
            if (!seenHashes.has(hash)) {
                seenHashes.add(hash);
                uniqueRecords.push(record);
            }
        }

        // Aggregate token counts
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalCacheReadTokens = 0;

        for (const record of uniqueRecords) {
            const usage = record.message.usage;
            totalInputTokens += usage.input_tokens || 0;
            totalOutputTokens += usage.output_tokens || 0;
            totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
            totalCacheReadTokens += usage.cache_read_input_tokens || 0;
        }

        const totalTokens = totalInputTokens + totalOutputTokens +
                           totalCacheCreationTokens + totalCacheReadTokens;

        return {
            totalTokens,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheCreationTokens: totalCacheCreationTokens,
            cacheReadTokens: totalCacheReadTokens,
            messageCount: uniqueRecords.length,
            records: uniqueRecords
        };
    }

    /**
     * Get current session usage from recently modified JSONL files
     * Strategy: Find the most recently modified JSONL file and extract
     * cache_creation + cache_read from the last assistant message.
     * This represents the total prompt cache size = current session context.
     *
     * If a workspace path is set, ONLY looks in that project's directory.
     * Does NOT fall back to global search to avoid showing wrong project's data.
     * @returns {Promise<object>} Current session usage data
     */
    async getCurrentSessionUsage() {
        this.log('🔍 getCurrentSessionUsage() - extracting cache size from most recent message');
        this.log(`   this.projectDirName = ${this.projectDirName}`);
        this.log(`   this.workspacePath = ${this.workspacePath}`);

        // Use session duration window - session stays "active" as long as file was touched recently
        // This prevents the Tk display from flickering to "-" during pauses in conversation
        const sessionStart = Date.now() - TIMEOUTS.SESSION_DURATION;

        // If workspace is set, ONLY use project-specific directory (no fallback)
        // This prevents showing tokens from other projects
        let dataDir = null;
        let isProjectSpecific = false;

        if (this.projectDirName) {
            // Workspace is set - only look in project directory
            dataDir = await this.getProjectDataDirectory();
            isProjectSpecific = !!dataDir;
            this.log(`   Project-specific dataDir = ${dataDir}`);

            if (!dataDir) {
                // Project directory doesn't exist yet - don't fall back to global
                // This prevents showing data from other projects
                this.log(`⚠️ Project directory not found for: ${this.projectDirName}`);
                this.log('   Not falling back to global search to avoid cross-project data');
                return {
                    totalTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                    messageCount: 0,
                    isActive: false
                };
            }
        } else {
            // No workspace set - use global search (single window scenario)
            this.log('   No projectDirName set, using global search');
            dataDir = await this.findClaudeDataDirectory();
        }

        if (!dataDir) {
            this.log('❌ Claude data directory not found');
            return {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                messageCount: 0,
                isActive: false
            };
        }

        try {
            // Find JSONL files (project-specific if workspace is set)
            const allJsonlFiles = await this.findJsonlFiles(dataDir);
            this.log(`📁 Found ${allJsonlFiles.length} JSONL files in ${isProjectSpecific ? 'project' : 'global'} directory`);

            // Filter to main session files only (UUID format), excluding agent-* files
            // Agent files are subprocesses with their own smaller token contexts
            // Main session files have the full conversation context we want to track
            const mainSessionFiles = allJsonlFiles.filter(filePath => {
                const filename = path.basename(filePath);
                // Exclude agent files (agent-*.jsonl)
                if (filename.startsWith('agent-')) {
                    return false;
                }
                // Include UUID-formatted files (main sessions)
                // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.jsonl
                const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
                return uuidPattern.test(filename);
            });

            this.log(`📁 Filtered to ${mainSessionFiles.length} main session files (excluding agent files)`);

            // Filter to files modified in last hour (active conversation)
            const recentFiles = [];
            for (const filePath of mainSessionFiles) {
                try {
                    const stats = await fs.stat(filePath);
                    if (stats.mtimeMs >= sessionStart) {
                        recentFiles.push({
                            path: filePath,
                            modified: stats.mtimeMs
                        });
                    }
                } catch (statError) {
                    continue;
                }
            }

            // Sort by modification time (most recent first)
            recentFiles.sort((a, b) => b.modified - a.modified);

            this.log(`⏱️  Found ${recentFiles.length} main session file(s) modified in last hour`);

            if (recentFiles.length === 0) {
                this.log('⚠️  No recently modified files - conversation may be inactive');
                return {
                    totalTokens: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                    messageCount: 0,
                    isActive: false
                };
            }

            // Read the most recently modified file
            const mostRecentFile = recentFiles[0].path;
            this.log(`📄 Reading: ${path.basename(mostRecentFile)}`);

            const content = await fs.readFile(mostRecentFile, 'utf-8');
            const lines = content.trim().split('\n');
            this.log(`📊 File has ${lines.length} lines`);

            // Parse from END to START to find the last assistant message with usage data
            let sessionTokens = 0;
            let cacheCreation = 0;
            let cacheRead = 0;
            let messageCount = 0;

            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Look for assistant messages with cache data
                    if (entry.type === 'assistant' && entry.message?.usage) {
                        const usage = entry.message.usage;
                        const entryCache = (usage.cache_creation_input_tokens || 0) +
                                          (usage.cache_read_input_tokens || 0);

                        if (entryCache > 0) {
                            // Found the most recent message with cache data
                            // Use only cache_read as the session total (more accurate approximation)
                            cacheCreation = usage.cache_creation_input_tokens || 0;
                            cacheRead = usage.cache_read_input_tokens || 0;
                            sessionTokens = cacheRead; // Changed from: cacheCreation + cacheRead
                            messageCount = lines.length;

                            this.log(`✅ Found session usage from last assistant message:`);
                            this.log(`   Cache creation: ${cacheCreation.toLocaleString()}`);
                            this.log(`   Cache read: ${cacheRead.toLocaleString()}`);
                            this.log(`   Session total (using cache_read only): ${sessionTokens.toLocaleString()} tokens`);
                            this.log(`   Percentage: ${((sessionTokens / getTokenLimit()) * 100).toFixed(2)}%`);

                            break;
                        }
                    }
                } catch (parseError) {
                    // Skip malformed lines
                    continue;
                }
            }

            return {
                totalTokens: sessionTokens,
                inputTokens: 0,  // Not tracking per-message input for session total
                outputTokens: 0, // Not tracking per-message output for session total
                cacheCreationTokens: cacheCreation,
                cacheReadTokens: cacheRead,
                messageCount: messageCount,
                isActive: sessionTokens > 0
            };

        } catch (error) {
            console.error(`❌ Error getting current session usage: ${error.message}`);
            return {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                messageCount: 0,
                isActive: false
            };
        }
    }

    /**
     * Get today's usage
     * @returns {Promise<object>} Today's usage data
     */
    async getTodayUsage() {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        return await this.loadUsageRecords(startOfDay.getTime());
    }
}

module.exports = { ClaudeDataLoader };
