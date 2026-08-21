# Releasing to npm

Release only from a clean, reviewed `main` commit. npm versions are immutable: never attempt to republish an existing version, and never force-push release history.

## 1. Confirm repository and registry state

```bash
git switch main
git pull --ff-only origin main
git status --short
npm whoami
npm view @tranhoangnguyen0310/pi-flow-external dist-tags --json
npm view @tranhoangnguyen0310/pi-flow-external versions --json
```

Choose a version not present in the registry. Prerelease versions such as `1.0.10-external.5` require an explicit npm dist-tag at publish time.

## 2. Bump without tagging

```bash
npm version <new-version> --no-git-tag-version
git diff -- package.json package-lock.json
```

Do not create a Git tag until the package is confirmed in the registry.

## 3. Run the release gate

```bash
npm run check
git diff --check
npm pack --dry-run --json
npm audit --omit=dev --audit-level=high
```

Inspect the dry-run manifest. Confirm the expected version and required files, including `index.ts`, `README.md`, runtime sources, and operational scripts/docs. Runtime vulnerabilities block release; do not use `npm audit fix --force` as an automatic release step.

## 4. Review and merge the version bump

Commit the bump and documentation/code changes on a branch, push it, and open a PR to `main`. Merge only after CI and read-only review have no Critical or Important blockers. Pull the merged commit locally and repeat the clean-tree/version check before publishing.

## 5. Authenticate npm

The coordinator's npm credential is independent from GitHub and backend CLI credentials.

```bash
npm login --auth-type=web
npm whoami
```

Do not paste npm tokens, one-time passwords, or browser authentication URLs into issues, PRs, logs, or agent prompts.

## 6. Publish with an explicit tag

For the package's current prerelease line:

```bash
npm publish --access public --tag latest
```

npm may require publish-time browser/2FA approval even after `npm login`. Open the URL printed by npm and complete approval. If the command exits with `EOTP`, verify that the version is still absent, finish authentication, and rerun the exact publish command. Do not bump again unless the registry actually accepted the version.

## 7. Verify the registry

Registry metadata can take a few seconds to converge:

```bash
npm view @tranhoangnguyen0310/pi-flow-external@<new-version> version
npm view @tranhoangnguyen0310/pi-flow-external dist-tags --json
npm view @tranhoangnguyen0310/pi-flow-external@<new-version> dist --json
```

The explicit version and `latest` dist-tag must both resolve to the release. Compare the reported shasum/integrity with the successful publish notice when available.

## 8. Post-release check

From a temporary Pi agent directory or trusted test project, update/install the package and confirm it loads:

```bash
pi update --extensions
pi list
```

Run a bounded receipt test from [`field-testing.md`](field-testing.md). Keep any resulting evidence private and remove temporary profiles afterward.
