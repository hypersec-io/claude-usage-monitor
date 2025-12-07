## [2.7.2] - 2025-12-05

### Fixed

- **Chrome crash restore dialog**: Added Chrome flags to suppress "Chrome didn't shut down correctly" restore dialog that was blocking browser automation

## [2.7.1](https://github.com/hypersec-io/claude-usage-monitor/compare/v2.7.0...v2.7.1) (2025-11-30)


### Bug Fixes

* project-specific token tracking to prevent cross-project data contamination ([40f6c52](https://github.com/hypersec-io/claude-usage-monitor/commit/40f6c527c0d0285dcc82beae1bc0f612b33c65ce))

# [2.7.0](https://github.com/hypersec-io/claude-usage-monitor/compare/v2.6.6...v2.7.0) (2025-11-28)

### Features

- major refactor - headless browser, dynamic ports, unified UI ([094be97](https://github.com/hypersec-io/claude-usage-monitor/commit/094be97f7b846316fba110b3e08d9988f55525f8))

## [2.6.6](https://github.com/hypersec-io/claude-usage-monitor/compare/v2.6.5...v2.6.6) (2025-11-27)


### Bug Fixes

* add Clear Session command to fix stuck login state ([ceef7df](https://github.com/hypersec-io/claude-usage-monitor/commit/ceef7df1d48a270d2b506d011639f0557ce2babe))
* auto-open browser for login and poll for magic link auth ([4c2d220](https://github.com/hypersec-io/claude-usage-monitor/commit/4c2d2205d2dfc45fd38a6a5c948c171e5299204b))

## [2.6.5](https://github.com/hypersec-io/claude-usage-monitor/compare/v2.6.4...v2.6.5) (2025-11-26)


### Bug Fixes

* configure semantic-release for fork repository ([58b0178](https://github.com/hypersec-io/claude-usage-monitor/commit/58b017837c02ab9476daacfb945c6b91d0882c1b))
* extend session activity window from 5 minutes to 1 hour ([3fec118](https://github.com/hypersec-io/claude-usage-monitor/commit/3fec11818950364ef6cdadd9d68f142276383ea6))
* reduce status bar flickering and improve UX ([b55c073](https://github.com/hypersec-io/claude-usage-monitor/commit/b55c073e4e9d559125087ffcc36a37573a20aca0))

# Change Log

All notable changes to the "claude-usage-monitor" extension will be documented in this file.

## [2.6.4] - 2025-11-26

### Fixed

- **Token display now always visible**: "Tk" indicator stays in status bar at all times
  - Shows "Tk -" when no token data available (instead of disappearing)
  - Shows "Tk X%" when token data is present
  - Prevents status bar items from flickering in and out

## [2.6.3] - 2025-11-26

### Added

- **`claudeUsage.debug` setting**: Explicit debug mode control
  - Debug logging now only occurs when `claudeUsage.debug: true` OR running in F5 development mode
  - This fixes the issue where debug logs would show in installed extension

### Fixed

- **Debug channel only created when needed**: Output channel "Claude Usage - API Debug" no longer appears for normal users
- **Clean extension installation experience**: No debug channels or logs visible to end users

## [2.6.2] - 2025-11-25

### Added

- **Configurable status bar metrics** - Show/hide individual metrics via new settings:
  - `claudeUsage.showSession` - 5-hour session usage (default: true)
  - `claudeUsage.showWeekly` - 7-day usage (default: true)
  - `claudeUsage.showSonnet` - Weekly Sonnet usage (default: false)
  - `claudeUsage.showOpus` - Weekly Opus usage (default: false)
  - `claudeUsage.showTokens` - Token count (default: true)
  - `claudeUsage.showCredits` - Credits remaining (default: false)

### Changed

- **Improved status bar layout** - Cleaner display with configurable metrics
- **Tree view reorganization** - Better grouping of usage metrics

## [2.6.1] - 2025-11-24

### Added

- **Extra Usage tracking** - Monitor spending cap usage for Max plans
  - Shows current/limit in status bar
  - Tree view displays daily and monthly breakdown

### Fixed

- **API schema improvements** - Better extraction of nested usage data

## [2.6.0] - 2025-11-23

### Added

- **November 2025 subscription changes support**
  - Weekly Sonnet usage tracking
  - Weekly Opus usage tracking (Max plans)
  - Model-specific reset times
- **API schema system** - Cleaner data extraction
- **Improved tree view** - Model usage breakdown

## [2.5.2] - 2025-11-21

### Fixed

- **Status bar updates** - More reliable refresh after fetch
- **Error handling** - Better messages for common failures

## [2.5.1] - 2025-11-20

### Added

- **Quick status bar click** - Click to fetch immediately

### Fixed

- **Timer reliability** - Auto-refresh now works consistently

## [2.5.0] - 2025-11-19

### Added

- **Direct API access** - 2-3x faster data retrieval
- **Intelligent fallback** - Falls back to scraping if API fails
- **Prepaid credits tracking** - Shows remaining credits if applicable

## [2.4.0] - 2025-11-15

### Added

- **Activity bar panel** - Dedicated Claude Usage view
- **Tree view with sparklines** - Visual usage trends
- **Detailed tooltips** - Hover for more info

## [2.3.0] - 2025-11-10

### Added

- **Automatic token tracking** - Monitors Claude Code JSONL files
- **Real-time updates** - File watcher for instant updates
- **Usage history** - Sparkline graphs for trends

## [2.2.0] - 2025-11-05

### Added

- **Session tracking** - Manual token updates via Node.js

## [2.1.0] - 2025-11-01

### Added

- **7-day usage tracking** - Weekly rolling usage display

## [2.0.0] - 2025-10-25

### Changed

- **Headless browser support** - Silent operation after login
- **Session persistence** - Log in once, stay authenticated

## [1.0.0] - 2025-10-15

### Initial Release

- Basic usage scraping from Claude.ai
- Status bar display
- Manual refresh command
