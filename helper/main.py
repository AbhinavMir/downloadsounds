import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from contextlib import closing
from pathlib import Path

import yt_dlp
from anthropic import Anthropic
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from mutagen.id3 import ID3, TALB, TCON, TDRC, TIT2, TPE1
from mutagen.mp3 import MP3
from pydantic import BaseModel

DEFAULT_AUDIO_DIR = Path.home() / "YTD_DJ"
DEFAULT_VIDEO_DIR = Path.home() / "YTD_DJ_Video"
CONFIG_DIR = Path.home() / ".ytd_dj"
CONFIG_FILE = CONFIG_DIR / "config.json"
HISTORY_FILE = CONFIG_DIR / "history.json"
DB_FILE = CONFIG_DIR / "library.db"
PORT = 7531
VERSION = "0.10.2"

DEFAULT_PROVIDER = "anthropic"
DEFAULT_MODEL_BY_PROVIDER = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o",
    "ollama": "llama3.1:8b",
}
SUPPORTED_PROVIDERS = set(DEFAULT_MODEL_BY_PROVIDER.keys())
DEFAULT_OLLAMA_URL = "http://localhost:11434"
REPO = "AbhinavMir/downloadsounds"
REMOTE_VERSION_URL = f"https://raw.githubusercontent.com/{REPO}/main/VERSION"

YOUTUBE_ID_RE = re.compile(
    r"(?:youtu\.be/|youtube\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|v/))([A-Za-z0-9_-]{11})"
)

DEFAULT_AUDIO_DIR.mkdir(exist_ok=True)
DEFAULT_VIDEO_DIR.mkdir(exist_ok=True)
CONFIG_DIR.mkdir(exist_ok=True)

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
    model: str | None = None  # one-off override of the configured model


class ConfigUpdate(BaseModel):
    audio_root: str | None = None
    video_root: str | None = None
    provider: str | None = None
    model: str | None = None
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    ollama_url: str | None = None
    categorize_prompt: str | None = None


class TestKeyRequest(BaseModel):
    provider: str
    key: str | None = None
    url: str | None = None


class PositionUpdate(BaseModel):
    root: str
    path: str
    position_sec: float
    duration_sec: float | None = None


class CompletedUpdate(BaseModel):
    root: str
    path: str
    completed: bool = True


class RenameRequest(BaseModel):
    root: str
    old_path: str
    new_name: str


class MoveRequest(BaseModel):
    root: str
    old_path: str
    new_dir: str


class CreateFolderRequest(BaseModel):
    root: str
    path: str


class ReclassifyRequest(BaseModel):
    root: str
    path: str


def _parse_config_file() -> dict:
    """Parse the helper config file. Accepts JSON object or .env-style key=value lines."""
    if not CONFIG_FILE.exists():
        return {}
    try:
        text = CONFIG_FILE.read_text().strip()
    except OSError:
        return {}
    if not text:
        return {}
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def read_config() -> dict:
    """Return the merged effective config. Env vars override file; alias keys are normalized."""
    raw = _parse_config_file()

    def pick(*keys):
        for k in keys:
            if raw.get(k):
                return raw[k]
        return None

    provider = (pick("provider", "PROVIDER") or DEFAULT_PROVIDER).lower()
    if provider not in SUPPORTED_PROVIDERS:
        provider = DEFAULT_PROVIDER

    model = pick("model", "MODEL", f"{provider}_model")
    anthropic_key = pick("anthropic_api_key", "ANTHROPIC_API_KEY")
    openai_key = pick("openai_api_key", "OPENAI_API_KEY")
    ollama_url = pick("ollama_url", "OLLAMA_URL") or DEFAULT_OLLAMA_URL

    # Env overrides
    if os.environ.get("ANTHROPIC_API_KEY"):
        anthropic_key = os.environ["ANTHROPIC_API_KEY"]
    if os.environ.get("OPENAI_API_KEY"):
        openai_key = os.environ["OPENAI_API_KEY"]
    if os.environ.get("OLLAMA_URL"):
        ollama_url = os.environ["OLLAMA_URL"]
    if os.environ.get("YTD_PROVIDER"):
        env_provider = os.environ["YTD_PROVIDER"].lower()
        if env_provider in SUPPORTED_PROVIDERS:
            provider = env_provider
    if os.environ.get("YTD_MODEL"):
        model = os.environ["YTD_MODEL"]

    if not model:
        model = DEFAULT_MODEL_BY_PROVIDER[provider]

    return {
        "provider": provider,
        "model": model,
        "anthropic_api_key": anthropic_key,
        "openai_api_key": openai_key,
        "ollama_url": ollama_url,
    }


