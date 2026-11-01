## Release

- [ ] If this PR changes anything shipped in the npm package (the `files` list in `package.json`, plus `package.json`/`package-lock.json`): bumped the version with `npm version <type> --no-git-tag-version` and added a `## [X.Y.Z-external.N] - YYYY-MM-DD` section to `CHANGELOG.md`. Versions are `X.Y.Z-external.N` — core bumps reset to `external.0`, same-core publishes increment it. Label the PR `release:patch`, `release:minor`, `release:major`, or `release:prerelease` to match.
- [ ] Otherwise: labelled `release:none`.

CI enforces this. Merging a PR that bumps the version tags it, publishes to npm, and creates the GitHub release automatically. See [`docs/maintainer/releasing.md`](../docs/maintainer/releasing.md).

## Testing

- Which existing test owns the changed behavior? If you added a test, what distinct failure does it catch?
- Which tests, fixtures or docs did this change make obsolete, and were they removed?
- For affected external providers: real-provider check run, not applicable, or blocked? Never present a stub as a live result.
