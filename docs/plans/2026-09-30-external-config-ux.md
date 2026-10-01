# External configuration: guided UX design

Status: design proposal finalized with advisor and Claude consultation; not implemented. Supersedes the command-first presentation of issue 73, not its v5 storage and execution contract.

## Objective

A user can configure an agent, choose a default, customize a role and understand a blocked selection without learning harnesses, bindings, gates or JSON. `/external` is the primary entry point. Existing explicit commands remain the secondary automation/diagnostic interface. No schema redesign, dependencies, custom UI framework, automatic provider requests or native CLI configuration writes.

## Decisions

- Show agents directly on the home screen, not behind an Agents menu.
- Use product names: Antigravity, Claude Code, Codex CLI, Grok Build, Muse Code, OpenCode; named registrations display as Pi · label. Technical identities remain unchanged and are available in Details.
- Ordinary vocabulary: agent, role, model, reasoning, instructions, on/off, default, custom settings. Do not make users learn internal terms.
- CLI-native settings are valid, not unconfigured. Unknown readiness is not failure. Never infer a concrete model from native settings.
- Show effective values, with sources behind Details. Show inherited sources inline only when they clarify a choice.
- Bare `/external` and `/external config` open the same hub with UI. Without UI, preserve readable overview and explicit command help. Existing command paths remain supported; no new settings DSL.
- No generic undo/history system. Remove customizations with Same as agent / Use shared instructions. Destructive changes require previews. No automatic backup restoration.
- Use existing select/input/editor/confirm primitives and navigation patterns. No decorative dashboard or framework.

## Home

Illustrative configured state (render actual values, never assume Codex is the default):

```
External agents
Default: Antigravity

Antigravity       Uses Antigravity settings · Default
Codex CLI         gpt-6.1-sol · High
Claude Code       Uses Claude Code settings
Grok Build        Uses Grok Build settings
Muse Code         Uses Muse Code settings
OpenCode          Uses OpenCode settings
Pi · fast         provider/model

Add a Pi agent…
Roles…
Recent runs…
Advanced…
Close
```

Off agents remain visible and say Off. Configuration problems say Needs attention and open their repair path. No automatic installation/authentication probes on open, no writes, no model requests. For fresh installations, include one short action hint: Choose an agent to change its settings or make it your default. A configured default incompatible with the default permission must be identified as blocked, not silently replaced.

## Agent screen

```
External › Codex CLI
Model             gpt-6.1-sol
Reasoning         High

Make default
Role customizations…
Check installation and sign-in…
Turn off
Advanced…
Back
```

Named Pi agents replace the CLI check with Check model and credentials and offer a separate Send a test message… action. Their advanced screen includes skills preset. Agent details show technical ID, origins, current default permission effects and readiness observations. One concise access note must accurately describe the effective default tier; a call can override it. Antigravity explicitly says full access only. Pi curated tools are never described as an OS sandbox.

### Model

CLI choices: Use Codex settings; Enter model ID; current custom ID. Do not invent a model catalog from memory or advertise all configured IDs as valid for every backend. Manual ID validation is structural, not account/model validation. Explain once: Checked by Codex when a run starts; this change does not verify access.

Pi choices: choose provider, then searchable/filterable model if supported by native UI, otherwise a provider-grouped list. Use Pi's current registry and credential metadata; never require a provider network request to populate the picker. Credentials configured does not prove model access. Unknown manual model IDs are not saved through this guided creation path; offer refresh/reopen after configuring the model in Pi. Existing unresolved registrations remain visible and repairable. Raw settings remain the advanced escape hatch.

### Reasoning

Use capability-driven options from the same validator as execution. CLI settings label: Use Codex settings. Parent policy label: Match my Pi session (currently High), only where supported. Fixed levels use ordinary labels. Explain parent policy dynamically follows the session at the next call; a running workflow keeps its snapshot. Pi has Off rather than a native CLI option.

At agent scope, choosing its native default removes the local scalar when equivalent. At role scope native is an explicit policy distinct from inheritance. Never use off to mean reset.