def active_api_key(cfg: dict | None = None) -> str | None:
    cfg = cfg or read_config()
    if cfg["provider"] == "openai":
        return cfg["openai_api_key"]
    if cfg["provider"] == "anthropic":
        return cfg["anthropic_api_key"]
    return None  # ollama doesn't use a key


def audio_root() -> Path:
    raw = _parse_config_file()
    path = raw.get("audio_root") or raw.get("AUDIO_ROOT")
    p = Path(path).expanduser() if path else DEFAULT_AUDIO_DIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def video_root() -> Path:
    raw = _parse_config_file()
    path = raw.get("video_root") or raw.get("VIDEO_ROOT")
    p = Path(path).expanduser() if path else DEFAULT_VIDEO_DIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_roots() -> dict:
    return {"audio": audio_root(), "video": video_root()}


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_FILE), check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    source_url TEXT,
    video_id TEXT,
    title TEXT,
    artist TEXT,
    content_type TEXT,
    duration_sec REAL,
    added_at INTEGER NOT NULL,
    UNIQUE(root, rel_path)
);

CREATE TABLE IF NOT EXISTS playback (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    position_sec REAL DEFAULT 0,
    completed INTEGER DEFAULT 0,
    last_played_at INTEGER,
    play_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
    file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (file_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_files_video_id ON files(video_id);
CREATE INDEX IF NOT EXISTS idx_playback_last_played
    ON playback(last_played_at DESC);
"""


def db_init() -> None:
    with closing(db_connect()) as conn:
        conn.executescript(DB_SCHEMA)
        conn.commit()


def db_upsert_file(
    root: str,
    rel_path: str,
    *,
    source_url: str | None = None,
    video_id: str | None = None,
    title: str | None = None,
    artist: str | None = None,
    content_type: str | None = None,
    duration_sec: float | None = None,
) -> int:
    with closing(db_connect()) as conn:
        conn.execute(
            """
            INSERT INTO files
              (root, rel_path, source_url, video_id, title, artist,
               content_type, duration_sec, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(root, rel_path) DO UPDATE SET
              source_url   = COALESCE(excluded.source_url, files.source_url),
              video_id     = COALESCE(excluded.video_id, files.video_id),
              title        = COALESCE(excluded.title, files.title),
              artist       = COALESCE(excluded.artist, files.artist),
              content_type = COALESCE(excluded.content_type, files.content_type),
              duration_sec = COALESCE(excluded.duration_sec, files.duration_sec)
            """,
            (root, rel_path, source_url, video_id, title, artist,
             content_type, duration_sec, int(time.time())),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id FROM files WHERE root=? AND rel_path=?",
            (root, rel_path),
        ).fetchone()
        return int(row["id"]) if row else 0


def db_get_file(root: str, rel_path: str) -> dict | None:
    with closing(db_connect()) as conn:
        f = conn.execute(
            "SELECT * FROM files WHERE root=? AND rel_path=?",
            (root, rel_path),
        ).fetchone()
        if not f:
            return None
        p = conn.execute(
            "SELECT * FROM playback WHERE file_id=?", (f["id"],)
        ).fetchone()
        return {
            "id": f["id"],
            "root": f["root"],
            "rel_path": f["rel_path"],
            "source_url": f["source_url"],
            "video_id": f["video_id"],
            "title": f["title"],
            "artist": f["artist"],
            "content_type": f["content_type"],
            "duration_sec": f["duration_sec"],
            "added_at": f["added_at"],
            "position_sec": (p["position_sec"] if p else 0) or 0,
            "completed": bool(p and p["completed"]),
            "last_played_at": p["last_played_at"] if p else None,
            "play_count": (p["play_count"] if p else 0) or 0,
        }


def _ensure_file_id(conn: sqlite3.Connection, root: str, rel_path: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM files WHERE root=? AND rel_path=?",
        (root, rel_path),
    ).fetchone()
    if row:
        return int(row["id"])
    full = root_for(root) / rel_path
    if not full.exists():
        return None
    conn.execute(
        """
        INSERT INTO files (root, rel_path, added_at)
        VALUES (?, ?, ?)
        ON CONFLICT(root, rel_path) DO NOTHING
        """,
        (root, rel_path, int(time.time())),
    )
    row = conn.execute(
        "SELECT id FROM files WHERE root=? AND rel_path=?",
        (root, rel_path),
    ).fetchone()
    return int(row["id"]) if row else None


def db_update_position(root: str, rel_path: str, position_sec: float,
                       duration_sec: float | None = None) -> None:
    with closing(db_connect()) as conn:
        fid = _ensure_file_id(conn, root, rel_path)
        if fid is None:
            raise HTTPException(404, "File not found")
        if duration_sec:
            conn.execute(
                "UPDATE files SET duration_sec = ? WHERE id = ?",
                (duration_sec, fid),
            )
        now = int(time.time())
        conn.execute(
            """
            INSERT INTO playback (file_id, position_sec, last_played_at, play_count)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(file_id) DO UPDATE SET
              position_sec   = excluded.position_sec,
              last_played_at = excluded.last_played_at
            """,
            (fid, max(0.0, float(position_sec)), now),
        )
        conn.commit()


def db_mark_completed(root: str, rel_path: str, completed: bool = True) -> None:
    with closing(db_connect()) as conn:
        fid = _ensure_file_id(conn, root, rel_path)
        if fid is None:
            raise HTTPException(404, "File not found")
        now = int(time.time())
        if completed:
            conn.execute(
                """
                INSERT INTO playback (file_id, completed, last_played_at, play_count)
                VALUES (?, 1, ?, 1)
                ON CONFLICT(file_id) DO UPDATE SET
                  completed       = 1,
                  last_played_at  = excluded.last_played_at,
                  play_count      = playback.play_count + 1
                """,
                (fid, now),
            )
        else:
            conn.execute(
                "UPDATE playback SET completed = 0 WHERE file_id = ?",
                (fid,),
            )
        conn.commit()


def db_continue_listening(root: str, limit: int = 20) -> list[dict]:
    with closing(db_connect()) as conn:
        rows = conn.execute(
            """
            SELECT f.root, f.rel_path, f.title, f.artist, f.duration_sec,
                   p.position_sec, p.last_played_at
            FROM playback p
            JOIN files f ON p.file_id = f.id
            WHERE p.position_sec > 0 AND p.completed = 0 AND f.root = ?
            ORDER BY p.last_played_at DESC
            LIMIT ?
            """,
            (root, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def db_delete_file(root: str, rel_path: str) -> None:
    with closing(db_connect()) as conn:
        conn.execute(
            "DELETE FROM files WHERE root=? AND rel_path=?",
            (root, rel_path),
        )
        conn.commit()


def db_update_path(root: str, old_rel: str, new_rel: str) -> None:
    with closing(db_connect()) as conn:
        conn.execute(
            "UPDATE files SET rel_path = ? WHERE root = ? AND rel_path = ?",
            (new_rel, root, old_rel),
        )
        conn.commit()


def db_update_content_type(root: str, rel_path: str, content_type: str) -> None:
    with closing(db_connect()) as conn:
        conn.execute(
            "UPDATE files SET content_type = ? WHERE root = ? AND rel_path = ?",
            (content_type, root, rel_path),
        )
        conn.commit()


def history_update_path(root: str, old_rel: str, new_rel: str) -> None:
    hist = read_history()
    changed = False
    for entry in hist.values():
        if entry.get(root) == old_rel:
            entry[root] = new_rel
            changed = True
    if changed:
        write_history(hist)


def db_backfill_from_disk() -> int:
    """Add files that exist on disk but aren't in the DB yet. Returns count added."""
    added = 0
    with closing(db_connect()) as conn:
        existing = {
            (r["root"], r["rel_path"])
            for r in conn.execute("SELECT root, rel_path FROM files").fetchall()
        }
        now = int(time.time())
        for kind, base in get_roots().items():
            pattern = "*.mp3" if kind == "audio" else "*.mp4"
            for f in base.rglob(pattern):
                rel = str(f.relative_to(base))
                if (kind, rel) in existing:
                    continue
                conn.execute(
                    """
                    INSERT INTO files (root, rel_path, added_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(root, rel_path) DO NOTHING
                    """,
                    (kind, rel, now),
                )
                added += 1
        conn.commit()
    return added


def get_categorize_prompt() -> str:
    raw = _parse_config_file()
    override = raw.get("categorize_prompt") or raw.get("CATEGORIZE_PROMPT")
    if override and isinstance(override, str) and override.strip():
        return override
    return CATEGORIZE_SYSTEM


def root_for(kind: str) -> Path:
    roots = get_roots()
    if kind not in roots:
        raise HTTPException(400, f"Invalid kind/root: {kind}")
    return roots[kind]


def safe_path(kind: str, rel: str) -> Path:
    base = root_for(kind).resolve()
    rel = (rel or "").lstrip("/")
    target = (base / rel).resolve()
    if base != target and base not in target.parents:
        raise HTTPException(400, "Path traversal blocked")
    return target


def extract_video_id(url: str) -> str | None:
    if not url:
        return None
    m = YOUTUBE_ID_RE.search(url)
    return m.group(1) if m else None


def read_history() -> dict:
    if not HISTORY_FILE.exists():
        return {}
    try:
        data = json.loads(HISTORY_FILE.read_text() or "{}")
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def write_history(hist: dict) -> None:
    try:
        HISTORY_FILE.write_text(json.dumps(hist, indent=2))
    except OSError as e:
        print(f"History write failed: {e}", file=sys.stderr)


def record_download(video_id: str | None, kind: str, rel_path: str) -> None:
    if not video_id:
        return
    hist = read_history()
    entry = hist.setdefault(video_id, {})
    entry[kind] = rel_path
    write_history(hist)


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


CATEGORIZE_SYSTEM = """You categorize YouTube downloads for a personal practice library (royalty-free / personal use only).

You receive video metadata and the current folder structure. You return a JSON object with these fields:

- content_type: one of "music", "podcast", "spoken", "other".
  - "music"   = songs, DJ mixes, full sets, instrumentals, beats, sound-design sample packs intended for music use.
  - "podcast" = recurring conversational/episodic shows by named hosts. Recognize by episode numbering, "Ep.", show branding, host introductions, RSS-like titles.
  - "spoken"  = lectures, talks, interviews, audiobook excerpts, one-off spoken content that is not part of a regular podcast.
  - "other"   = sound effects, ambient field recordings, jingles, tutorials, anything that does not fit the above.

- top_folder: top-level folder in kebab-case.
  - music   -> a genre family (e.g., "house", "techno", "hip-hop", "dnb", "trance", "trap", "ambient", "lo-fi", "pop", "rock", "edm", "experimental").
  - podcast -> literally "podcasts".
  - spoken  -> literally "spoken".
  - other   -> literally "other".

- sub_folder: more specific folder in kebab-case.
  - music   -> a sub-genre (e.g., "deep-house", "melodic-techno"). Use "general" if unclear.
  - podcast -> the show name in kebab-case (e.g., "huberman-lab", "lex-fridman", "this-american-life").
  - spoken  -> a topic, course, or series name in kebab-case (e.g., "philosophy", "ai-research", "stanford-cs231n").
  - other   -> a descriptive bucket in kebab-case (e.g., "fx-risers", "ambient", "drum-hits", "vocal-samples").

  Prefer an existing sub_folder within the chosen top_folder when one fits.

- artist: clean source attribution.
  - music   -> artist (e.g., "Daft Punk"). Extract from title; fall back to channel. Strip "Official", "VEVO", "Records".
  - podcast -> host or show name (e.g., "Andrew Huberman").
  - spoken  -> speaker name (e.g., "Andrej Karpathy") or institution.
  - other   -> descriptive source (e.g., "Splice Sounds", channel name).

- title: clean content title. Strip "(Official Video)", "[HD]", "(Lyric Video)", "| Free Download", bracketed genre tags, etc. For podcasts, keep the episode subject but drop the show name + "Ep. N -" prefix (the show is captured in sub_folder).

- id3_genre: human-readable genre string for the ID3 TCON tag.
  - music   -> actual genre (e.g., "Deep House", "Tech House", "Drum & Bass").
  - podcast -> "Podcast".
  - spoken  -> "Spoken Word".
  - other   -> descriptive (e.g., "Sound Effects", "Ambient").

Be CONSERVATIVE about creating new top_folders and music sub_folders. The goal is a tidy library. When in doubt, reuse the closest existing one.

Respond with ONLY a JSON object, no prose, no codefences."""

CONTENT_TYPES = {"music", "podcast", "spoken", "other"}
FORCED_TOP_BY_TYPE = {"podcast": "podcasts", "spoken": "spoken", "other": "other"}
DEFAULT_ID3_BY_TYPE = {"podcast": "Podcast", "spoken": "Spoken Word"}


def build_categorize_prompt(info: dict, folders: list[dict]) -> str:
    desc = (info.get("description") or "")[:2000]
    tags = info.get("tags") or []
    return (
        f"Title: {info.get('title')}\n"
        f"Channel: {info.get('uploader')}\n"
        f"Duration: {info.get('duration')}s\n"
        f"Tags: {tags[:20]}\n"
        f"Categories: {info.get('categories') or []}\n"
        f"Description (first 2000 chars):\n{desc}\n\n"
        f"Existing folders:\n{json.dumps(folders, indent=2)}"
    )


def _parse_json_response(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def _categorize_anthropic(user_msg: str, model: str, key: str | None) -> dict:
    if not key:
        raise HTTPException(500, "Anthropic API key missing — set anthropic_api_key in ~/.ytd_dj/config.json")
    client = Anthropic(api_key=key)
    resp = client.messages.create(
        model=model,
        max_tokens=500,
        system=[
            {
                "type": "text",
                "text": get_categorize_prompt(),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_msg}],
    )
    return _parse_json_response(resp.content[0].text)


def _categorize_openai(user_msg: str, model: str, key: str | None) -> dict:
    if not key:
        raise HTTPException(500, "OpenAI API key missing — set openai_api_key in ~/.ytd_dj/config.json")
    try:
        from openai import OpenAI
    except ImportError:
        raise HTTPException(500, "openai package not installed. Run: pip install -r helper/requirements.txt")
    client = OpenAI(api_key=key)
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": get_categorize_prompt()},
            {"role": "user", "content": user_msg},
        ],
        response_format={"type": "json_object"},
        max_completion_tokens=500,
    )
    return _parse_json_response(resp.choices[0].message.content)


def _categorize_ollama(user_msg: str, model: str, base_url: str | None) -> dict:
    url = (base_url or DEFAULT_OLLAMA_URL).rstrip("/") + "/api/chat"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": get_categorize_prompt()},
            {"role": "user", "content": user_msg},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8")[:200]
        except Exception:
            pass
        raise HTTPException(500, f"Ollama HTTP {e.code} from {url}: {body or e.reason}")
    except urllib.error.URLError as e:
        raise HTTPException(500, f"Ollama unreachable at {url}: {e}")
    text = (data.get("message") or {}).get("content") or ""
    if not text.strip():
        raise HTTPException(500, "Ollama returned empty response")
    return _parse_json_response(text)


def categorize(info: dict, folders: list[dict], model_override: str | None = None) -> dict:
    cfg = read_config()
    user_msg = build_categorize_prompt(info, folders)
    model = (model_override or cfg["model"]).strip() if (model_override or cfg["model"]) else cfg["model"]
    if cfg["provider"] == "openai":
        return _categorize_openai(user_msg, model, cfg["openai_api_key"])
    if cfg["provider"] == "ollama":
        return _categorize_ollama(user_msg, model, cfg["ollama_url"])
    return _categorize_anthropic(user_msg, model, cfg["anthropic_api_key"])


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
    cfg = read_config()
    needs_key = cfg["provider"] in {"anthropic", "openai"}
    return {
        "ok": True,
        "version": VERSION,
        "audio_root": str(audio_root()),
        "video_root": str(video_root()),
        "yt_dlp": shutil.which("yt-dlp") or "python module",
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "provider": cfg["provider"],
        "model": cfg["model"],
        "has_api_key": (not needs_key) or bool(active_api_key(cfg)),
    }


@app.get("/config")
def get_config():
    raw = _parse_config_file()
    cfg = read_config()
    return {
        "audio_root": str(audio_root()),
        "video_root": str(video_root()),
        "provider": cfg["provider"],
        "model": cfg["model"],
        "has_anthropic_key": bool(cfg["anthropic_api_key"]),
        "has_openai_key": bool(cfg["openai_api_key"]),
        "ollama_url": cfg["ollama_url"],
        "default_ollama_url": DEFAULT_OLLAMA_URL,
        "categorize_prompt": raw.get("categorize_prompt") or "",
        "default_prompt": CATEGORIZE_SYSTEM,
        "supported_providers": sorted(SUPPORTED_PROVIDERS),
        "default_models": DEFAULT_MODEL_BY_PROVIDER,
        "active_prompt_is_default": not bool(raw.get("categorize_prompt", "").strip())
        if isinstance(raw.get("categorize_prompt"), str)
        else True,
    }


@app.put("/config")
def put_config(req: ConfigUpdate):
    updates = req.model_dump(exclude_unset=True)

    if "provider" in updates and updates["provider"]:
        if updates["provider"].lower() not in SUPPORTED_PROVIDERS:
            raise HTTPException(400, f"Unsupported provider: {updates['provider']}")
        updates["provider"] = updates["provider"].lower()

    for k in ("audio_root", "video_root"):
        if k in updates and updates[k]:
            try:
                p = Path(updates[k]).expanduser()
                p.mkdir(parents=True, exist_ok=True)
                updates[k] = str(p)
            except (OSError, RuntimeError) as e:
                raise HTTPException(400, f"Cannot use {k}={updates[k]}: {e}")

    raw = _parse_config_file()
    if not isinstance(raw, dict):
        raw = {}

    for key, value in updates.items():
        upper = key.upper()
        if value in (None, ""):
            raw.pop(key, None)
            raw.pop(upper, None)
        else:
            raw[key] = value
            raw.pop(upper, None)

    CONFIG_DIR.mkdir(exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(raw, indent=2))
    return {"ok": True}


@app.post("/test-key")
def test_key(req: TestKeyRequest):
    provider = req.provider.lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(400, f"Unsupported provider: {provider}")

    cfg = read_config()

    if provider == "ollama":
        url = (req.url or cfg["ollama_url"] or DEFAULT_OLLAMA_URL).rstrip("/")
        try:
            with urllib.request.urlopen(url + "/api/tags", timeout=4) as r:
                data = json.loads(r.read().decode("utf-8"))
            models = [m.get("name") for m in data.get("models", []) if m.get("name")]
            return {"ok": True, "models": models[:50]}
        except Exception as e:
            return {"ok": False, "error": str(e)[:300]}

    actual_key = (req.key or "").strip() or (
        cfg["openai_api_key"] if provider == "openai" else cfg["anthropic_api_key"]
    )
    if not actual_key:
        return {"ok": False, "error": "No key provided or configured."}

    try:
        if provider == "anthropic":
            client = Anthropic(api_key=actual_key)
            client.messages.create(
                model=DEFAULT_MODEL_BY_PROVIDER["anthropic"],
                max_tokens=5,
                messages=[{"role": "user", "content": "ok"}],
            )
        else:
            from openai import OpenAI
            client = OpenAI(api_key=actual_key)
            client.chat.completions.create(
                model=DEFAULT_MODEL_BY_PROVIDER["openai"],
                max_completion_tokens=5,
                messages=[{"role": "user", "content": "ok"}],
            )
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


@app.get("/version")
def version_info():
    latest = None
    error = None
    try:
        req = urllib.request.Request(
            REMOTE_VERSION_URL, headers={"User-Agent": "YTD_DJ-Helper"}
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            latest = r.read().decode().strip()
    except Exception as e:
        error = str(e)
    return {
        "local": VERSION,
        "latest": latest,
        "update_available": bool(latest) and latest != VERSION,
        "error": error,
    }


@app.post("/update")
def update():
    repo_root = Path(__file__).resolve().parent.parent
    if not (repo_root / ".git").exists():
        raise HTTPException(
            400,
            f"Not a git checkout at {repo_root}. Pull updates manually.",
        )
    try:
        before = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"], text=True
        ).strip()
        subprocess.run(
            ["git", "-C", str(repo_root), "fetch", "--quiet"],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["git", "-C", str(repo_root), "pull", "--ff-only", "--quiet"],
            check=True, capture_output=True, text=True,
        )
        after = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"], text=True
        ).strip()
    except subprocess.CalledProcessError as e:
        msg = (e.stderr or e.stdout or str(e)).strip()
        raise HTTPException(500, f"git failed: {msg}")

    updated = before != after
    if updated:
        def deferred_exit():
            time.sleep(1)
            os._exit(0)
        threading.Thread(target=deferred_exit, daemon=True).start()

    return {
        "ok": True,
        "updated": updated,
        "before": before[:7],
        "after": after[:7],
        "will_restart": updated,
    }


@app.post("/download")
def download(req: DownloadRequest):
    roots = get_roots()
    kind = req.kind if req.kind in roots else "audio"
    base_root = roots[kind]

    if not shutil.which("ffmpeg"):
        raise HTTPException(500, "ffmpeg not found. Run: brew install ffmpeg")

    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
            info = ydl.extract_info(req.url, download=False)
    except Exception as e:
        raise HTTPException(400, f"yt-dlp metadata failed: {e}")

    try:
        decision = categorize(info, list_folders(base_root), model_override=req.model)
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"AI returned invalid JSON: {e}")

    content_type = str(decision.get("content_type") or "music").lower()
    if content_type not in CONTENT_TYPES:
        content_type = "music"

    if content_type in FORCED_TOP_BY_TYPE:
        top = FORCED_TOP_BY_TYPE[content_type]
    else:
        top = slugify(decision.get("top_folder"), "unsorted")
    sub = slugify(decision.get("sub_folder"), "general")
    artist = safe_filename(decision.get("artist"), "Unknown Artist")
    title = safe_filename(decision.get("title"), info.get("title") or "untitled")
    id3_genre = (
        decision.get("id3_genre")
        or DEFAULT_ID3_BY_TYPE.get(content_type)
        or sub.replace("-", " ").title()
    )

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

    rel_path = str(final_path.relative_to(base_root))
    video_id = extract_video_id(req.url) or info.get("id")
    record_download(video_id, kind, rel_path)
    try:
        db_upsert_file(
            kind, rel_path,
            source_url=req.url,
            video_id=video_id,
            title=title,
            artist=artist,
            content_type=content_type,
            duration_sec=float(info["duration"]) if info.get("duration") else None,
        )
    except Exception as e:
        print(f"DB upsert failed (non-fatal): {e}", file=sys.stderr)

    return {
        "success": True,
        "kind": kind,
        "content_type": content_type,
        "path": str(final_path),
        "rel_path": rel_path,
        "top_folder": top,
        "sub_folder": sub,
        "folder": f"{top}/{sub}",
        "artist": artist,
        "title": title,
        "id3_genre": id3_genre,
        "source_url": req.url,
        "model_used": req.model or None,
    }


