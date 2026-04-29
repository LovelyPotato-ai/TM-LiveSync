# TM LiveSync

Real-time Trackmania 2020 skin previewer. Edit your skin textures in Photoshop/GIMP and see changes instantly in a 3D web viewer — no game launch required.

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Launch the server
python server.py

# 3. The viewer opens at http://localhost:8080
#    Edit any Skin_B/R/N/I .png or .dds file in the ./skins/ folder
#    and watch it update live in the browser.
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--watch`, `-w` | `./skins/` | Directory to monitor for texture changes |
| `--port`, `-p` | `8080` | Port for the web server |
| `--no-open` | — | Don't auto-open the browser |

### Examples

```bash
# Watch a custom directory
python server.py --watch "C:\Users\Me\Documents\Trackmania\Skins\MySkin"

# Use a different port
python server.py --port 3000
```

## Watched Files

The watcher detects saves to these files (case-insensitive):

| File | Channel | Description |
|------|---------|-------------|
| `Skin_B.dds` / `.png` | Base color | Main car body paint |
| `Skin_R.dds` / `.png` | Roughness | Metallic/roughness map |
| `Skin_N.dds` / `.png` | Normal | Surface detail bumps |
| `Skin_I.dds` / `.png` | Illumination | Glow/emissive areas |

## How It Works

1. Python backend (FastAPI) serves the 3D viewer and watches your texture folder
2. `watchdog` detects file saves with 500ms debounce (handles Photoshop's multi-write behavior)
3. A WebSocket pushes an update event to the browser
4. Three.js reloads the texture with cache-busting and applies it to the car mesh instantly

## 3D Model Credit

This work uses "trackmania 2020 carsport" by amogusstrikesback2 (https://sketchfab.com/amogusstrikesback2) licensed under CC-BY-4.0.
