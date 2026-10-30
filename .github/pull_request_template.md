## Release

- [ ] If this PR changes anything shipped in the npm package (the `files` list in `package.json`, plus `package.json`/`package-lock.json`): bumped the version with `npm version <type> --no-git-tag-version` and added a `## [X.Y.Z-external.N] - YYYY-MM-DD` section to `CHANGELOG.md`. Versions are `X.Y.Z-external.N` — core bumps reset to `external.0`, same-core publishes increment it. Label the PR `release:patch`, `release:minor`, `release:major`, or `release:prerelease` to match.
- [ ] Otherwise: labelled `release:none`.

CI enforces this. Merging a PR that bumps the version tags it, publishes to npm, and creates the GitHub release automatically. See [`docs/maintainer/releasing.md`](../docs/maintainer/releasing.md).

## Testing

- What distinct failure does this change need to catch? Name its existing test, or explain the new test.
- If coverage overlaps, which check was extended or retired? Preserve separate safety and integration boundaries.
- For affected external providers, state whether a real-provider check was run, not applicable, or blocked; never present a stub as a live result.
