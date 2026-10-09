import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const stage = $('stage');
const canvas = $('canvas');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const interactionButtons = [...viewer.querySelectorAll('button'), $('explore')];
const target = new THREE.Vector3(0, 1.58, 0);
const modelHeight = 3.4;
let renderer, scene, camera, controls, model, keyLight, environmentTarget;
let frame = null;
let lastTime = 0;
let transition = null;
let ready = false;
let generation = 0;
let homeDistance = 9.5;
let expanded = false;

interactionButtons.forEach((button) => { button.disabled = true; });

function announce(message) { $('status').textContent = message; }
function invalidate() {
  if (frame === null && renderer && !document.hidden) frame = requestAnimationFrame(render);
}

function render(time) {
  frame = null;
  if (document.hidden) return;
  const delta = Math.min((time - lastTime) / 1000 || 0, 0.05);
  lastTime = time;
  if (transition) {
    const fraction = Math.min((time - transition.start) / transition.duration, 1);
    const eased = 1 - (1 - fraction) ** 3;
    camera.position.lerpVectors(transition.from, transition.to, eased);
    controls.target.lerpVectors(transition.targetFrom, target, eased);
    if (fraction === 1) transition = null;
  }
  const changed = controls.update(delta);
  renderer.render(scene, camera);
  if (controls.autoRotate || transition || changed) invalidate();
}

function resize() {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!renderer || !width || !height) return;
  const oldDistance = homeDistance;
  camera.aspect = width / height;
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  // Leave breathing room above the head and below the feet at every aspect ratio.
  const fitHeightDistance = modelHeight * 1.35 / (2 * Math.tan(verticalFov / 2));
  const fitWidthDistance = 2.48 * 1.35 / (2 * Math.tan(verticalFov / 2) * camera.aspect);
  homeDistance = Math.max(fitHeightDistance, fitWidthDistance);
  if (ready && oldDistance) {
    const offset = camera.position.clone().sub(controls.target);
    offset.multiplyScalar(homeDistance / oldDistance);
    camera.position.copy(controls.target).add(offset);
  }
  controls.minDistance = 3.2;
  controls.maxDistance = homeDistance * 1.9;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, width < 600 ? 1.5 : 1.75));
  renderer.setSize(width, height, false);
  invalidate();
}

