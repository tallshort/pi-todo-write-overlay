# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.4.1] - 2026-09-12

### Documentation
- Replace the Pi package Gallery preview with a hand-drawn task-state illustration.
## [0.4.0] - 2026-09-12

### Fixed

- Preserved the latest task and agent state when the overlay finishes opening after a `todo_write` update.
- Kept ellipses added when truncating active-task notes contiguous with the final character and inside the dim note style.
- Prevented long overlay titles from overflowing the frame or losing their accent-coloured ellipsis, opening overlays from reappearing after a clear, and multiline notes from exceeding the display-row budget.

### Changed

- Limited full-mode overlays to eight visible task rows by default, preserving the active task and reserving one row for folded completed-task summaries.
- Added the `maxVisibleTasks` setting and `/todo-overlay max-visible <positive integer>` command for overriding the full-mode row limit.
- Added `/todo-overlay title <text>` for changing the persisted overlay title from the TUI; quoted values are parsed and `title ""` clears it.
- Rendered non-empty overlay titles with the active theme accent colour.
- Rendered the active task's notes as a dim, indented full-mode row when the display-row budget permits.
- Published the contributor, roadmap, and agent-workflow documents linked from the README.

### Documentation
- Added contributor, agent workflow, and roadmap documentation.
- Added a GitHub Actions CI workflow for tests and type checking.
## [0.3.7] - 2026-09-09

### Added

- Added `/todo-overlay hide-once` to hide the overlay until the next `todo_write` change.

## [0.3.6] - 2026-09-08

### Changed

- Refined the package description and normalized the repository URL.

## [0.3.5] - 2026-09-08

### Documentation

- Added the full-mode screenshot as the Pi package gallery preview.

## [0.3.4] - 2026-09-08

### Documentation

- Replaced legacy Korean screenshots with English full and compact overlay examples.

## [0.3.3] - 2026-09-08

### Added

- Forked the persistent `todo_write` overlay extension under the `@tallshort` package.
- Added persistent full and compact display modes, configurable titles, and zero-margin top-right placement.

### Fixed

- Persist the default overlay title.
- Store overlay settings in Pi's agent configuration directory.

### Changed

- Render the overlay title with dim styling.
