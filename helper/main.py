import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yt_dlp
from anthropic import Anthropic
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from mutagen.id3 import ID3, TALB, TCON, TDRC, TIT2, TPE1
from mutagen.mp3 import MP3
from pydantic import BaseModel

AUDIO_DIR = Path.home() / "YTD_DJ"
VIDEO_DIR = Path.home() / "YTD_DJ_Video"
CONFIG_DIR = Path.home() / ".ytd_dj"
CONFIG_FILE = CONFIG_DIR / "config.json"
PORT = 7531
MODEL = "claude-sonnet-4-6"

AUDIO_DIR.mkdir(exist_ok=True)
VIDEO_DIR.mkdir(exist_ok=True)
CONFIG_DIR.mkdir(exist_ok=True)

ROOTS = {"audio": AUDIO_DIR, "video": VIDEO_DIR}

app = FastAPI(title="YTD_DJ Helper")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class DownloadRequest(BaseModel):
    url: str
    kind: str = "audio"  # "audio" or "video"


def _read_config_key() -> str | None:
    if not CONFIG_FILE.exists():
        return None
    try:
        text = CONFIG_FILE.read_text().strip()
    except OSError:
        return None
    if not text:
        return None
    try:
        cfg = json.loads(text)
        if isinstance(cfg, dict):
            for k in ("anthropic_api_key", "ANTHROPIC_API_KEY"):
                if cfg.get(k):
                    return cfg[k]
    except json.JSONDecodeError:
        pass
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            if k.strip().upper() == "ANTHROPIC_API_KEY":
                return v.strip().strip('"').strip("'")
    return None


def get_api_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY") or _read_config_key()


def get_anthropic_client() -> Anthropic:
    key = get_api_key()
    if not key:
        raise HTTPException(
            500,
            f"No Anthropic API key. Set ANTHROPIC_API_KEY or put "
            f'ANTHROPIC_API_KEY=sk-... in {CONFIG_FILE}',
        )
    return Anthropic(api_key=key)


def root_for(kind: str) -> Path:
    if kind not in ROOTS:
        raise HTTPException(400, f"Invalid kind/root: {kind}")
    return ROOTS[kind]


def safe_path(kind: str, rel: str) -> Path:
    base = root_for(kind).resolve()
    rel = (rel or "").lstrip("/")
    target = (base / rel).resolve()
    if base != target and base not in target.parents:
        raise HTTPException(400, "Path traversal blocked")
    return target


def list_folders(base: Path) -> list[dict]:
    out = []
    for top in sorted(base.iterdir()):
        if not top.is_dir() or top.name.startswith("."):
            continue
        subs = sorted(
            s.name for s in top.iterdir() if s.is_dir() and not s.name.startswith(".")
        )
        out.append({"name": top.name, "subs": subs})
    return out


CATEGORIZE_SYSTEM = """You categorize YouTube downloads for a DJ's personal practice library (royalty-free / personal use only).

You receive video metadata and the current folder structure. You return a JSON object with these fields:

- top_folder: top-level genre family in kebab-case (e.g., "house", "techno", "hip-hop", "dnb", "trance", "trap", "vocal-samples", "fx", "ambient", "lo-fi", "pop", "rock", "edm", "experimental", "world", "soundtrack"). Prefer an existing top folder; only invent a new one if the content truly doesn't fit any.
- sub_folder: more specific style in kebab-case (e.g., "deep-house", "tech-house", "melodic-techno"). If unclear, use a generic descriptor like "general". Prefer existing sub-folders within the chosen top folder.
- artist: clean artist name (e.g., "Daft Punk"). Extract from title if present (often "Artist - Track"), otherwise use the channel name. Strip noise like "Official", "VEVO", "Records".
- title: clean track title without YouTube cruft. Strip "(Official Video)", "[HD]", "(Lyric Video)", "| Free Download", brackets noting genres, etc.
- id3_genre: human-readable genre string for the ID3 TCON tag, used by Djay Pro filters (e.g., "Deep House", "Tech House", "Drum & Bass"). Title-case, spaces allowed.

Be CONSERVATIVE about creating new top_folders. The goal is a tidy library. When in doubt, reuse the closest existing one.

Respond with ONLY a JSON object, no prose, no codefences."""


