# Delegation visual guidelines

Companion to [the experience north star](delegation-experience-north-star.md). Based on maintainer review of actual Agent and workflow screenshots.

## Principle

Contrast by meaning, not more color. Use the existing Agent intent card as the reference: bold operation, muted field labels, normal foreground values, and one warning-colored access disclosure.

## Visual vocabulary

| Element | Treatment |
| --- | --- |
| Operation/title | Bold |
| Task, Role, Purpose, Workspace, Mode, Source, Run labels | Muted |
| Field values and assignment names | Normal foreground |
| Success/failure/running marker | Existing semantic status color |
| Access disclosure | Warning color, once per operation |
| Receipt caveat or navigation explanation | Muted |
| Inspection command | Accent |
| Usage, cache metrics, evidence paths | Dim; expanded detail rather than primary content |

Do not dim an entire child row: its task and outcome are primary information. Do not use hard-coded colors; respect the active theme.

## Structure

1. Identity and lifecycle state.
2. Purpose and essential execution disclosure.
3. Bounded progress or child list.
4. One inspection route.

A tool call and its result form one visual operation. The call owns identity, workspace, mode, source and access. The result owns lifecycle/progress and supplies resolved purpose only when the call could not show it. Omit speculative preparation prose rather than leaving it above the resolved purpose. Do not invalidate synchronously inside a renderer: host rendering can re-enter and duplicate components.

Direct Agent receipts complement their existing intent card; they should not repeat the assignment description. Background receipts must still explicitly say they are not live monitors.

## Progressive disclosure

- Use a script filename as a provisional title, never a full filesystem path.
- Default source labels use filenames; full paths remain in expanded detail or Launch inspection.
- Keep a short run suffix for correlation; expose the full ID on expansion and in the run navigator.
- Keep essential workspace and access disclosure visible.
- Child task, harness, state and duration matter more than token/cache accounting. Detailed accounting remains available on expansion.
- Preserve all canonical output and evidence; this is presentation, not data removal.

## Review checklist

Check Agent and workflow, foreground and background, inline and path sources, active and completed states. Review at approximately 80 columns as well as a wide terminal. Look for duplicated purpose/workspace/mode/warnings, wrapping paths, stale preparation text, and undifferentiated bright paragraphs.

Behavior and accessibility outrank cosmetic consistency. Color supplements explicit labels and status text; it must not be the only way to understand state. Avoid cosmetic snapshot-test proliferation: retain focused checks for disclosure, deduplication, and detail reachability.
