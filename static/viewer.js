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
const refreshBtn = document.getElementById('refresh-btn');
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
renderer.toneMappingExposure = 1.0; // Standard exposure
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
const renderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    {
        samples: 4, 
        type: THREE.HalfFloatType 
    }
);

const composer = new EffectComposer(renderer, renderTarget);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.3,   // strength
    0.4,   // radius
    0.85   // threshold (emissive lights should glow)
);
composer.addPass(bloomPass);

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

// ── Lighting & Environment ────────────────────────────────────────
const pmremScene = new THREE.Scene();
pmremScene.background = new THREE.Color(0x222222); // Darker environment background

// Horizon / Ground
const envGround = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshBasicMaterial({ color: 0x111111 }) 
);
envGround.rotation.x = -Math.PI / 2;
pmremScene.add(envGround);

// A moderate "Sun"
const sun = new THREE.Mesh(
    new THREE.SphereGeometry(15, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
);
sun.position.set(40, 50, 40);
pmremScene.add(sun);

// Generate the environment map
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
scene.environment = pmremGenerator.fromScene(pmremScene).texture;
scene.environmentIntensity = 0.8; 

// Add a soft hemisphere light to fill in pitch-black shadows
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x888888, 0.8);
scene.add(hemiLight);

// Add a directional light
const keyLight = new THREE.DirectionalLight(0xffffff, 0.7);
keyLight.position.set(5, 8, 4);
scene.add(keyLight);

// Ground plane
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

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 2.5 / maxDim;
        model.scale.setScalar(scale);

        box.setFromObject(model);
        box.getCenter(center);
        model.position.sub(center);
        model.position.y += (size.y * scale) / 2;

        model.traverse((child) => {
            if (child.isMesh && child.material) {
                // FORCE ALL MATERIALS TO BE SOLID initially (except glass)
                const matName = child.material.name?.toLowerCase() || '';
                
                if (!matName.includes('glass')) {
                    child.material.transparent = false;
                    child.material.opacity = 1.0;
                    child.material.depthWrite = true;
                } else {
                    child.material.transparent = true;
                    child.material.opacity = 0.5;
                }

                // Reset emissive to prevent default model glow
                child.material.emissive.setHex(0x000000);
                child.material.emissiveIntensity = 0;
                child.material.emissiveMap = null;

                // Sensible PBR defaults
                child.material.roughness = 0.5; 
                child.material.metalness = 0.0;

                if (matName.includes('skin')) meshGroups.skin.push(child);
                else if (matName.includes('details')) meshGroups.details.push(child);
                else if (matName.includes('wheel') || matName.includes('rim') || matName.includes('tire') || matName.includes('hub')) {
                    meshGroups.wheels.push(child);
                }
                else if (matName.includes('glass')) meshGroups.glass.push(child);
            }
        });

        scene.add(model);
        controls.target.set(0, (size.y * scale) / 2, 0);
        controls.update();

        loadInitialTextures().then(() => {
            loadingScreen.classList.add('hidden');
        });
    },
    (progress) => {
        if (progress.total) {
            const pct = Math.round((progress.loaded / progress.total) * 100);
            loadingScreen.querySelector('p').textContent = `Loading model… ${pct}%`;
        }
    }
);

// ── Texture reload system ─────────────────────────────────────────
const textureLoader = new THREE.TextureLoader();

function parseTextureFile(filename) {
    const f = filename.toLowerCase();
    let group = null;
    if (f.startsWith('skin')) group = 'skin';
    else if (f.startsWith('details')) group = 'details';
    else if (f.startsWith('wheels')) group = 'wheels';
    else if (f.startsWith('glass')) group = 'glass';
    if (!group) return null;

    let slot = null;
    if (/_b\./.test(f) || /_d\./.test(f)) slot = 'map';
    else if (/_r\./.test(f)) slot = 'roughnessMap';
    else if (/_n\./.test(f)) slot = 'normalMap';
    else if (/_i\./.test(f)) slot = 'emissiveMap';
    else if (/_ao\./.test(f)) slot = 'aoMap';
    if (!slot) return null;

    return { group, slot };
}

