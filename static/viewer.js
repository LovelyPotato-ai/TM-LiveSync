/**
 * TM LiveSync — Three.js 3D Viewer
 * Loads the Trackmania car model, applies skin textures,
 * and live-reloads them via WebSocket notifications.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ── DOM refs ───────────────────────────────────────────────────────
const canvas = document.getElementById('viewer-canvas');
const statusBar = document.getElementById('status-bar');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const lastUpdateEl = document.getElementById('last-update');
const lastFileEl = document.getElementById('last-file');
const updateCountEl = document.getElementById('update-count');
const reloadFlash = document.getElementById('reload-flash');
const loadingScreen = document.getElementById('loading-screen');
const updateIndicator = document.getElementById('update-indicator');
const helpBtn = document.getElementById('help-btn');
const closeHelpBtn = document.getElementById('close-help-btn');
const helpModal = document.getElementById('help-modal');

// ── State ──────────────────────────────────────────────────────────
let updateCount = 0;
let loadingCount = 0;

// Mesh groups by material name — each group gets its own texture updates
const meshGroups = {
    skin: [],
    details: [],
    wheels: [],
    glass: [],
};

// ── Renderer ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.outputColorSpace = THREE.SRGBColorSpace;


// ── Scene ──────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);

// Subtle environment gradient
scene.fog = new THREE.FogExp2(0x0a0a0f, 0.0015);

// ── Camera ─────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
    40,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
);
camera.position.set(3, 1.8, 4);

// ── Post-processing (Bloom) ────────────────────────────────────────
// Use a multisampled render target to fix jagged edges/sparks (MSAA)
const renderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    {
        samples: 4, // 4x MSAA
        type: THREE.HalfFloatType // HDR precision
    }
);

const composer = new EffectComposer(renderer, renderTarget);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.25,  // strength — intensity of the glow (lowered from 0.6)
    0.4,   // radius — how far the glow spreads
    0.85   // threshold — only pixels brighter than this bloom
);
composer.addPass(bloomPass);

// OutputPass applies tone mapping + color space after bloom
const outputPass = new OutputPass();
composer.addPass(outputPass);

// ── Controls ───────────────────────────────────────────────────────
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 1.5;
controls.maxDistance = 15;
controls.target.set(0, 0.4, 0);
controls.maxPolarAngle = Math.PI * 0.85;
controls.update();

// ── Lighting & Environment (High-Contrast Outdoor) ────────────────
// Metallic car paint requires high-contrast reflections to avoid looking flat.
// We build a custom scene to generate a perfect outdoor HDRI (round sun, horizon, sky)
// to get beautiful reflections without any "square" light artifacts.

const pmremScene = new THREE.Scene();
pmremScene.background = new THREE.Color(0x555555); // Brighter sky for ambient reflections

// Horizon / Ground (darker to anchor the reflections)
const envGround = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshBasicMaterial({ color: 0x333333 }) // Brighter ground reflections
);
envGround.rotation.x = -Math.PI / 2;
pmremScene.add(envGround);

// A large, round "Sun" for a smooth, circular specular reflection (not a square)
const sun = new THREE.Mesh(
    new THREE.SphereGeometry(15, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff }) // Pure white sun
);
sun.position.set(40, 50, 40);
pmremScene.add(sun);

// Generate the high-fidelity environment map
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
scene.environment = pmremGenerator.fromScene(pmremScene).texture;
scene.environmentIntensity = 1.0; // Reduced to balance the brighter sky

// Add a soft hemisphere light to fill in pitch-black shadows
// Reverted intensity to prevent diffuse white parts from glowing
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x888888, 1.0);
scene.add(hemiLight);

// Add a subtle directional light just for casting shadows and providing form
const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
keyLight.position.set(5, 8, 4);
scene.add(keyLight);

// Ground plane (subtle reflective surface)
const groundGeo = new THREE.PlaneGeometry(50, 50);
const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0f,
    roughness: 0.8,
    metalness: 0.2,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

// ── Grid helper (subtle) ──────────────────────────────────────────
const grid = new THREE.GridHelper(20, 40, 0x1a1a2e, 0x111118);
grid.position.y = 0;
scene.add(grid);

// ── Load 3D model ─────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();
const MODEL_PATH = '/assets/car_model/scene.gltf';

gltfLoader.load(
    MODEL_PATH,
    (gltf) => {
        const model = gltf.scene;

        // Auto-center and scale the model
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 2.5 / maxDim;
        model.scale.setScalar(scale);

        // Re-center after scaling
        box.setFromObject(model);
        box.getCenter(center);
        model.position.sub(center);
        model.position.y += (size.y * scale) / 2;

        // Find and group meshes by material name
        model.traverse((child) => {
            if (child.isMesh && child.material) {
                const matName = child.material.name?.toLowerCase() || '';
                if (matName.includes('skin')) meshGroups.skin.push(child);
                if (matName.includes('details')) meshGroups.details.push(child);
                if (matName.includes('wheels')) meshGroups.wheels.push(child);
                if (matName.includes('glass')) meshGroups.glass.push(child);
            }
        });

        scene.add(model);

        // Update orbit target to model center
        controls.target.set(0, (size.y * scale) / 2, 0);
        controls.update();

        console.log(`[TM LiveSync] Model loaded — skin: ${meshGroups.skin.length}, details: ${meshGroups.details.length}, wheels: ${meshGroups.wheels.length}, glass: ${meshGroups.glass.length}`);

        // Auto-load all existing textures from the skins folder
        loadInitialTextures().then(() => {
            // Hide loading screen after all textures are loaded
            loadingScreen.classList.add('hidden');
        });
    },
    (progress) => {
        if (progress.total) {
            const pct = Math.round((progress.loaded / progress.total) * 100);
            loadingScreen.querySelector('p').textContent = `Loading model… ${pct}%`;
        }
    },
    (error) => {
        console.error('[TM LiveSync] Failed to load model:', error);
        loadingScreen.querySelector('p').textContent = 'Failed to load model';
    }
);

// ── Texture reload system ─────────────────────────────────────────
// The server converts DDS → PNG on the fly, so we only need TextureLoader.
const textureLoader = new THREE.TextureLoader();

/**
 * Determine which material property (slot) and which mesh group
 * a texture file maps to, based on its filename.
 *
 * Trackmania naming convention:
 *   {Group}_{Channel}.dds
 *   e.g. Skin_B.dds, Details_R.dds, Wheels_N.dds
 *
 * Channels:
 *   _B  → baseColorMap  ("map" in Three.js)
 *   _R  → metallicRoughnessMap  ("metalnessMap" + "roughnessMap")
 *   _N  → normalMap
 *   _I  → emissiveMap
 *   _AO → aoMap (ambient occlusion)
 */
