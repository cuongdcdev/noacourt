# Self-hosted wallet executors

Loaded by `@hot-labs/near-connect` (fetched by the page, cached in IndexedDB under
`${wallet.id}:${manifest.version}`, run in a sandboxed iframe). Copied unchanged from the Noa Market
frontend (`apps/frontend/public/wallets/`); minified third-party bundles, do not hand-edit. Bump the
wallet `version` in `src/sign/page/manifest.ts` whenever a file changes.

| file | upstream repo | upstream path | commit | sha256 |
| --- | --- | --- | --- | --- |
| meteor.js | Meteor-Wallet/meteor_wallet_sdk (branch data-storage) | storage/meteor-near-connect-latest.js | bb496461cabf598f8aaa58e85bb338a1aa328cf6; fetched 2026-10-16 | 44055723d39a5af581928fd10aa9a4d2d6c1e8931908130b3eb42de9ad496234 |
| hotwallet.js | hot-dao/near-selector | repository/hotwallet.js | d056e179b9695c70f04173281533b03059a94f88 | f17d85c075c735e444a2f77cb6845394b02f8cf7ee5c28ba44baf41d8f183c8e |

Not self-hosted: Intear's executor `https://wallet.intear.tech/near-selector.js` is served by the
wallet vendor itself.

Skim result (Noa Market, 2026-10-09/16): no dynamic `import()` of remote URLs, no `importScripts`, no
script injection; only `eval` is the bundled `vm` polyfill. meteor.js talks to the Meteor extension /
in-app browser via `window.meteorCom(V2)` (manifest `external`), `https://mc.meteorwallet.app`, and
deep-links `meteorwallet://`.

`vendor/hot-labs-near-connect-0.11.5.tgz`: `@hot-labs/near-connect@0.11.5` (not on npm; GitHub
release azbang/near-connect v0.11.5, built 2026-10-14), tarball sha256
8d62a4f4dadce4ffe1c3e0ef74c13aaa0484853ab32f5caa7c403f273b5aca45.