@app.get("/check")
def check(url: str = Query(...)):
    vid = extract_video_id(url)
    result = {"video_id": vid, "audio": None, "video": None}
    if not vid:
        return result
    hist = read_history()
    entry = hist.get(vid, {})
    if not entry:
        return result

    pruned = dict(entry)
    for kind, root in get_roots().items():
        rel = entry.get(kind)
        if rel and (root / rel).exists():
            result[kind] = rel
        elif rel:
            pruned.pop(kind, None)

    if pruned != entry:
        if pruned:
            hist[vid] = pruned
        else:
            hist.pop(vid, None)
        write_history(hist)
    return result


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

    # Preload DB state for all files in this root so we can attach per-file
    # playback metadata without N round-trips.
    state_by_path: dict[str, dict] = {}
    try:
        with closing(db_connect()) as conn:
            for r in conn.execute(
                """
                SELECT f.rel_path, f.duration_sec, f.title, f.artist,
                       p.position_sec, p.completed, p.last_played_at
                FROM files f LEFT JOIN playback p ON p.file_id = f.id
                WHERE f.root = ?
                """,
                (root,),
            ).fetchall():
                state_by_path[r["rel_path"]] = {
                    "duration_sec": r["duration_sec"],
                    "title": r["title"],
                    "artist": r["artist"],
                    "position_sec": (r["position_sec"] if r["position_sec"] is not None else 0) or 0,
                    "completed": bool(r["completed"]),
                    "last_played_at": r["last_played_at"],
                }
    except Exception as e:
        print(f"DB join in /browse failed (non-fatal): {e}", file=sys.stderr)

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
            entry = {
                "name": child.name,
                "stem": child.stem,
                "rel_path": rel,
                "size_bytes": child.stat().st_size,
                "ext": ext,
            }
            state = state_by_path.get(rel)
            if state:
                entry["playback"] = {
                    "position_sec": state["position_sec"],
                    "completed": state["completed"],
                    "duration_sec": state["duration_sec"],
                    "last_played_at": state["last_played_at"],
                }
                if state["title"]:
                    entry["title"] = state["title"]
                if state["artist"]:
                    entry["artist"] = state["artist"]
            files.append(entry)
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
    hist = read_history()
    changed = False
    for vid, entry in list(hist.items()):
        if entry.get(root) == path:
            entry.pop(root, None)
            changed = True
            if not entry:
                hist.pop(vid)
    if changed:
        write_history(hist)
    try:
        db_delete_file(root, path)
    except Exception as e:
        print(f"DB delete failed (non-fatal): {e}", file=sys.stderr)
    return {"ok": True, "deleted": str(target)}