function applyTextureToMeshes(texture, targetMeshes, slot) {
    targetMeshes.forEach((mesh) => {
        if (!mesh.material) return;

        // Force transparency off for non-glass to ensure the body is solid
        if (!mesh.material.name.toLowerCase().includes('glass')) {
            mesh.material.transparent = false;
            mesh.material.opacity = 1.0;
            mesh.material.depthWrite = true;
        }

        const oldTexture = mesh.material[slot];
        if (oldTexture && oldTexture !== texture) {
            oldTexture.dispose();
        }

        mesh.material[slot] = texture;

        // For roughness maps, also set as metalness source
        if (slot === 'roughnessMap') {
            mesh.material.metalnessMap = texture;
            mesh.material.metalness = 1.0;
            mesh.material.roughness = 1.0;
        }

        if (slot === 'emissiveMap') {
            mesh.material.emissive.setHex(0xffffff);
            // Slightly lower intensity for smaller parts to prevent overwhelming glow
            const isSkin = mesh.material.name.toLowerCase().includes('skin');
            mesh.material.emissiveIntensity = isSkin ? 2.0 : 1.2;
        }

        if (slot === 'aoMap') {
            mesh.material.aoMapIntensity = 1.0;
        }

        if (slot === 'normalMap') {
            mesh.material.normalScale = new THREE.Vector2(1, -1);
        }

        mesh.material.needsUpdate = true;
    });
}

function loadTextureFile(filename, cacheBust = '') {
    loadingCount++;
    updateIndicator.classList.remove('hidden');

    return new Promise((resolve) => {
        const parsed = parseTextureFile(filename);
        if (!parsed) {
            resolve();
            return;
        }

        const { group, slot } = parsed;
        const targetMeshes = meshGroups[group] || [];
        if (targetMeshes.length === 0) {
            resolve();
            return;
        }

        const url = cacheBust ? `/skin/${filename}?t=${cacheBust}` : `/skin/${filename}`;

        textureLoader.load(url, (texture) => {
            // CRITICAL: Set color space
            if (slot === 'map' || slot === 'emissiveMap') {
                texture.colorSpace = THREE.SRGBColorSpace;
            } else {
                texture.colorSpace = THREE.NoColorSpace;
            }

            texture.flipY = false;
            texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
            
            applyTextureToMeshes(texture, targetMeshes, slot);
            resolve();
        }, undefined, () => resolve());
    }).finally(() => {
        loadingCount--;
        if (loadingCount <= 0) {
            loadingCount = 0;
            updateIndicator.classList.add('hidden');
        }
    });
}

async function loadInitialTextures() {
    try {
        const res = await fetch('/api/textures');
        const data = await res.json();
        const files = data.files || [];
        for (const file of files) {
            await loadTextureFile(file);
        }
    } catch (err) {
        console.error('[TM LiveSync] Initial load failed:', err);
    }
}

// Alias for manual refresh button in HTML
window.loadAllTextures = loadInitialTextures;

function reloadTexture(filename, timestamp) {
    loadTextureFile(filename, timestamp).then(() => {
        updateCount++;
        updateCountEl.textContent = updateCount;
        lastFileEl.textContent = filename;
        lastUpdateEl.textContent = new Date().toLocaleTimeString();
        triggerFlash();
    });
}

function triggerFlash() {
    reloadFlash.classList.add('active');
    setTimeout(() => reloadFlash.classList.remove('active'), 150);
}

// ── WebSocket client ──────────────────────────────────────────────
function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => setStatus('connected', 'Connected');
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.event === 'update_texture') {
                reloadTexture(data.file, data.timestamp);
            }
        } catch (e) {}
    };
    ws.onclose = () => {
        setStatus('disconnected', 'Disconnected');
        setTimeout(connectWebSocket, 2000);
    };
}

function setStatus(state, text) {
    statusBar.className = state;
    statusText.textContent = text;
}

connectWebSocket();

// ── UI Listeners ──────────────────────────────────────────────────
helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
closeHelpBtn.addEventListener('click', () => helpModal.classList.add('hidden'));
refreshBtn.addEventListener('click', () => loadInitialTextures());

window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        camera.position.set(3, 1.8, 4);
        controls.target.set(0, 0.4, 0);
        controls.update();
    }
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    composer.render();
}

animate();
