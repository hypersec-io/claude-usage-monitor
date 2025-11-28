/** @format */

/**
 * Calculates activity level based on Claude.ai usage and session token usage
 * to show how much "Claude time" remains
 */
class ActivityMonitor {
    constructor() {
        // No state needed - we calculate on-demand from usage data
    }

    /**
     * Start monitoring - kept for backwards compatibility but does nothing now
     * @param {vscode.ExtensionContext} context
     */
    startMonitoring(context) {
        // No longer needed - we calculate from usage data instead
    }

    /**
     * Get current activity level based on Claude usage
     * @param {Object} usageData - Claude.ai usage data
     * @param {Object} sessionData - Session token data
     * @returns {'heavy'|'moderate'|'light'|'idle'}
     */
    getActivityLevel(usageData = null, sessionData = null) {
        // Calculate percentages
        const claudePercent = usageData ? usageData.usagePercent : 0;

        let tokenPercent = 0;
        if (sessionData && sessionData.tokenUsage) {
            tokenPercent = Math.round((sessionData.tokenUsage.current / sessionData.tokenUsage.limit) * 100);
        }

        // Use the HIGHER of the two percentages (most urgent)
        const maxPercent = Math.max(claudePercent, tokenPercent);

        // Determine activity level based on max usage
        // Thresholds raised for Claude Code heavy usage patterns
        if (maxPercent >= 90) {
            return 'heavy';      // 90-100% - Critical, running out!
        } else if (maxPercent >= 75) {
            return 'moderate';   // 75-89% - Getting low
        } else {
            return 'idle';       // 0-74% - Normal usage
        }
    }

    /**
     * Get activity statistics for display
     * @param {Object} usageData - Claude.ai usage data
     * @param {Object} sessionData - Session token data
     * @returns {object}
     */
    getStats(usageData = null, sessionData = null) {
        const claudePercent = usageData ? usageData.usagePercent : 0;

        let tokenPercent = 0;
        if (sessionData && sessionData.tokenUsage) {
            tokenPercent = Math.round((sessionData.tokenUsage.current / sessionData.tokenUsage.limit) * 100);
        }

        const maxPercent = Math.max(claudePercent, tokenPercent);
        const level = this.getActivityLevel(usageData, sessionData);

        return {
            level: level,
            claudePercent: claudePercent,
            tokenPercent: tokenPercent,
            maxPercent: maxPercent,
            description: this.getActivityDescription(level, claudePercent, tokenPercent)
        };
    }

    /**
     * Pick a random message from an array
     * @param {string[]} messages - Array of possible messages
     * @returns {string}
     */
    pickRandom(messages) {
        return messages[Math.floor(Math.random() * messages.length)];
    }

    /**
     * Get human-readable description of activity level
     * Includes fun pop culture references from 80s, movies, games, etc.
     * @param {string} level
     * @param {number} claudePercent
     * @param {number} tokenPercent
     * @returns {object} { short, quirky }
     */
    getActivityDescription(level, claudePercent, tokenPercent) {
        const descriptions = {
            'heavy': {
                short: 'Running low!',
                quirkyOptions: [
                    'Claude needs a coffee break soon ☕',
                    "I'm sorry Dave, I'm afraid I can't do much more 🔴",
                    'GAME OVER, man! GAME OVER! 👾',
                    "We're gonna need a bigger boatload of tokens 🦈",
                    'Roads? Where we\'re going we need... more tokens ⚡',
                    'This is heavy, Doc! 🚗',
                    "I'll be back... after the reset 🤖",
                    'Danger Will Robinson! Token levels critical! 🚨',
                    'Houston, we have a problem 🚀',
                    'My capacitor is almost out of flux ⚡',
                    'Luke, I am your... context limit 🌑',
                    'Hasta la vista, tokens 💀',
                    'Winter is coming... for your context ❄️',
                    'You shall not pass... (90%) 🧙',
                    'I\'ve got a bad feeling about this, Chewie 😰',
                    'You call that a token limit? THIS is a token limit 🔪',
                    'Crikey! Token levels are getting dangerous! 🐊'
                ]
            },
            'moderate': {
                short: 'Getting low',
                quirkyOptions: [
                    'Pace yourself, human 🐢',
                    'These aren\'t the tokens you\'re looking for... yet 👋',
                    'Life moves pretty fast. Token consumption too 🎸',
                    'May the tokens be with you 🌟',
                    'The tokens are strong with this one... but struggling 🌟',
                    'One does not simply ignore token warnings 💍',
                    'Wax on, tokens off 🥋',
                    'Strange things are afoot at the Claude-K 🎸',
                    'Be excellent to your token budget 🎸',
                    'Party on, but watch those tokens 🤘',
                    'Inconceivable! We\'re at 75% already! 🗡️',
                    'With great prompts comes great token usage 🕷️'
                ]
            },
            'idle': {
                short: 'Normal usage',
                quirkyOptions: [
                    'Plenty of Claude time remaining 🚀',
                    'All systems nominal, Captain 🖖',
                    'Stay awhile and code 📜',
                    'The Force is strong with your quota 🌟',
                    'Groovy! Tokens looking good 😎',
                    'Excellent! *air guitar* 🎸',
                    'Righteous! Totally tubular token levels 🏄',
                    'Cowabunga, dude! 🐢',
                    'I love it when a plan comes together 🚐',
                    'Token levels: Bodacious! 🤙',
                    'Radical! Claude is ready to rock 🎸',
                    'You\'ve got the power! 💪',
                    'Autobots, roll out! 🚗',
                    'It\'s-a me, Claude-io! 🍄',
                    'Achievement unlocked: Good token hygiene 🎮',
                    'To infinity and beyond! 🚀',
                    'Here\'s looking at you, coder 🎩',
                    'You\'re gonna need a... wait, no, you\'re fine 👍',
                    'Fasten your seatbelts, plenty of tokens ahead ✈️'
                ]
            }
        };

        const levelDescriptions = descriptions[level] || descriptions['idle'];

        return {
            short: levelDescriptions.short,
            quirky: this.pickRandom(levelDescriptions.quirkyOptions)
        };
    }
}

module.exports = { ActivityMonitor };
