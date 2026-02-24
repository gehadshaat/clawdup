# Releasing clawup to npm

Checklist for publishing a new version of clawup to the npm registry.

## Prerequisites (one-time setup)

- [ ] **Create an npm account** at [https://www.npmjs.com/signup](https://www.npmjs.com/signup)
  - Choose a username, provide an email, and set a password
  - Verify your email address (npm will send a confirmation link)
- [ ] **Enable two-factor authentication (2FA)** — strongly recommended
  - Go to [https://www.npmjs.com/settings/~/tfa](https://www.npmjs.com/settings/~/tfa)
  - Enable 2FA for authorization and publishing (use an authenticator app or security key)
- [ ] **Reserve the package name** on npm
  - Check availability: `npm search clawup` or visit [https://www.npmjs.com/package/clawup](https://www.npmjs.com/package/clawup)
  - If the name `clawup` is taken, you have two options:
    1. **Use a scoped package** — rename to `@yourscope/clawup` in `package.json` (your npm username is a free scope, e.g. `@gehadshaat/clawup`)
    2. **Pick a different unscoped name**
  - To create a scope for an organization, go to [https://www.npmjs.com/org/create](https://www.npmjs.com/org/create) (free for public packages)
- [ ] **Log in from the CLI**
  ```bash
  npm login
  npm whoami  # should print your npm username
  ```
- [ ] **Configure npm publish access** (if using a scoped package)
  - Scoped packages are private by default. To publish publicly:
    ```bash
    npm publish --access public
    ```
  - Or add to `package.json`:
    ```json
    "publishConfig": {
      "access": "public"
    }
    ```

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

- [ ] Verify you are logged in to npm (see Prerequisites if not)
  ```bash
  npm whoami
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
