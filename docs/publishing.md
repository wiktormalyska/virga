# Publishing checklist

For the maintainer. Extension id `WiktorMayska.virga`, repository
`https://github.com/wiktormalyska/virga`. Do the steps in this order: the
README's images are served from the GitHub repository, so it must exist and be
public before the Marketplace shows the page.

## 1. Before every release

- [ ] `npm test` passes (with `VIRGA_TEST_ORG=<alias>` for the org tests).
- [ ] `npm run e2e` passes (Windows, hidden desktop, `VIRGA_TEST_ORG` set).
- [ ] Version bumped in `package.json`, a section for it in `CHANGELOG.md`.
- [ ] `npm run package`, then `npm run e2e:vsix` passes against the `.vsix`.
- [ ] `npx --yes @vscode/vsce@3 ls` lists only the runtime files, snippets,
      grammar, `images/icon.png`, the README screenshots, `LICENSE`,
      `README.md`, `CHANGELOG.md`.
- [ ] Screenshots still match the UI (`npm run screenshots` retakes them).

## 2. GitHub repository (first release only)

- [ ] Create the public repository `wiktormalyska/virga` (no template, no
      README: the local repository has them).
- [ ] First commit (the local repository has none yet, so a push before it
      fails with "src refspec main does not match any"): `git add -A`, then
      `git status --short` lists only sources, docs, tests and images as
      staged (`A`), and `git status --ignored --short` shows `e2e/udd`,
      `e2e/vsc`, `e2e/.cache`, `.dev-cache`, the `*.log` files and the
      `.vsix` as ignored (`!!`), then `git commit -m "Virga 0.1.0"`.
- [ ] `git remote add origin https://github.com/wiktormalyska/virga.git`
- [ ] `git push -u origin main`
- [ ] Check that the CI workflow (`.github/workflows/ci.yml`) is green.
- [ ] Repository settings: description = the tagline from `package.json`,
      topics `apex`, `soql`, `vscode-extension`, `salesforce-cli`.

## 3. Visual Studio Marketplace publisher (first release only)

- [x] Sign in at <https://marketplace.visualstudio.com/manage> with the
      Microsoft account that will own the extension.
- [x] Create the publisher with ID `WiktorMayska` (done 2026-10-15; IDs cannot
      be changed, it must match `publisher` in `package.json`), display name
      `Wiktor Małyska`.

How 0.1.0 was published (2026-10-16): the publisher belongs to a personal
Microsoft account with no Entra ID tenant, so `az login --allow-no-subscriptions`
ends with an empty list (`[]`) and `vsce publish --azure-credential` cannot get
a token. Azure CLI 2.91 also crashes in its tenant picker
(`_subscription_selector.py`, `'NoneType' object has no attribute 'get'`)
unless `az config set core.login_experience_v2=off` is set first. The Azure
DevOps organization showed no way to create a global PAT, and global PATs stop
working on 2026-12-01 anyway. What works without any token: upload the `.vsix`
on the publisher page (**+ New extension → Visual Studio Code** for the first
version, **Update** on the extension for later ones). Verification took a few
minutes, then the item page and `code --install-extension WiktorMayska.virga`
needed another few minutes before they found it.

CLI publishing needs an Entra ID identity that is a member of the publisher
(Owner or Contributor), for example a free Entra ID tenant or an Azure
Pipelines / GitHub Actions workload identity, then `az login` and
`vsce publish --azure-credential`.

## 4. Open VSX namespace (first release only)

- [ ] Sign in at <https://open-vsx.org> with GitHub, link an Eclipse
      Foundation account and accept the Publisher Agreement.
- [ ] Create an access token in the Open VSX user settings.
- [ ] `npx --yes ovsx create-namespace WiktorMayska -p <token>`
- [ ] Optional: ask for the namespace to be verified (owner badge) as the Open
      VSX documentation describes.

## 5. Publish

- [ ] `npx --yes @vscode/vsce@3 package` → `virga-<version>.vsix`
- [ ] Marketplace: upload the `.vsix` on
      <https://marketplace.visualstudio.com/manage/publishers/WiktorMayska>
      (**Update** on the extension), or with an Entra ID identity:
      `npx --yes @vscode/vsce@3 publish --packagePath virga-<version>.vsix --azure-credential`
- [ ] Open VSX: `npx --yes ovsx publish virga-<version>.vsix` with the token in
      the `OVSX_PAT` environment variable (keep it off the command line, where
      it lands in the process list and shell history)
- [ ] Tag the release: `git tag -a v<version> -m "Virga <version>"` and
      `git push origin v<version>` (the first one is `v0.1.0`).
- [ ] GitHub release for the tag with the `.vsix` attached and the
      CHANGELOG section as notes: `gh release create v<version> virga-<version>.vsix --notes-file <notes>`.

## 6. After publishing

- [ ] The Marketplace page shows the icon, the three screenshots and the
      trademark note at the end of the README.
- [ ] Install from the Marketplace in a clean profile
      (`code --profile virga-check --install-extension WiktorMayska.virga`)
      and run a scratch once.
- [ ] Same check on Open VSX (for example in VSCodium).

## Naming and trademarks

- Name, logo and tagline stay free of "Salesforce", "Force" and "Cloud"; the
  logo has no cloud shape and no stylized "f".
- "Salesforce" appears only as a plain reference ("works with Salesforce
  CLI"), and the README ends with the trademark note.
- Do not link virga.dev: that domain belongs to someone else.
