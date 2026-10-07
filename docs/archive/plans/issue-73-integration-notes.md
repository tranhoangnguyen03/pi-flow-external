# Live integration notes

For implementers in this worktree (parent maintained):

- v5 is currently parsed alongside v4 to allow independent regression work. Before completion normal runtime must refuse v4 with explicit convert guidance; legacy catalog loading will be an explicit migration-only option. Do not treat dual runtime support as final.
- src/config-v5.ts defines v5 storage types and validation; src/catalog-v5.ts resolves it. settings.settings.harnessSettings contains all v5 harness entries; settings.settings.harnesses remains a Pi-only HarnessConfig projection for SDK/model registry consumers.
- Canonical v5 profile name/key is `harness/role`; explicit role/harness/configVersion=5 properties are present. Legacy `harness-role` selector searches pair labels and fails on ambiguity. UI should display pair without guessing by hyphen splitting.
- Direct Agent native/parent effort resolution implemented in pi-subagent.ts. Workflow descriptor owner should handle identical semantics; common helper can be extracted by parent after merge.
- Core focused suites currently 63/63 pass. Existing legacy profile tests explicitly seed v4 now (because missing settings defaults to v5).
- Parent owns schema/catalog and documentation other than README. Claude owns lifecycle commands/service/tests and README. Codex owns runtime correctness and related tests; migration assignment follows.