function markView(view) {
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setAutoRotate(enabled) {
  controls.autoRotate = enabled;
  $('rotate').setAttribute('aria-pressed', String(enabled));
  $('rotate').setAttribute('aria-label', enabled ? 'Остановить вращение' : 'Включить медленное вращение');
  $('rotate').querySelector('span').textContent = enabled ? 'Пауза' : 'Вращать';
  $('rotate-icon').setAttribute('href', enabled ? '#i-pause' : '#i-play');
  if (enabled) { markView(null); viewer.classList.add('interacted'); }
  invalidate();
}

function moveTo(position, duration = 700) {
  transition = {
    from: camera.position.clone(),
    to: position,
    targetFrom: controls.target.clone(),
    start: performance.now(),
    duration: reducedMotion.matches ? 1 : duration,
  };
  invalidate();
}

function setView(view, immediate = false) {
  setAutoRotate(false);
  const angles = { front: 0.11, side: Math.PI / 2, back: Math.PI + 0.11 };
  const angle = angles[view] ?? angles.front;
  const elevation = 0.105;
  const position = new THREE.Vector3(
    Math.sin(angle) * Math.cos(elevation) * homeDistance,
    target.y + Math.sin(elevation) * homeDistance,
    Math.cos(angle) * Math.cos(elevation) * homeDistance,
  );
  if (immediate) {
    transition = null;
    controls.target.copy(target);
    camera.position.copy(position);
    controls.update();
    invalidate();
  } else moveTo(position);
  markView(view);
}

function zoom(factor) {
  if (!ready) return;
  transition = null;
  const offset = camera.position.clone().sub(controls.target);
  const distance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
  offset.setLength(distance);
  camera.position.copy(controls.target).add(offset);
  invalidate();
}

function setTheme(dark) {
  if (dark) document.body.dataset.theme = 'dark';
  else delete document.body.dataset.theme;
  $('light').classList.toggle('active', !dark);
  $('dark').classList.toggle('active', dark);
  $('light').setAttribute('aria-pressed', String(!dark));
  $('dark').setAttribute('aria-pressed', String(dark));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#20231f' : '#f1f0eb';
  if (scene) {
    scene.environmentIntensity = dark ? 0.35 : 0.65;
    keyLight.intensity = dark ? 3.2 : 3.8;
    keyLight.color.set(dark ? '#dce5cc' : '#fff9ed');
    renderer.toneMappingExposure = dark ? 1.05 : 1.15;
    invalidate();
  }
  try { localStorage.setItem('zhdun-theme', dark ? 'dark' : 'light'); } catch { /* Storage is optional. */ }
}

function contactShadow() {
  const textureCanvas = document.createElement('canvas');
  textureCanvas.width = textureCanvas.height = 256;
  const context = textureCanvas.getContext('2d');
  const gradient = context.createRadialGradient(128, 128, 12, 128, 128, 125);
  gradient.addColorStop(0, 'rgba(35, 40, 28, 0.30)');
  gradient.addColorStop(0.38, 'rgba(35, 40, 28, 0.15)');
  gradient.addColorStop(1, 'rgba(35, 40, 28, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(textureCanvas);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 4.3), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.008;
  return shadow;
}

function showError(error) {
  ready = false;
  console.error('Unable to display the GLB model:', error);
  $('loading').hidden = true;
  $('loading').style.display = 'none';
  $('error-state').hidden = false;
  viewer.classList.remove('ready');
  interactionButtons.forEach((button) => { button.disabled = true; });
  $('retry').disabled = false;
  $('fullscreen').disabled = false;
  $('error-message').textContent = renderer
    ? 'Модель не загрузилась. Проверьте подключение и попробуйте ещё раз.'
    : 'Для объёмного Ждуна нужен WebGL 2. Попробуйте современный браузер с включённым аппаратным ускорением.';
  announce('Не удалось загрузить модель.');
}

async function loadModel() {
  const attempt = ++generation;
  $('error-state').hidden = true;
  $('loading').hidden = false;
  $('loading').style.display = 'flex';
  $('loading').classList.remove('loaded');
  $('loading').removeAttribute('aria-hidden');
  $('loading-title').textContent = 'Ждун скоро будет здесь';
  $('loading-note').textContent = 'Даже ему нужно немного времени';
  $('progress-bar').style.width = '0';
  try {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync('./assets/zhdun.glb', (event) => {
      if (attempt !== generation) return;
      const progress = Math.min(event.loaded / (event.total || 15500248), 1);
      $('progress-bar').style.width = `${Math.round(progress * 100)}%`;
      if (progress === 1) {
        $('loading-title').textContent = 'Последние мгновения';
        $('loading-note').textContent = 'Готовим мягкий свет';
      }
    });
    if (attempt !== generation) return;
    model = gltf.scene;
    // This export faces +X. Present the face toward the initial +Z camera.
    model.rotation.y = -Math.PI / 2;
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.y) || size.y <= 0) throw new Error('Invalid model bounds.');
    const scale = modelHeight / size.y;
    model.scale.multiplyScalar(scale);
    model.position.set(-center.x * scale, -bounds.min.y * scale + 0.018, -center.z * scale);
    model.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = true;
      node.receiveShadow = false;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
          if (material[key]) material[key].anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        }
      }
    });
    scene.add(model);
    ready = true;
    setView('front', true);
    renderer.shadowMap.needsUpdate = true;
    await renderer.compileAsync(scene, camera);
    if (attempt !== generation) return;
    interactionButtons.forEach((button) => { button.disabled = false; });
    viewer.classList.add('ready');
    $('loading').classList.add('loaded');
    $('loading').setAttribute('aria-hidden', 'true');
    announce('Ждун загрузился. Можно вращать и приближать модель.');
    invalidate();
  } catch (error) {
    if (attempt === generation) showError(error);
  }
}

function init() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The object and lights are stationary. Camera movement needs no new shadow map.
    renderer.shadowMap.autoUpdate = false;
    scene = new THREE.Scene();
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    environmentTarget = pmrem.fromScene(room, 0.04);
    scene.environment = environmentTarget.texture;
    scene.environmentIntensity = 0.65;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xf6f7ed, 0xa2a58e, 1.25));
    keyLight = new THREE.DirectionalLight(0xfff9ed, 3.8);
    keyLight.position.set(-3.5, 6, 5);
    keyLight.target.position.set(0, 1.5, 0);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    Object.assign(keyLight.shadow.camera, { left: -3, right: 3, top: 4, bottom: -3, near: 0.1, far: 15 });
    keyLight.shadow.normalBias = 0.025;
    keyLight.shadow.bias = -0.00015;
    keyLight.shadow.radius = 4;
    scene.add(keyLight, keyLight.target);
    const rim = new THREE.DirectionalLight(0xffffff, 1.65);
    rim.position.set(3, 4, -3);
    scene.add(rim);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.ShadowMaterial({ opacity: 0.035, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor, contactShadow());
    camera = new THREE.PerspectiveCamera(31, 1, 0.05, 100);
    camera.position.set(0.8, 2.5, 9.5);
    controls = new OrbitControls(camera, canvas);
    controls.target.copy(target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.enablePan = false;
    controls.autoRotateSpeed = 0.65;
    controls.minPolarAngle = 0.2;
    controls.maxPolarAngle = Math.PI * 0.63;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 0.7;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controls.addEventListener('change', invalidate);
    controls.addEventListener('start', () => {
      transition = null;
      setAutoRotate(false);
      markView(null);
      viewer.classList.add('interacted');
    });
    controls.enabled = true;
    new ResizeObserver(resize).observe(stage);
    resize();
    try { setTheme(localStorage.getItem('zhdun-theme') === 'dark'); } catch { setTheme(false); }
    loadModel();
  } catch (error) { showError(error); }
}