### Save and impact

A selected scalar saves immediately through the existing validated writer; editors save only when submitted. Feedback: Saved. Used by roles without their own setting. Add a compact exception count if relevant. Do not repeat snapshot/retry/storage prose after every change. Details explains changes affect future calls, not active runs.

## Roles and role customization

Roles list shows built-in/custom, off state and customization count. Creating a role asks name, short description and plain instruction body separately; users do not author YAML frontmatter. Serialization stays in the existing instruction-only Markdown format. Existing effective content pre-fills editors. Cancelling creation writes nothing.

Role screen: Edit shared instructions; Customize for an agent; Turn off everywhere; Advanced. Built-ins offer Restore original instructions; custom roles offer Remove role. The role-on-agent screen is reachable from both the agent and role paths and uses identical operations.

```
Reviewer on Codex CLI
Model             Same as Codex (gpt-6.1-sol)
Reasoning         Custom: Medium
Instructions      Shared Reviewer instructions

Change model…
Change reasoning…
Change instructions…
Turn off for Codex only
Advanced…
Back
```

Reasoning choices include Same as Codex (High), Use Codex settings, Match my Pi session where supported, and allowed levels. Same as removes the local exception; Use Codex settings explicitly bypasses an agent pin. Model follows the same inheritance distinction.

Instructions choices: Use shared instructions; Customize for Codex. Customization starts from effective text and is a full replacement, not an addition. Confirm intentional empty content: This sends no role instructions. Returning to shared previews removal of customized content and requires confirmation. Preview truncated text with a route to full details, not a silent truncation.

Advanced role-on-agent options include spending cap and Pi tool restrictions where supported. Explain unenforced caps accurately; budget is not guaranteed enforcement on every backend. Permissions are not role settings.

## Availability and default selection

Every screen has one summary: Available or Off — reason. Multiple blockers show one reason plus N more; opening it shows all relevant scopes. Offer individually named fixes: Turn on Codex; Turn on Reviewer everywhere; Turn on Reviewer for Codex. Each changes only its named gate and redraws. No blanket Enable all action in this version. Legacy exclusions remain independent and ambiguous ownership routes to Advanced rather than being silently cleared.

Turning off a current global/effective project default offers Choose another default first. Choosing an off agent as default offers Turn it on first, then requires a separate default action. Do not rely on disabled-row support in select: choosing an unavailable action explains the reason and provides navigation.

Trusted project default is shown explicitly: This project uses Claude Code; your global default is Antigravity. Changing the global default does not change this project. This feature never writes project files. Offer path/instructions in Details. Unknown/disabled defaults fail clearly without substitution.

## Pi agent creation and readiness

Creation: pick registered model → choose label → review → Create. Default reasoning Off and skills unloaded. Optional Adjust reasoning and Load installed skills appear on review, not mandatory wizard steps. Show account/provider and Pi execution boundary accurately. No files written until Create. Cancellation leaves nothing behind. Existing deterministic and assisted commands remain secondary.

After creation: Done; Check model and credentials (no model request); Send a test message (may incur cost). Test confirmation names provider/model, readonly curated tools, temporary workspace, no settings changes. Confirm every test separately. Queued and running tests honor cancellation, timeout and session shutdown. Failure does not delete registration or imply creation failed. Label setup check and actual model-request results distinctly. CLI check validates installation/login reporting only; no paid CLI test is introduced here.

Check results are transient observations, marked with check time and relevant configuration, invalidated when model settings change. Never persist them as proof of future access.

## Advanced

Global default selection; access defaults; spending cap; concurrency; timeout; run-history retention; setup diagnostics; configuration details; raw settings editor; migration and legacy maintenance. Keep ordinary model/reasoning changes out of this screen.

Restoring agent defaults is advanced and names exactly what changes. Gates are preserved; scoped exceptions are preserved unless the preview explicitly owns them. Pi required model cannot be reset into an invalid registration. Remove is available only for custom Pi agents/roles. Built-in CLI agents are turned off, not deleted.

