# TM LiveSync

Real-time Trackmania 2020 skin previewer. Edit your skin textures in Photoshop/GIMP and see changes instantly in a 3D web viewer — no game launch required.

# How to Setup:

Head to the releases and download the latest version.

Or you can compile it yourself, it's open source:)

## How It Works

1. A python backend erves the 3D viewer and watches your texture folder
2. `watchdog` detects file saves with 500ms debounce (handles Photoshop's multi-write behavior)
3. A WebSocket pushes an update event to the browser
4. Three.js reloads the texture with cache-busting and applies it to the car mesh instantly

## 3D Model Credit

This work uses "trackmania 2020 carsport" by amogusstrikesback2 (https://sketchfab.com/amogusstrikesback2) licensed under CC-BY-4.0.