@app.get("/db/file")
def db_file_endpoint(root: str = Query(...), path: str = Query(...)):
    if root not in get_roots():
        raise HTTPException(400, f"Invalid root: {root}")
    target = safe_path(root, path)
    record = db_get_file(root, path)
    if record is None:
        if not target.exists():
            raise HTTPException(404, "File not found")
        db_upsert_file(root, path)
        record = db_get_file(root, path)
    return record


@app.post("/db/position")
def db_position_endpoint(req: PositionUpdate):
    if req.root not in get_roots():
        raise HTTPException(400, f"Invalid root: {req.root}")
    db_update_position(req.root, req.path, req.position_sec, req.duration_sec)
    return {"ok": True}


@app.post("/db/completed")
def db_completed_endpoint(req: CompletedUpdate):
    if req.root not in get_roots():
        raise HTTPException(400, f"Invalid root: {req.root}")
    db_mark_completed(req.root, req.path, req.completed)
    return {"ok": True}


@app.get("/db/continue")
def db_continue_endpoint(root: str = Query("audio"), limit: int = Query(20, ge=1, le=200)):
    if root not in get_roots():
        raise HTTPException(400, f"Invalid root: {root}")
    return {"items": db_continue_listening(root, limit)}


@app.post("/db/backfill")
def db_backfill_endpoint():
    added = db_backfill_from_disk()
    return {"ok": True, "added": added}


