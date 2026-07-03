# GitHub Pages site

This folder is the landing page for eDreams Flex Scanner, served via GitHub Pages.

## Enable it

1. Push the repo to GitHub.
2. Repo **Settings → Pages**.
3. Source: **Deploy from a branch** → branch `main`, folder `/docs`.
4. The site goes live at `https://lucascanero.github.io/edreams-flex-scanner/`.

## When the extension is published to the Chrome Web Store

Open `docs/index.html`, find `const STORE_URL = "";` near the bottom, and paste
the Web Store URL. The hero button flips from "Install · from source" to a live
"Add to Chrome" automatically — no other change needed.

## Screenshot

`screenshot.png` (referenced by the root README) should be a capture of the
extension's side panel. Add it here once you have one.