Remove/restore: plan → human-readable impact → confirm → revalidate → apply. File paths under Details. Preserve receipts, credentials and native CLI configuration. Revalidate defaults and ownership after confirmation. Changed state requires a refreshed preview and new confirmation. Partial removal reports what remains and leaves entity off. No automatic retry of provider work. Legacy exact selectors appear separately in Advanced, inspectable with raw-edit guidance, not masquerading as ordinary roles.

## Migration and recovery

Invalid/old settings replace the normal home with a recovery screen. Never show fallback values as effective configuration and never offer execution using defaults.

Old settings: Update settings format; Show changes; Edit file; Close. Preview explains preserved instructions/pins/exclusions, backup and any conflicts. No automatic consolidation. Pre-v4 steps run as one guided sequence but retain each conversion's separate preview/confirmation. A completed first conversion followed by cancellation remains honestly reported as v4; no rollback fiction.

Malformed settings: Show problem; Edit settings; Show file location; Close. Unsupported future version advises the compatible extension version, never downgrade-overwrites. Existing backup location can be shown, but no automatic Restore backup action. Invalid role files affect their own selections; valid roles remain accessible. Repair uses managed-path checks, not unsafe filesystem enumeration.

## Interaction contract

- Stable ordering, product names, breadcrumbs, explicit Back and Close; Esc goes back one level, root Esc closes.
- Cancelling a pending action writes nothing; it does not undo earlier saved choices. Input cancellation is distinct from intentional empty instruction content.
- Clear text states, not color/icons alone. Wrap or shorten rows and put long model/path values in Details. No reliance on unsupported disabled menu rows or custom mouse interaction.
- Re-read settings/catalog before rendering and mutating. Existing accepted last-writer-wins limitation remains; destructive fingerprints are mandatory.
- Graceful no-UI behavior: readable output and existing explicit commands; no surprise paid requests. Existing caller approval policy still governs scripted creation/deletion/test commands.

## Implementation map and boundaries

Reuse config-lifecycle setters, creation and plan/apply helpers; v5 catalog and execution-config for effective values; origins for source details; existing command editor/conversion/doctor/run browser; Pi model registry. Keep UI capability choices tied to config-v5 validation. Extend existing label maps rather than duplicate product names.

New work: a bounded menu controller and rendering helpers, registry-backed Pi model picker, structured availability reasons shared with text commands, separate no-request Pi setup check versus paid test, validated advanced global-setting controls, plain instruction editing that preserves exact description/body semantics. Do not create a generic screen framework, action DSL, second resolver, persisted readiness cache or undo journal. Exact file split is an implementation decision, not a design requirement.

## Acceptance journeys

1. Fresh /external immediately offers agents; zero probes, writes or requests.
2. Change Codex model/reasoning without typing configuration commands; Reviewer displays the same effective values as Agent/workflow resolution.
3. Customize Reviewer reasoning/instructions for Codex; remove customization via Same as / Use shared. Other agents unchanged; native distinct from inheritance.
4. Create a Pi agent with default Off/minimal in a short flow; cancel writes nothing; optional paid test never runs without confirmation and shuts down safely.
5. Multiple blockers remain explicit; clearing one never clears another. Default changes honor trusted project override.
6. Remove/restore previews correctly name affected state; changed fingerprint, symlink paths and partial failures remain safe.
7. Copied v4 config upgrades through guided preview and preserves behavior; malformed/future config only offers repair, never runnable fallback defaults.
8. Existing command/headless behavior remains available; native CLI config, live credentials and running snapshots are untouched.

Tests: one authoritative check per behavioral boundary, fake native UI/provider for deterministic flows, existing lifecycle coverage reused. No snapshot/prose-fragment suite. Manual acceptance begins with the user's actual task, not a command checklist: Set up Codex, make Reviewer different, and return it to normal. Verify TypeScript/offline suite, package dry-run and audit before handoff. Live provider acceptance remains separately authorized.