@app.post("/file/rename")
def rename_file(req: RenameRequest):
    if "/" in req.new_name or "\\" in req.new_name or req.new_name.startswith("."):
        raise HTTPException(400, "Name may not contain path separators or start with a dot")
    old = safe_path(req.root, req.old_path)
    if not old.is_file():
        raise HTTPException(404, "File not found")

    clean = NAME_CHARS.sub("", req.new_name).strip()
    if not clean:
        raise HTTPException(400, "Name is empty after sanitization")
    if "." not in clean:
        clean = clean + old.suffix
    new_target = old.parent / clean
    if new_target.exists() and new_target != old:
        raise HTTPException(409, f"A file named '{clean}' already exists here")

    old.rename(new_target)
    new_rel = str(new_target.relative_to(root_for(req.root)))
    try:
        db_update_path(req.root, req.old_path, new_rel)
        history_update_path(req.root, req.old_path, new_rel)
    except Exception as e:
        print(f"DB/history update after rename failed (non-fatal): {e}", file=sys.stderr)
    return {"ok": True, "new_path": new_rel}


@app.post("/file/move")
def move_file_endpoint(req: MoveRequest):
    old = safe_path(req.root, req.old_path)
    if not old.is_file():
        raise HTTPException(404, "File not found")

    base = root_for(req.root)
    raw_dir = (req.new_dir or "").strip("/")
    if raw_dir:
        new_dir = safe_path(req.root, raw_dir)
        new_dir.mkdir(parents=True, exist_ok=True)
    else:
        new_dir = base

    new_target = new_dir / old.name
    if new_target.exists() and new_target != old:
        raise HTTPException(409, f"A file named '{old.name}' already exists at {raw_dir or '/'}")

    if new_target == old:
        return {"ok": True, "new_path": req.old_path, "moved": False}

    shutil.move(str(old), str(new_target))
    new_rel = str(new_target.relative_to(base))
    try:
        db_update_path(req.root, req.old_path, new_rel)
        history_update_path(req.root, req.old_path, new_rel)
    except Exception as e:
        print(f"DB/history update after move failed (non-fatal): {e}", file=sys.stderr)
    return {"ok": True, "new_path": new_rel, "moved": True}