$('rotate').addEventListener('click', () => { setAutoRotate(!controls.autoRotate); announce(controls.autoRotate ? 'Медленное вращение включено.' : 'Вращение остановлено.'); });
$('zoom-in').addEventListener('click', () => zoom(0.85));
$('zoom-out').addEventListener('click', () => zoom(1 / 0.85));
$('reset').addEventListener('click', () => { setView('front'); viewer.classList.remove('interacted'); announce('Исходный ракурс.'); });
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
  setView(button.dataset.view);
  viewer.classList.add('interacted');
  announce(`Ракурс: ${button.textContent.toLowerCase()}.`);
}));
$('light').addEventListener('click', () => setTheme(false));
$('dark').addEventListener('click', () => setTheme(true));
$('explore').addEventListener('click', () => {
  viewer.classList.add('interacted');
  viewer.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'center' });
  setAutoRotate(false);
  const closeup = camera.position.clone().sub(controls.target).setLength(Math.max(controls.minDistance + 0.2, homeDistance * 0.72)).add(controls.target);
  moveTo(closeup, 850);
  canvas.focus({ preventScroll: true });
});
function setExpanded(enabled) {
  expanded = enabled;
  viewer.classList.toggle('expanded', enabled);
  document.body.classList.toggle('viewer-expanded', enabled);
  $('fullscreen').setAttribute('aria-expanded', String(enabled));
  $('fullscreen').setAttribute('aria-label', enabled ? 'Выйти из полноэкранного режима' : 'Открыть модель на весь экран');
  $('fullscreen').title = enabled ? 'Выйти · Esc' : 'На весь экран';
  resize();
}
// Fill the page viewport. This also works in embedded and mobile browsers.
$('fullscreen').addEventListener('click', () => setExpanded(!expanded));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && expanded) { setExpanded(false); $('fullscreen').focus(); }
});
$('retry').addEventListener('click', () => {
  if (!renderer) { location.reload(); return; }
  if (model) { scene.remove(model); model = null; }
  loadModel();
});
$('about-open').addEventListener('click', () => $('about').showModal());
$('about-close').addEventListener('click', () => $('about').close());
$('about').addEventListener('click', (event) => {
  const bounds = $('about').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('about').close();
});
canvas.addEventListener('keydown', (event) => {
  if (!ready || event.altKey || event.metaKey || event.ctrlKey) return;
  const supported = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'r', 'R', ' '];
  if (!supported.includes(event.key)) return;
  event.preventDefault();
  viewer.classList.add('interacted');
  if (['+', '='].includes(event.key)) { zoom(0.9); return; }
  if (['-', '_'].includes(event.key)) { zoom(1 / 0.9); return; }
  if (event.key.toLowerCase() === 'r') { setView('front'); return; }
  if (event.key === ' ') { setAutoRotate(!controls.autoRotate); return; }
  setAutoRotate(false);
  transition = null;
  const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  if (event.key === 'ArrowLeft') spherical.theta -= 0.12;
  if (event.key === 'ArrowRight') spherical.theta += 0.12;
  if (event.key === 'ArrowUp') spherical.phi = Math.max(controls.minPolarAngle, spherical.phi - 0.1);
  if (event.key === 'ArrowDown') spherical.phi = Math.min(controls.maxPolarAngle, spherical.phi + 0.1);
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
  markView(null);
  invalidate();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastTime = performance.now(); invalidate(); } });
canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); showError(new Error('WebGL context lost')); });
canvas.addEventListener('webglcontextrestored', () => location.reload());
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches && controls) setAutoRotate(false); });
init();
