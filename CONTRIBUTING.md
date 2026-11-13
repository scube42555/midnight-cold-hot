# Contributing and version control

This project moves money between an offline machine that holds a seed and an online one that does not. Version control
here is mostly about three things: **never committing a secret**, **knowing exactly what you copied to the cold
machine**, and **saying honestly how far a change has been tested**.

## After cloning

```bash
git config core.hooksPath .githooks      # turn on the pre-commit guard
git config commit.template .gitmessage   # message template with the trailers below
nvm use                                  # Node 22 (.nvmrc); the cold bundle uses an exact 22.x tarball
npm ci                                   # exact versions from package-lock.json
```

Strongly recommended, because the cold bundle is built from this repository: sign commits and tags.

```bash
git config gpg.format ssh                        # or leave the default for GPG
git config user.signingkey ~/.ssh/id_ed25519.pub # your signing key
git config commit.gpgsign true
git config tag.gpgsign true
```

## What is never committed

The pre-commit hook (`.githooks/pre-commit`) blocks these, and `.gitignore` keeps them out of `git status`:

- Recovery phrases, seeds, passphrases, secret keys and Blockfrost tokens, in any file.
- `.env` and `.env.*` (except `.env.example`), `wallet-state-*.json`, `*.snapshot.json`, `tx.hex`, `cold-public.json`.
- QR transfer files (`*.mqr`, `received-*`, `*-qr.html`) and cold bundle material (`cold-bundle*`, `*.tar.gz`, `pylibs/`, `wheels/`).

The hook is a safety net, not a scanner you can rely on. It reports the file and line and never the value. A harmless false
positive (for example a public test phrase) takes `allow-secret` on that line. **If a real secret is ever committed**,
treat it as exposed from that moment: revoke the token, or move the funds to a new wallet. Then remove it from history with
`git filter-repo`. Deleting it in a later commit does not help once it has been pushed.

Addresses, snapshots and transaction files reveal balances and history. Keep the repository **private**, and use throwaway
addresses in documentation and tests.

## Branches

- `main` always builds (`npm run build`) and typechecks (`npx tsc --noEmit`). Do not commit to it directly.
- Work on short branches named `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `build/<topic>`.
- Merge by pull request, squashed, even if you are the only author. Read the diff once before merging.
- Rebase on `main` before merging. Do not force-push a branch someone else uses.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, imperative, 72 characters or fewer.

| Type | Use for |
|---|---|
| `feat` | New behaviour |
| `fix` | A bug fix |
| `security` | A change that closes or narrows a risk (use this one even for small ones, so they are easy to find) |
| `docs` | README, CONTRIBUTING, CLAUDE.md |
| `test` | Tests only |
| `refactor` | No behaviour change |
| `build` | Build, dependencies, the lockfile |
| `chore` | Everything else |

Scopes: `cold`, `coldpage`, `hot`, `sponsor`, `qr`, `scanner`, `config`, `keys`, `snapshot`, `readme`, `deps`, `bundle`.

The body says **why**, and what could go wrong. Two trailers go at the bottom of every commit:

- `Verified:` how far the change has been checked: `not run`, `tsc only`, `unit tests`, or `preprod T3-T5` (test numbers from
  README section 4). Say `preprod` only if someone ran it on a real network.
- `Touches-cold: yes|no`: whether it changes anything that runs on the cold machine (next section).

```text
security(cold): refuse a snapshot made for another network

cold-transfer used to warn only that the snapshot did not mention the wallet's
address. It now reads networkId first and stops, naming both networks, before
any key is derived. A wrong-network snapshot could otherwise reach the signing
step.

Verified: unit tests (36 checks, real snapshot); not run on preprod
Touches-cold: yes
```

## Changes that need extra care: the cold side

These run on the machine that holds the seed. A change to any of them gets a second look, a fresh cold bundle, and
`Touches-cold: yes`:

- `src/` files: `cold-export-public`, `cold-transfer`, `keygen`, `qr-send`, `qr-decode`, and everything they import:
  `config`, `keys`, `hex`, `mqr`, `mqr-core`, `qr-render`, `redact`, `snapshot`.
- The cold page (`dist/cold-page.html`): `src/coldpage/`, `cold-page/cold-page.template.html`, `scripts/build-cold-page.mjs`, the
  modules it bundles (`mqr-core`, `snapshot`, `txinfo`, `timefmt`, `hex`), and **every package the build prints as inlined**, including
  the devDependencies `fflate`, `@noble/hashes`, `@scure/base` and `jsqr`: inside the page they run next to the recovery phrase.
  `esbuild` writes the page, so an `esbuild` change is a cold-side change too.
- `tools/qr_scan.py`.
- The **production dependency set** (`dependencies` in `package.json` and its lockfile entries), because every package in
  `node_modules` can read the seed.
- `src/` files that only run on the hot machine (`hot-watch`, `sponsor-*`, `wallet`, `crosscheck`, `beep`)
  are not in that list. Anything they add must not leak into the cold imports.

## Dependencies

- Pin exact versions. No `^` or `~`.
- Change dependencies in their own commit (`build(deps): ...`) together with the lockfile, and read the lockfile diff.
- Before and after: `npm ls --omit=dev --all` and `find node_modules \( -name '*.node' -o -name '*.so' \)`. A new package or a
  new native add-on on the production side is a cold-side change.

## Tags and the cold bundle

Do not commit bundles. Instead, when you build a bundle you will actually copy to the cold machine (README section 5), tag the
commit it came from and record the facts in the tag message:

```bash
git tag -s bundle/2026-11-09 -m "Cold bundle
commit:  $(git rev-parse HEAD)
node:    v22.23.4 (node-v22.23.4-linux-x64.tar.gz)
python:  3.11, pylibs from opencv-python-headless 4.13.x, numpy 2.x
sha256:  <output of sha256sum cold-bundle.tar.gz>"
```

The sha256 is also what you write on paper before the stick leaves the building. Two builds of the same commit can produce
different archive hashes (file times), so record the hash of the archive you actually copied. On the build machine, check
`git verify-tag bundle/2026-11-09` and `git status` (clean, nothing untracked that matters) before building.

## Tests and the README

Update `README.md` in the same commit as the behaviour change: the test table (section 4), "Verified and still unverified"
(section 6), and any new environment variable. A test is **verified** only if it was run on a real network; code that
passed tests against fake data is "not yet run". Unit tests go in `tests/` and stay free of the SDK (`npm test`). Tests that
need the SDK go in `tests-sdk/` (`npm run test:sdk`); `npm run test:page` drives the built cold page in headless Chromium.