@app.post("/folder/create")
def create_folder(req: CreateFolderRequest):
    target = safe_path(req.root, req.path)
    if target.exists() and target.is_dir():
        return {"ok": True, "existed": True, "path": req.path}
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "existed": False, "path": req.path}


@app.post("/file/reclassify")
def reclassify(req: ReclassifyRequest):
    old = safe_path(req.root, req.path)
    if not old.is_file():
        raise HTTPException(404, "File not found")

    record = db_get_file(req.root, req.path)
    if not record or not record.get("source_url"):
        raise HTTPException(400, "No source URL recorded for this file — cannot reclassify")

    source_url = record["source_url"]
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
            info = ydl.extract_info(source_url, download=False)
    except Exception as e:
        raise HTTPException(400, f"yt-dlp failed: {e}")

    base_root = root_for(req.root)
    try:
        decision = categorize(info, list_folders(base_root))
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"AI returned invalid JSON: {e}")

    content_type = str(decision.get("content_type") or "music").lower()
    if content_type not in CONTENT_TYPES:
        content_type = "music"
    if content_type in FORCED_TOP_BY_TYPE:
        top = FORCED_TOP_BY_TYPE[content_type]
    else:
        top = slugify(decision.get("top_folder"), "unsorted")
    sub = slugify(decision.get("sub_folder"), "general")

    new_dir = base_root / top / sub
    new_dir.mkdir(parents=True, exist_ok=True)
    new_target = new_dir / old.name

    if new_target == old:
        try:
            db_update_content_type(req.root, req.path, content_type)
        except Exception as e:
            print(f"DB content_type update failed (non-fatal): {e}", file=sys.stderr)
        return {
            "ok": True,
            "moved": False,
            "folder": f"{top}/{sub}",
            "content_type": content_type,
            "new_path": req.path,
        }

    counter = 1
    while new_target.exists():
        new_target = new_dir / f"{old.stem} ({counter}){old.suffix}"
        counter += 1

    shutil.move(str(old), str(new_target))
    new_rel = str(new_target.relative_to(base_root))
    try:
        db_update_path(req.root, req.path, new_rel)
        db_update_content_type(req.root, new_rel, content_type)
        history_update_path(req.root, req.path, new_rel)
    except Exception as e:
        print(f"DB/history update after reclassify failed (non-fatal): {e}", file=sys.stderr)

    return {
        "ok": True,
        "moved": True,
        "new_path": new_rel,
        "folder": f"{top}/{sub}",
        "content_type": content_type,
    }


@app.get("/folders")
def list_all_folders(root: str = Query(...)):
    """Flat list of every directory under the given root, for move-to pickers."""
    base = root_for(root)
    out = []
    for child in base.rglob("*"):
        if child.is_dir() and not child.name.startswith("."):
            out.append(str(child.relative_to(base)))
    out.sort()
    return {"root": root, "folders": out}


try:
    db_init()
    _added = db_backfill_from_disk()
    if _added:
        print(f"DB backfilled {_added} file(s) from disk", file=sys.stderr)
except Exception as _e:
    print(f"DB init/backfill failed (non-fatal): {_e}", file=sys.stderr)


if __name__ == "__main__":
    import uvicorn

    print(f"YTD_DJ helper {VERSION} starting on http://127.0.0.1:{PORT}")
    print(f"Audio library: {audio_root()}")
    print(f"Video library: {video_root()}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
