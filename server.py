"""
TM LiveSync — Real-time Trackmania 2020 Skin Previewer
Backend server: static file serving + file watching + WebSocket broadcasting.
"""

import argparse
import asyncio
import json
import os
import time
import webbrowser
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from PIL import Image
import io

# ---------------------------------------------------------------------------
# Configuration & PyInstaller Support
# ---------------------------------------------------------------------------
import sys

if getattr(sys, 'frozen', False):
    # Running as compiled executable
    BUNDLE_DIR = Path(sys._MEIPASS)
    # The folder where the user placed the .exe
    USER_DIR = Path(sys.executable).parent
else:
    # Running as a normal Python script
    BUNDLE_DIR = Path(__file__).resolve().parent
    USER_DIR = BUNDLE_DIR

STATIC_DIR = BUNDLE_DIR / "static"
ASSETS_DIR = BUNDLE_DIR / "assets"

# The skins folder will always be next to the executable (or script)
DEFAULT_SKINS_DIR = USER_DIR / "skin"

# Create the skins folder automatically if it doesn't exist
DEFAULT_SKINS_DIR.mkdir(parents=True, exist_ok=True)

# Texture files we care about — match any Trackmania texture group + channel
# Pattern: {Group}_{Channel}.{dds|png}
import re
WATCHED_RE = re.compile(
    r'^(skin|details|wheels|glass)_(b|r|n|i|ao|dirtmask|d)\.(dds|png)$',
    re.IGNORECASE,
)

DEBOUNCE_SECONDS = 0.5

# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------
class ConnectionManager:
    """Manages active WebSocket connections."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"[WS] Client connected  ({len(self.active_connections)} total)")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        print(f"[WS] Client disconnected ({len(self.active_connections)} total)")

    async def broadcast(self, message: dict):
        """Send a JSON message to every connected client."""
        data = json.dumps(message)
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(data)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.active_connections.remove(conn)


manager = ConnectionManager()

# ---------------------------------------------------------------------------
# File-system watcher (watchdog)
# ---------------------------------------------------------------------------
class SkinFileHandler(FileSystemEventHandler):
    """Watches for Trackmania skin texture saves and broadcasts via WebSocket."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self._loop = loop
        self._last_trigger: dict[str, float] = {}
        self._pending: dict[str, asyncio.TimerHandle] = {}

    def _schedule_broadcast(self, filepath: str, filename: str):
        """Schedule a delayed broadcast, cancelling any pending one for the same file."""
        key = filename.lower()

        # Cancel any pending broadcast for this file
        if key in self._pending:
            self._pending[key].cancel()

        # Schedule broadcast after a delay to let the file finish writing
        async def delayed_broadcast():
            # Wait for file to be stable (not being written to)
            await self._wait_for_stable(filepath)

            now = time.time()
            print(f"[WATCH] Broadcasting: {filename}")
            await manager.broadcast({
                "event": "update_texture",
                "file": filename,
                "timestamp": int(now * 1000),
            })

        handle = asyncio.run_coroutine_threadsafe(delayed_broadcast(), self._loop)
        self._pending[key] = handle

    @staticmethod
    async def _wait_for_stable(filepath: str, checks: int = 3, interval: float = 0.3):
        """Wait until a file's size stops changing (i.e., it's fully written)."""
        last_size = -1
        stable_count = 0
        for _ in range(checks + 5):  # max attempts
            try:
                size = os.path.getsize(filepath)
                if size == last_size and size > 0:
                    stable_count += 1
                    if stable_count >= checks:
                        return  # file is stable
                else:
                    stable_count = 0
                last_size = size
            except OSError:
                stable_count = 0
            await asyncio.sleep(interval)

    def on_modified(self, event):
        if event.is_directory:
            return
        filename = os.path.basename(event.src_path)
        if not WATCHED_RE.match(filename):
            return

        now = time.time()
        last = self._last_trigger.get(filename.lower(), 0)
        if now - last < DEBOUNCE_SECONDS:
            return  # debounce — skip rapid duplicate events
        self._last_trigger[filename.lower()] = now

        print(f"[WATCH] Detected change: {event.src_path}")
        self._schedule_broadcast(event.src_path, filename)

    def on_created(self, event):
        """Some editors (e.g. GIMP) write to a temp file then rename — treat creates like modifies."""
        self.on_modified(event)


