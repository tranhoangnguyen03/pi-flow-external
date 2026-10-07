# Agent Tasking Transparency Design

**Goal:** Make long-running and parallel agent work show what is happening now, what has finished, and what remains without adding interactive UI state or backend protocol complexity.

## Rendering

The existing progress snapshots remain the source of truth. Rich mode (up to four running agents) retains and renders the four latest activity events. Compact mode shows the latest activity inline for running agents and the first non-empty result line for completed agents. Both previews use the existing bounded display formatting so tool output cannot flood the terminal.

Workflow and phase headers show explicit `done`, `active`, `queued`, and `failed` counts against the total. Hidden-row footers include the number of hidden failures. Existing failure-first row selection remains unchanged.

Timeouts remain aborted terminal runs internally, but timeout rewriting sets an explicit `timedOut` flag on tool details and progress snapshots. The renderer uses a distinct timeout marker and label while retaining the existing aborted marker for user cancellation.

## Data Flow

Backends continue updating `SubagentProgressNode`. Workflow snapshots copy the optional timeout flag with the other progress fields. Shared rendering helpers format counts, activity, results, and terminal states for both direct `Agent` calls and workflow agents.

No waiting or blocked state is added: external backends run non-interactively and expose no reliable approval-wait event. No expandable history is added because the current renderer has no interaction contract.

## Testing

Tests will be written first for four-event retention, compact activity and result previews, timeout distinction, aggregate workflow/phase counts, and hidden failure reporting. Existing rendering and timeout tests will be updated only where the intentional output changes. Final verification is `npm run check`.
