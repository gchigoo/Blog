# Pinned visual-test assets

These files are used only by Playwright visual tests. Production templates keep their original CDN URLs.

- `new.min.css`: `@exampledev/new.css@1.1.2`, fetched from the exact jsDelivr URL used by the templates. SHA-256: `3169a014d8fc5f3dec953fb5825b55c13f79e4bec1c05e4a996ba8bc9d430f8f` (MIT).
- `Inter-*.woff2`: selected Inter weights fetched from `fonts.xz.style/serve/src/inter/`; Inter is distributed under the SIL Open Font License 1.1.
- `inter.css`: test-only fixed subset of the production Inter stylesheet. SHA-256: `01ee5e356cca7a2e65479858ae274a13192f26cc28043e270a2e922750c05e5e`. It uses `font-display: block`; browser tests explicitly load every used weight, verify `document.fonts`, and wait for two animation frames before taking screenshots.

Pinned font hashes are recorded in `asset-manifest.json` and verified before visual comparison.
