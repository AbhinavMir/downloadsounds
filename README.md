# YTD_DJ

Download YouTube videos as MP3 (or MP4) into AI-categorized folders, then browse them in a file-explorer-style UI inside Chrome. Built for personal DJ practice with royalty-free content. Audio files land in `~/YTD_DJ/{genre}/{sub-genre}/` with ID3 tags so Djay Pro (or any tag-aware player) can filter on genre; videos land in `~/YTD_DJ_Video/` (a parallel root, so a music-only library tool will not index them).

> Personal-use tool. Do not use to redistribute or perform copyrighted content. You are responsible for honoring YouTube's Terms of Service and any applicable copyright.

## What you get

- Chrome extension that adds **Download MP3** and **Download Video** buttons on YouTube watch pages.
- A local Python helper (FastAPI) that runs `yt-dlp` + `ffmpeg`, asks Claude to categorize each download, writes ID3 tags, and saves to disk.
- A file-explorer page (opened from the extension popup) with breadcrumb navigation, in-page audio/video playback, reveal-in-Finder, and delete.

You supply your own Anthropic API key. Nothing is hosted; both pieces run locally on your machine.

## Requirements

- macOS (the LaunchAgent helper-as-service script is mac-only; the rest works anywhere with Python and Chrome).
- Python 3.10+
- `ffmpeg` (`brew install ffmpeg`)
- Google Chrome
- An Anthropic API key — get one at https://console.anthropic.com

## Install

### 1. Clone and start the helper

```bash
git clone <this-repo>.git ytd_dj
cd ytd_dj/helper
./run.sh
```

The first run creates `helper/.venv`, installs Python dependencies (including `yt-dlp`), and starts the server on `http://127.0.0.1:7531`. Keep this terminal open while using the tool — or jump to the **Run as a background service** section below.

### 2. Set your API key

Put your key in `~/.ytd_dj/config.json` (the helper auto-creates `~/.ytd_dj/` on first run). Either format works:

```
ANTHROPIC_API_KEY=sk-ant-...
```

or JSON:

```json
{ "anthropic_api_key": "sk-ant-..." }
```

Alternatively, export `ANTHROPIC_API_KEY` in the shell that runs the helper. Restart the helper after setting the key.

### 3. Install the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `extension/` folder from this repo.
4. Pin the **YTD DJ** extension to your toolbar if you want quick access to the library popup.

### 4. Use it

1. Open any YouTube video.
2. Next to the Like/Share buttons you'll see **Download MP3** (red) and **Download Video** (blue). Click one.
3. The helper downloads the audio/video, asks Claude to pick a folder based on title/description/tags + your existing folder list, and saves the file.
4. Click the extension icon for a quick popup library view, or hit **Open browser ↗** to launch the full file-explorer page (with playback + Finder integration).

Files are saved to:

- `~/YTD_DJ/{genre}/{sub-genre}/{Artist - Title}.mp3`
- `~/YTD_DJ_Video/{genre}/{sub-genre}/{Artist - Title}.mp4`

## Run the helper as a background service (macOS)

If you'd rather not keep a terminal open, install the helper as a `launchd` LaunchAgent. It will start at login and restart automatically if it crashes.

```bash
cd helper
./service.sh install     # generate plist for your install path, load and start
./service.sh status      # check running state + recent log lines
./service.sh log         # tail the log
./service.sh restart     # after editing main.py
./service.sh uninstall   # remove the service
```

Logs go to `~/.ytd_dj/helper.log`.

## How it works

```
┌────────────────────────┐         ┌──────────────────────────┐
│  Chrome extension      │  POST   │  Local helper (FastAPI)  │
│  - injects buttons     │ ──────► │  127.0.0.1:7531          │
│  - popup library       │         │  - yt-dlp → ffmpeg → mp3 │
│  - file browser page   │ ◄────── │  - Claude categorize     │
└────────────────────────┘  JSON   │  - mutagen ID3 tags      │
                                   │  - serves /file /browse  │
                                   └──────────────────────────┘
                                              │
                                              ▼
                                   ~/YTD_DJ/{genre}/{sub}/track.mp3
                                   ~/YTD_DJ_Video/{genre}/{sub}/track.mp4
```

For each download the helper sends the video's title, channel, duration, tags, categories, and a 2000-char slice of the description, plus the current list of existing folders, to Claude (Sonnet 4.6). Claude returns a JSON `{top_folder, sub_folder, artist, title, id3_genre}`, prefers existing folders to limit fragmentation, and the helper writes the file.

## API endpoints (helper)

| Method | Path                                | Purpose                          |
| ------ | ----------------------------------- | -------------------------------- |
| GET    | `/status`                           | health, missing deps, has-key    |
| POST   | `/download`                         | `{url, kind: audio\|video}`      |
| GET    | `/library?root=audio\|video`        | flat list of all files           |
| GET    | `/browse?root=&path=`               | one folder (folders + files)     |
| GET    | `/file?root=&path=`                 | stream a file (audio/video tag)  |
| POST   | `/reveal?root=&path=`               | open in Finder                   |
| DELETE | `/file?root=&path=`                 | delete a file                    |

All `path` parameters are validated against the configured root to prevent path traversal.

## Configuration

- `~/.ytd_dj/config.json` — API key (env var also works).
- Output roots — `~/YTD_DJ` (audio) and `~/YTD_DJ_Video` (video). Edit `helper/main.py` (`AUDIO_DIR`, `VIDEO_DIR`) to change.
- Port — `7531`. Edit `PORT` in `helper/main.py` and update `HELPER` in `extension/content.js`, `extension/popup.js`, and `extension/library.js` to match.
- AI model — `claude-sonnet-4-6`. Edit `MODEL` in `helper/main.py` to swap.

## Limitations

- macOS-focused (helper itself runs anywhere, but `service.sh` and the Reveal-in-Finder call use macOS-only commands).
- Single-user, no auth — the helper listens on `127.0.0.1` only.
- Categorization quality is only as good as the YouTube metadata. Edit folders manually if the AI is wrong.
- AI calls cost money. Each download is a single Claude request with a small payload, but if you batch hundreds of downloads, watch your usage.

## Troubleshooting

- **Popup says "Helper not running"** — start `helper/run.sh` (or `./service.sh status` if you installed the service).
- **Popup says "no API key"** — set `ANTHROPIC_API_KEY` in `~/.ytd_dj/config.json` or as an env var, then restart the helper.
- **"ffmpeg missing"** — `brew install ffmpeg`.
- **Download button doesn't appear on YouTube** — YouTube occasionally renames its DOM. Open the extension's content-script and adjust `findAnchor()` in `extension/content.js`.
- **yt-dlp errors** — YouTube changes break `yt-dlp` periodically. Update with `helper/.venv/bin/pip install -U yt-dlp` and restart the helper.

## License

MIT — see `LICENSE`.