function parseTextureFile(filename) {
    const f = filename.toLowerCase();

    // Determine mesh group
    let group = null;
    if (f.startsWith('skin')) group = 'skin';
    else if (f.startsWith('details')) group = 'details';
    else if (f.startsWith('wheels')) group = 'wheels';
    else if (f.startsWith('glass')) group = 'glass';
    if (!group) return null;

    // Determine material slot from channel suffix
    let slot = null;
    if (/_b\./.test(f)) slot = 'map';
    else if (/_r\./.test(f)) slot = 'roughnessMap';
    else if (/_n\./.test(f)) slot = 'normalMap';
    else if (/_i\./.test(f)) slot = 'emissiveMap';
    else if (/_ao\./.test(f)) slot = 'aoMap';
    if (!slot) return null;

    return { group, slot };
}

/**
 * Apply a loaded texture to the correct mesh group and material slot.
 */
function applyTextureToMeshes(texture, targetMeshes, slot) {
    targetMeshes.forEach((mesh) => {
        if (!mesh.material) return;

        // Dispose the old texture to free GPU memory and prevent stale caching
        const oldTexture = mesh.material[slot];
        if (oldTexture && oldTexture !== texture) {
            oldTexture.dispose();
        }

        mesh.material[slot] = texture;

        // For roughness maps, also set as metalness source
        if (slot === 'roughnessMap') {
            const oldMetal = mesh.material.metalnessMap;
            if (oldMetal && oldMetal !== texture && oldMetal !== oldTexture) {
                oldMetal.dispose();
            }
            mesh.material.metalnessMap = texture;
        }

        if (slot === 'emissiveMap') {
            mesh.material.emissive = new THREE.Color(1, 1, 1);
            mesh.material.emissiveIntensity = 1.2;
        }

        if (slot === 'normalMap') {
            // Trackmania normal maps are DirectX format (Y-), Three.js expects OpenGL (Y+)
            mesh.material.normalScale = new THREE.Vector2(1, -1);
        }

        mesh.material.needsUpdate = true;
    });
}

/**
 * Load a single texture file and apply it to the matching mesh group.
 * Returns a Promise that resolves when the texture is loaded.
 */
