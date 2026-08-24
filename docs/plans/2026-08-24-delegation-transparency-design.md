# Delegation Transparency Design

**Goal:** Make external delegation explain its intent, authority, live state, and evidence without adding a dashboard or changing backend execution.

## Experience

The interactive TUI is the primary experience. Before execution, direct Agent calls identify the backend, selected profile, task, profile purpose, and the fact that the external CLI is unsandboxed. Workflow calls give the same access warning at the workflow level.

During execution, the existing compact workflow tree remains intact. Running rows continue to show bounded activity, timing, and usage. The workflow header retains explicit done, active, queued, and failed counts. Access is stated once at the workflow level rather than repeated for every child.

After execution, terminal rows call the local run identifier “evidence” instead of the ambiguous “run.” Expanded output shows the record path and structured backend-event count. Recording failures are labeled as incomplete evidence independently of backend success or failure.

## Boundaries

This UI must not label a task read-only: external CLI permission modes are not an enforcement boundary, even when the prompt asks an agent not to edit. “Unsandboxed external CLI” describes actual authority without implying isolation that does not exist.

The implementation reuses existing progress snapshots, `summary.json`, and `events.ndjson` records. It adds no inspector overlay, interaction state, new persistence format, backend protocol, or automatic retry.

## Testing

One focused rendering test covers preflight intent/access, live workflow access and counts, and expanded evidence receipts. Existing contract and workflow tests remain authoritative for execution behavior. Final verification is `npm run check`.