# ---------------------------------------------------------------------------
# App lifespan — start/stop the file watcher
# ---------------------------------------------------------------------------
observer: Observer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global observer
    loop = asyncio.get_running_loop()
    watch_dir = app.state.watch_dir

    # Ensure the watch directory exists
    os.makedirs(watch_dir, exist_ok=True)

    handler = SkinFileHandler(loop)
    observer = Observer()
    observer.schedule(handler, str(watch_dir), recursive=False)
    observer.start()
    print(f"[WATCH] Monitoring: {watch_dir}")
    print(f"[WATCH] Patterns:   {{Group}}_{{Channel}}.{{dds|png}}")

    yield  # app is running

    observer.stop()
    observer.join()
    print("[WATCH] Stopped.")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------
app = FastAPI(title="TM LiveSync", lifespan=lifespan)


# --- WebSocket endpoint ---------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection alive; we don't expect client-to-server messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# --- List available skin textures -----------------------------------------
@app.get("/api/textures")
async def list_textures():
    """Return a list of all texture files in the skins directory."""
    watch_dir = Path(app.state.watch_dir)
    files = []
    if watch_dir.is_dir():
        for f in watch_dir.iterdir():
            if f.is_file() and WATCHED_RE.match(f.name):
                files.append(f.name)
    return {"files": sorted(files)}


# --- Serve skin textures from the watch directory -------------------------
@app.get("/skin/{filepath:path}")
async def serve_skin(filepath: str):
    """Serve texture files from the watched skin directory.
    DDS files are converted to PNG on-the-fly using Pillow, so the browser
    always receives a standard image format it can decode natively.
    """
    file_path = Path(app.state.watch_dir) / filepath
    if not file_path.is_file():
        return {"error": "File not found"}, 404

    no_cache_headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }

    suffix = file_path.suffix.lower()
    if suffix == ".dds":
        # Convert DDS → PNG on the fly
        try:
            img = Image.open(file_path)
            # DDS uses bottom-left origin; flip to match GLTF's top-left UVs
            img = img.transpose(Image.FLIP_TOP_BOTTOM)
            
            fname_lower = file_path.name.lower()

            # Trackmania _R maps use Red=Roughness, Green=Metalness.
            # Three.js (glTF) expects Green=Roughness, Blue=Metalness.
            if fname_lower.endswith("_r.dds"):
                # Force to RGB first to ensure we have exactly 3 bands to work with
                img = img.convert("RGB")
                r, g, b = img.split()
                # Mapping: TM Red(Rough) -> glTF Green, TM Green(Metal) -> glTF Blue
                black = Image.new('L', img.size, 0)
                img = Image.merge("RGB", (black, r, g))
            
            # For everything else (except glass), discard alpha to prevent transparency/glow bugs
            elif not fname_lower.startswith("glass"):
                img = img.convert("RGB")

            # Final check: for emissive maps, we definitely want no alpha
            if "_i.dds" in fname_lower:
                img = img.convert("RGB")

            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="image/png",
                headers=no_cache_headers,
            )
        except Exception as e:
            print(f"[ERROR] Failed to convert {filepath}: {e}")
            return {"error": f"Failed to convert DDS: {e}"}, 500
    else:
        return FileResponse(
            file_path,
            media_type="image/png",
            headers=no_cache_headers,
        )


# --- Serve the 3D car model assets ---------------------------------------
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

# --- Serve the frontend (must be last so it doesn't shadow other routes) --
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="TM LiveSync — Real-time Trackmania Skin Previewer")
    parser.add_argument(
        "--watch", "-w",
        type=str,
        default=str(DEFAULT_SKINS_DIR),
        help=f"Directory to watch for texture changes (default: {DEFAULT_SKINS_DIR})",
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=8080,
        help="Port to serve on (default: 8080)",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Don't auto-open the browser",
    )
    args = parser.parse_args()

    # Store the watch directory on the app for access in lifespan
    app.state.watch_dir = Path(args.watch).resolve()

    print(r"""
  _____ __  __   _     _          ____                   
 |_   _|  \/  | | |   (_)_   ____|  ___| _   _ _ __   ___ 
   | | | |\/| | | |   | \ \ / / _ \\___ \| | | | '_ \ / __|
   | | | |  | | | |___| |\ V /  __/ ___) | |_| | | | | (__ 
   |_| |_|  |_| |_____|_| \_/ \___|____/ \__, |_| |_|\___|
                                          |___/            
    """)
    print(f"  Watching:  {app.state.watch_dir}")
    print(f"  Viewer:    http://localhost:{args.port}")
    print(f"  WebSocket: ws://localhost:{args.port}/ws")
    print()

    if not args.no_open:
        import threading
        threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{args.port}")).start()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
