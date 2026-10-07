# Maintainer & Contributor Documentation

This directory contains specifications, runbooks, and active design directions for contributors and maintainers of `pi-flow-external`.

These files are internal development documentation and are excluded from the published npm package.

---

## Runbooks & Architecture

- **[Architecture Spec](architecture.md):** Implementation map, settings v5 resolution order, and boundary invariants.
- **[Field Testing](field-testing.md):** Mandatory test execution lanes across all supported backends before release.
- **[Releasing](releasing.md):** Automated release pipeline, PR labels, OIDC trusted publishing, and npm checks.
- **[Tool Schema Compatibility](tool-schema-compatibility.md):** Downstream client schema compatibility notes (#62).

---

## Active RFCs & Design Guidelines

- **[Delegation North Star](rfcs/delegation-experience-north-star.md):** Product vision for supervisor UX and assignment tracking.
- **[Visual Guidelines](rfcs/delegation-visual-guidelines.md):** Terminal card palette, semantic coloring, and contrast rules.
