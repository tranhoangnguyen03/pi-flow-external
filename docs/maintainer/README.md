# Maintainer & Contributor Documentation

This directory contains specifications, runbooks, and active design directions for contributors and maintainers of `pi-flow-external`.

These files are internal development documentation and are excluded from the published npm package.

---

## Product direction

- **[Agent-first Development Principles](agent-first-development.md):** The parent-agent journey, guidance hierarchy, delegation ergonomics and evaluation standards. This is the default design lens for Flow changes.
- **[Delegation North Star](rfcs/delegation-experience-north-star.md):** The complementary human supervision and inspection experience.

---

## Runbooks & Architecture

- **[Detailed Product Contracts](contracts.md):** Per-area invariants (configuration, permissions per backend, receipts, `external_runs`, workflows) moved out of `AGENTS.md`.
- **[Architecture Spec](architecture.md):** Implementation map, settings v5 resolution order, and boundary invariants.
- **[Field Testing](field-testing.md):** Mandatory test execution lanes across all supported backends before release.
- **[Orchestration evaluation](orchestration-evaluation.md):** A few matched live-agent tasks when making claims about orchestration judgment or user outcomes. Product behavior remains covered by the runnable recipe and runtime suites.
- **[Releasing](releasing.md):** Automated release pipeline, PR labels, OIDC trusted publishing, and npm checks.
- **[Tool Schema Compatibility](tool-schema-compatibility.md):** Downstream client schema compatibility notes (#62).

---

## Active RFCs & Design Guidelines

- **[Visual Guidelines](rfcs/delegation-visual-guidelines.md):** Terminal card palette, semantic coloring, and contrast rules.
