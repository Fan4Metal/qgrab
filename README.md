# QGrab

**English** · [Русский](README.ru.md)

A Chromium extension (Vivaldi, Chrome, Edge, Brave) that detects video and audio on web pages, including HLS streams, and downloads them under the **original file name**. It is an alternative to Video Downloader Professional, which replaces the original name with a generic one.

## Features

- Detection of media files (MP4, WebM, MKV, MOV, MP3, M4A and others) by the `Content-Type` of network responses and by `<video>`/`<audio>` elements.
- Detection of HLS (`.m3u8`) and MPEG-DASH (`.mpd`) streams, with a choice of quality and an estimated file size.
- Downloading of DASH streams in fragmented MP4 (SegmentTemplate with or without SegmentTimeline, SegmentList, SegmentBase with a `sidx` index); video and audio are assembled into one MP4 file.
- Downloading of HLS streams, including AES-128 encrypted ones, with parallel segment loading, retries and the option to save without failed segments.
- Conversion of HLS streams to MP4 without re-encoding: MPEG-TS (H.264 + AAC) and fragmented MP4 become a regular MP4 file with the index at the start, so it opens and seeks in any player. A separate audio track is merged into the same file; audio-only streams are saved as M4A.
- The `Referer` of the source page is sent automatically, so CDNs that check it do not refuse the download.
- Hiding of irrelevant requests: stream segments, MSE chunks, small files (previews, interface sounds), YouTube chunks.
- The file name can be edited in the popup before downloading. Buttons under the name field switch between the available variants (selection, server, link, folder, page title, title + name); the ↑/↓ keys in the field cycle through them.
- Text selected on the page with the mouse becomes the file name when the popup is opened: line breaks, extra spaces and wrapping quotes are removed, characters not allowed in file names are replaced. If the selection was cleared in the meantime (for example, by clicking the player), the last selected text remains available as a variant.
- English and Russian interface; light and dark themes.

## How the file name is determined

The name is taken from the first available source:

1. The `Content-Disposition` response header, including `filename*=UTF-8''…` (RFC 5987) and UTF-8 names that arrive garbled as Latin-1.
2. A name embedded in the link: `response-content-disposition` of signed S3/CloudFront URLs, the `filename`, `file`, `name` parameters.
3. The last segment of the URL path, with percent-encoding decoded (`My%20Trip.mp4` → `My Trip.mp4`).
4. For streams with a meaningless manifest name (`index.m3u8`, `master.m3u8`), the nearest meaningful parent directory (`/movies/Big_Buck_Bunny/hls/index.m3u8` → `Big_Buck_Bunny`).
5. The page title.

A name is considered meaningless when it is a typical manifest or CDN name (`index`, `playlist`, `chunklist_b800000`, `video`), a quality designation (`1080p`), a number, a hash or a UUID.

The naming mode is selected in the settings:

| Mode | Result |
|---|---|
| Smart (default) | The original name; the page title when the original name is meaningless |
| Always original | The name from the server or the link, without exceptions |
| Page title | The title of the page where the media was found |
| Page title + original name | For example, `Lecture 5 - lecture5_part2.mp4` |

Characters that are not allowed in file names are replaced (`:` and `|` become ` - `, `/` becomes `-`), names reserved by Windows (`CON`, `NUL`, …) are prefixed, and the length is limited to 150 characters.

## Installation

The extension is installed as an unpacked extension:

1. The page `vivaldi://extensions` (or `chrome://extensions`, `edge://extensions`) is opened.
2. **Developer mode** is enabled.
3. **Load unpacked** is selected, followed by the project folder (the one that contains `manifest.json`).

If Video Downloader Professional is installed as well, disabling it is recommended: its `onDeterminingFilename` handler may override names assigned by other extensions.

## Usage

Media is detected while the page loads it, so playback has to be started first. The extension icon shows the number of items found on the current tab. The popup lists them with the size or duration, a quality selector for HLS, a name field, a copy-link button and a download button.

Regular files are passed to the browser's download manager directly. An HLS stream is downloaded in a separate background tab that shows progress, speed and remaining time; once the file is saved, the tab closes (configurable).

## Settings

- File naming mode (see above).
- Subfolder inside the Downloads folder.
- Asking where to save each file.
- Saving HLS streams as MP4 (enabled by default).
- Number of parallel segment downloads for HLS (1–16).
- Closing the stream tab when the download is finished.
- Minimum size of listed files (500 KB by default).

## Limitations

- Conversion to MP4 covers H.264 and AAC in MPEG-TS, raw AAC segments and any codecs in fragmented MP4 (H.264, HEVC, AV1, AAC, AC-3 and others). For MPEG-TS streams with HEVC, MP3 or AC-3, and when the conversion is disabled, the stream is saved in its original container (`.ts`), and a separate audio track becomes a second file.
- Not supported for DASH: live streams, WebM representations, and manifests with several periods (only the first period is saved).
- DRM-protected streams (SAMPLE-AES, Widevine, FairPlay, PlayReady) are not supported.
- For live streams, only the segments available at the moment of download are saved.
- An HLS stream is assembled in the browser's memory before saving; very long high-bitrate videos require a corresponding amount of RAM.
- YouTube is not supported: its player loads video and audio in chunks that cannot be saved as files.

## Permissions

| Permission | Purpose |
|---|---|
| `webRequest`, access to all sites | Reading response headers (type, size, file name) of media requests |
| `downloads` | Saving files under the chosen name |
| `declarativeNetRequestWithHostAccess` | Sending the page's `Referer` with the extension's own requests |
| `scripting` | Reading the text selected on the page when the popup is opened |
| `storage` | Settings and the list of found items, which survives restarts of the service worker |

The extension does not send data to any third-party server.

## Project structure

```
manifest.json
src/background.js        service worker: detection, item list, start of downloads
src/content.js           <video>/<audio> sources of the page
src/lib/                 shared modules: names, media types, HLS and DASH parsers, Referer rules, settings
src/lib/mp4/             HLS → MP4 remuxer: MPEG-TS and fMP4 demuxers, H.264/AAC, MP4 writer
src/popup/               list of found items
src/downloader/          HLS and DASH stream download page
src/options/             settings page
_locales/en, _locales/ru interface strings
tools/make-icons.mjs     icon generator (no dependencies)
tools/e2e.mjs            end-to-end test in a real browser
tests/                   unit tests
```

## Development

Node.js 18 or later is required for the tests and tools; the extension itself needs no build step.

- `npm test` runs the unit tests (names, media types, HLS and DASH parsers, MP4 conversion). The conversion tests generate streams with ffmpeg and check the result with ffprobe; without ffmpeg in `PATH` they are skipped.
- `node tools/e2e.mjs <path to browser executable>` launches the browser with a temporary profile, serves a test page, downloads all detected media and verifies file names, HLS decryption, the `Referer` header and, when ffmpeg is available, the MP4 conversion including playback in the browser. With `SHOTS=1` it also saves popup screenshots.
- `npm run icons` regenerates the icons.

For Vivaldi on Windows, the end-to-end test is started as follows:

```
node tools/e2e.mjs "%LOCALAPPDATA%\Vivaldi\Application\vivaldi.exe"
```
