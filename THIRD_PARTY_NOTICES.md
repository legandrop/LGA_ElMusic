# Third-party notices

## Shipped with the app

- **Castlabs Electron for Content Security 44.5.1+wvcus** — MIT, plus the Chromium and Electron notices that every package includes as `LICENSE.electron.txt` and `LICENSES.chromium.html`. Keep those files when redistributing a package. Source: <https://github.com/castlabs/electron-releases>.
- **Pretendard Variable** by Kil Hyung-jin — SIL Open Font License 1.1, unmodified. The font and its full license are in `src/ui/fonts/`, with an identical copy in `streamdeck/com.lga.elmusic.sdPlugin/ui/fonts/` for drawing the playlist keys. Project: <https://github.com/orioncactus/pretendard>.
- **Widevine CDM** is not included. Castlabs Electron downloads it from Google the first time the app runs.

No code or assets from other Apple Music clients are included. Music, artwork and sign-in are served by Apple.

## Used only to build

- TypeScript — Apache-2.0.
- electron-builder — MIT.
- @types/node — MIT.
- Node.js — its own license, downloaded by `tools/setup-node-*` and checked against the hashes in `tools/runtime-lock.json`.
- Castlabs EVS client — Apache-2.0, used only to sign packages; its exact versions are in `tools/evs-requirements-*.txt`.

The exact version of every dependency is in `package-lock.json`.

## Data sources

The app asks these services for public information about the music on screen. None of them needs an account except Last.fm, which needs your own free key.

- **Apple Music catalog**, through the Apple Music web player you are signed in to, read only.
- **iTunes Search API** — <https://performance-partners.apple.com/search-api>.
- **MusicBrainz** — core data under CC0, at most one request per second. <https://musicbrainz.org/doc/About/Data_License>.
- **ListenBrainz Labs** — an experimental public service. <https://labs.api.listenbrainz.org/>.
- **Last.fm API** — only with your own key, read only, under the Last.fm API terms. <https://www.last.fm/api/tos>.
- **Spotify** — only when you paste a Spotify link: the app reads that one public embed page to get the title, artists and length.