def categorize(info: dict, folders: list[dict]) -> dict:
    client = get_anthropic_client()
    desc = (info.get("description") or "")[:2000]
    tags = info.get("tags") or []
    user_msg = (
        f"Title: {info.get('title')}\n"
        f"Channel: {info.get('uploader')}\n"
        f"Duration: {info.get('duration')}s\n"
        f"Tags: {tags[:20]}\n"
        f"Categories: {info.get('categories') or []}\n"
        f"Description (first 2000 chars):\n{desc}\n\n"
        f"Existing folders:\n{json.dumps(folders, indent=2)}"
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=500,
        system=[
            {
                "type": "text",
                "text": CATEGORIZE_SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_msg}],
    )
    text = resp.content[0].text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


SAFE_CHARS = re.compile(r"[^a-zA-Z0-9\-_\. ]+")
NAME_CHARS = re.compile(r"[^a-zA-Z0-9\-_\. ()&']+")


def slugify(s: str, fallback: str = "untitled") -> str:
    if not s:
        return fallback
    s = SAFE_CHARS.sub("", s).strip()
    s = re.sub(r"\s+", "-", s).strip("-.").lower()
    return s or fallback


def safe_filename(s: str, fallback: str = "untitled") -> str:
    if not s:
        return fallback
    s = SAFE_CHARS.sub("", s).strip()
    s = re.sub(r"\s+", " ", s)
    return s or fallback


def unique_path(target_dir: Path, base: str, ext: str) -> Path:
    p = target_dir / f"{base}.{ext}"
    counter = 1
    while p.exists():
        p = target_dir / f"{base} ({counter}).{ext}"
        counter += 1
    return p


def write_id3(mp3_path: Path, info: dict, title: str, artist: str, id3_genre: str) -> None:
    try:
        audio = MP3(mp3_path, ID3=ID3)
        if audio.tags is None:
            audio.add_tags()
        audio.tags["TIT2"] = TIT2(encoding=3, text=title)
        audio.tags["TPE1"] = TPE1(encoding=3, text=artist)
        audio.tags["TCON"] = TCON(encoding=3, text=id3_genre)
        if info.get("uploader"):
            audio.tags["TALB"] = TALB(encoding=3, text=info["uploader"])
        if info.get("upload_date"):
            audio.tags["TDRC"] = TDRC(encoding=3, text=info["upload_date"][:4])
        audio.save()
    except Exception as e:
        print(f"ID3 tag write failed (non-fatal): {e}", file=sys.stderr)


@app.get("/status")
def status():
    return {
        "ok": True,
        "audio_root": str(AUDIO_DIR),
        "video_root": str(VIDEO_DIR),
        "yt_dlp": shutil.which("yt-dlp") or "python module",
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "has_api_key": bool(get_api_key()),
    }


@app.post("/download")
def download(req: DownloadRequest):
    kind = req.kind if req.kind in ROOTS else "audio"
    base_root = ROOTS[kind]

    if not shutil.which("ffmpeg"):
        raise HTTPException(500, "ffmpeg not found. Run: brew install ffmpeg")

    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
            info = ydl.extract_info(req.url, download=False)
    except Exception as e:
        raise HTTPException(400, f"yt-dlp metadata failed: {e}")

    try:
        decision = categorize(info, list_folders(base_root))
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"AI returned invalid JSON: {e}")

    top = slugify(decision.get("top_folder"), "unsorted")
    sub = slugify(decision.get("sub_folder"), "general")
    artist = safe_filename(decision.get("artist"), "Unknown Artist")
    title = safe_filename(decision.get("title"), info.get("title") or "untitled")
    id3_genre = decision.get("id3_genre") or sub.replace("-", " ").title()

    target_dir = base_root / top / sub
    target_dir.mkdir(parents=True, exist_ok=True)

    base = NAME_CHARS.sub("", f"{artist} - {title}").strip() or "untitled"

    if kind == "audio":
        final_path = unique_path(target_dir, base, "mp3")
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": str(final_path.with_suffix("")) + ".%(ext)s",
            "quiet": True,
            "no_warnings": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "320",
                }
            ],
        }
        glob_ext = "mp3"
    else:  # video
        final_path = unique_path(target_dir, base, "mp4")
        ydl_opts = {
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "merge_output_format": "mp4",
            "outtmpl": str(final_path.with_suffix("")) + ".%(ext)s",
            "quiet": True,
            "no_warnings": True,
        }
        glob_ext = "mp4"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([req.url])
    except Exception as e:
        raise HTTPException(500, f"Download failed: {e}")

    if not final_path.exists():
        candidates = list(target_dir.glob(f"{base}*.{glob_ext}"))
        if candidates:
            final_path = candidates[0]
        else:
            raise HTTPException(500, f"Download completed but {glob_ext.upper()} not found")

    if kind == "audio":
        write_id3(final_path, info, title, artist, id3_genre)

    return {
        "success": True,
        "kind": kind,
        "path": str(final_path),
        "rel_path": str(final_path.relative_to(base_root)),
        "top_folder": top,
        "sub_folder": sub,
        "folder": f"{top}/{sub}",
        "artist": artist,
        "title": title,
        "id3_genre": id3_genre,
        "source_url": req.url,
    }