function loadTextureFile(filename, cacheBust = '') {
    loadingCount++;
    updateIndicator.classList.remove('hidden');

    return new Promise((resolve) => {
        const parsed = parseTextureFile(filename);
        if (!parsed) {
            console.warn(`[TM LiveSync] Unknown texture file: ${filename}`);
            resolve();
            return;
        }

        const { group, slot } = parsed;
        const targetMeshes = meshGroups[group] || [];
        if (targetMeshes.length === 0) {
            console.warn(`[TM LiveSync] No meshes for group "${group}"`);
            resolve();
            return;
        }

        const url = cacheBust ? `/skin/${filename}?t=${cacheBust}` : `/skin/${filename}`;

        console.log(`[TM LiveSync] Loading ${group}.${slot} ← ${filename}`);

        textureLoader.load(url, (texture) => {
            // Color space: base color and emissive are sRGB, others are linear
            texture.colorSpace = (slot === 'map' || slot === 'emissiveMap')
                ? THREE.SRGBColorSpace
                : THREE.LinearSRGBColorSpace;
            texture.flipY = false;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;

            // Fix blurriness at steep angles and long distances
            texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;

            applyTextureToMeshes(texture, targetMeshes, slot);
            resolve();
        },
            undefined,
            (err) => {
                console.error(`[TM LiveSync] Failed to load: ${url}`, err);
                resolve(); // don't block other loads
            });
    }).finally(() => {
        loadingCount--;
        if (loadingCount <= 0) {
            loadingCount = 0;
            updateIndicator.classList.add('hidden');
        }
    });
}

/**
 * Fetch the list of available textures from the server and load them all.
 */
async function loadInitialTextures() {
    try {
        const res = await fetch('/api/textures');
        const data = await res.json();
        const files = data.files || [];

        if (files.length === 0) {
            console.log('[TM LiveSync] No textures found in skins folder');
            return;
        }

        console.log(`[TM LiveSync] Loading ${files.length} textures from skins folder…`);
        loadingScreen.querySelector('p').textContent = `Loading textures… 0/${files.length}`;

        let loaded = 0;
        for (const file of files) {
            await loadTextureFile(file);
            loaded++;
            loadingScreen.querySelector('p').textContent = `Loading textures… ${loaded}/${files.length}`;
        }

        console.log(`[TM LiveSync] All ${files.length} textures loaded`);
    } catch (err) {
        console.error('[TM LiveSync] Failed to fetch texture list:', err);
    }
}

/**
 * Called on WebSocket update — reload a single texture with cache busting.
 */
function reloadTexture(filename, timestamp) {
    loadTextureFile(filename, timestamp).then(() => {
        // Update HUD
        updateCount++;
        updateCountEl.textContent = updateCount;
        lastFileEl.textContent = filename;
        lastUpdateEl.textContent = new Date().toLocaleTimeString();

        // Flash effect
        triggerFlash();
    });
}

function triggerFlash() {
    reloadFlash.classList.add('active');
    setTimeout(() => reloadFlash.classList.remove('active'), 150);
}

// ── WebSocket client ──────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('[WS] Connected');
        setStatus('connected', 'Connected');
        if (reconnectTimer) {
            clearInterval(reconnectTimer);
            reconnectTimer = null;
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.event === 'update_texture') {
                reloadTexture(data.file, data.timestamp);
            }
        } catch (e) {
            console.error('[WS] Bad message:', e);
        }
    };

    ws.onclose = () => {
        console.log('[WS] Disconnected');
        setStatus('disconnected', 'Disconnected');
        // Auto-reconnect every 2 seconds
        if (!reconnectTimer) {
            reconnectTimer = setInterval(connectWebSocket, 2000);
        }
    };

    ws.onerror = (err) => {
        console.error('[WS] Error:', err);
        ws.close();
    };
}

function setStatus(state, text) {
    statusBar.className = state;
    statusText.textContent = text;
}

connectWebSocket();

// ── Keyboard shortcuts ────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        // Reset camera
        camera.position.set(3, 1.8, 4);
        controls.target.set(0, 0.6, 0);
        controls.update();
    }
    if (e.key === 'F5') {
        // Force-reload all textures without full page refresh
        e.preventDefault();
        console.log('[TM LiveSync] Force-reloading all textures…');
        loadInitialTextures();
    }
});

// ── Resize handler ────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// ── Animation loop ────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    composer.render();
}

// ── UI Listeners ──────────────────────────────────────────────────
helpBtn.addEventListener('click', () => {
    helpModal.classList.remove('hidden');
});

closeHelpBtn.addEventListener('click', () => {
    helpModal.classList.add('hidden');
});

animate();
