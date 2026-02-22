# Releasing clawup to npm

Checklist for publishing a new version of clawup to the npm registry.

## Pre-release

- [ ] Ensure you are on the `main` branch with a clean working tree
  ```bash
  git checkout main
  git pull origin main
  git status  # should be clean
  ```
- [ ] Decide on the new version number following [semver](https://semver.org/)
  - **patch** (1.0.0 → 1.0.1) — bug fixes, docs
  - **minor** (1.0.0 → 1.1.0) — new features, backward-compatible
  - **major** (1.0.0 → 2.0.0) — breaking changes
- [ ] Bump the version in `package.json`
  ```bash
  npm version patch   # or minor / major
  ```
  This updates `package.json` and creates a git tag automatically.
- [ ] Run the build and verify it succeeds
  ```bash
  npm run build
  ```
- [ ] Verify the `dist/` output contains the expected files
  ```bash
  ls dist/
  ```
- [ ] Smoke-test the CLI locally
  ```bash
  node bin/clawup.js --help
  node bin/clawup.js --check
  ```
- [ ] Review what will be included in the package
  ```bash
  npm pack --dry-run
  ```
  Expected contents (from the `files` field in `package.json`):
  - `bin/` — CLI shim
  - `dist/` — compiled JS, declarations, source maps
  - `LICENSE`
  - `README.md`
  - `package.json` (always included)
- [ ] Verify `package.json` fields are correct
  - `name` — `clawup`
  - `version` — matches intended release
  - `description` — accurate
  - `main` — `./dist/index.js`
  - `types` — `./dist/index.d.ts`
  - `bin` — `./bin/clawup.js`
  - `license` — `MIT`
  - `repository` — points to the GitHub repo
  - `engines` — `node >=18.0.0`
  - `keywords` — relevant search terms

## Publish

- [ ] Log in to npm (if not already authenticated)
  ```bash
  npm login
  npm whoami  # verify you're logged in as the correct user
  ```
- [ ] Publish to the npm registry
  ```bash
  npm publish
  ```
  > On first publish the package name `clawup` must be available. If it is taken, either use a scoped name (`@yourscope/clawup`) or pick a different name.
- [ ] Verify the package is live
  ```bash
  npm info clawup
  ```

## Post-release

- [ ] Push the version commit and tag to GitHub
  ```bash
  git push origin main --follow-tags
  ```
- [ ] Create a GitHub release from the tag
  ```bash
  gh release create v<VERSION> --generate-notes
  ```
- [ ] Verify installation works from the registry
  ```bash
  npx clawup --help
  ```

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm publish` says name is taken | Use a scoped package: rename to `@scope/clawup` in `package.json` |
| `dist/` is empty or stale | Delete `dist/` and re-run `npm run build` |
| `npm pack --dry-run` includes unexpected files | Check the `files` array in `package.json` |
| `prepublishOnly` script fails | Fix the TypeScript build errors before retrying |
| Tag already exists | Delete with `git tag -d v<VERSION>` and re-run `npm version` |