@app.get("/library")
def library(root: str = Query("audio")):
    base = root_for(root)
    pattern = "*.mp3" if root == "audio" else "*.mp4"
    items = []
    for f in base.rglob(pattern):
        rel = f.relative_to(base)
        parts = rel.parts
        items.append(
            {
                "rel_path": str(rel),
                "name": f.stem,
                "top_folder": parts[0] if len(parts) > 1 else "",
                "sub_folder": parts[1] if len(parts) > 2 else "",
                "size_bytes": f.stat().st_size,
            }
        )
    items.sort(key=lambda x: (x["top_folder"], x["sub_folder"], x["name"]))
    return {"root": str(base), "kind": root, "count": len(items), "items": items}


@app.get("/browse")
def browse(root: str = Query("audio"), path: str = Query("")):
    target = safe_path(root, path)
    if not target.exists() or not target.is_dir():
        raise HTTPException(404, "Folder not found")
    folders = []
    files = []
    for child in sorted(target.iterdir(), key=lambda p: p.name.lower()):
        if child.name.startswith("."):
            continue
        rel = str(child.relative_to(root_for(root)))
        if child.is_dir():
            try:
                child_count = sum(1 for _ in child.rglob("*") if _.is_file())
            except OSError:
                child_count = 0
            folders.append({"name": child.name, "rel_path": rel, "count": child_count})
        elif child.is_file():
            ext = child.suffix.lower().lstrip(".")
            files.append(
                {
                    "name": child.name,
                    "stem": child.stem,
                    "rel_path": rel,
                    "size_bytes": child.stat().st_size,
                    "ext": ext,
                }
            )
    base = root_for(root)
    rel_here = "" if target == base else str(target.relative_to(base))
    return {
        "kind": root,
        "root": str(base),
        "path": rel_here,
        "folders": folders,
        "files": files,
    }


@app.get("/file")
def get_file(root: str = Query("audio"), path: str = Query(...)):
    target = safe_path(root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")
    media_type = None
    ext = target.suffix.lower()
    if ext == ".mp3":
        media_type = "audio/mpeg"
    elif ext == ".mp4":
        media_type = "video/mp4"
    elif ext == ".m4a":
        media_type = "audio/mp4"
    return FileResponse(target, media_type=media_type, filename=target.name)


@app.post("/reveal")
def reveal(root: str = Query("audio"), path: str = Query("")):
    target = safe_path(root, path)
    if not target.exists():
        raise HTTPException(404, "Path not found")
    try:
        subprocess.run(["open", "-R", str(target)], check=False)
        return {"ok": True, "revealed": str(target)}
    except Exception as e:
        raise HTTPException(500, f"open failed: {e}")


@app.delete("/file")
def delete_file(root: str = Query("audio"), path: str = Query(...)):
    target = safe_path(root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")
    target.unlink()
    return {"ok": True, "deleted": str(target)}


if __name__ == "__main__":
    import uvicorn

    print(f"YTD_DJ helper starting on http://127.0.0.1:{PORT}")
    print(f"Audio library: {AUDIO_DIR}")
    print(f"Video library: {VIDEO_DIR}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
