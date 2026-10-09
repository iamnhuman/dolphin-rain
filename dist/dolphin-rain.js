import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RainPhysics, initializePhysics, readCollider } from './rain-physics.js';
import { normalizeDolphin, buildDolphinParts } from './dolphin-shapes.js';

function addDissolve(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float rainFade;\nvarying float vRainFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRainFade = rainFade;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vRainFade;')
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nfloat rainNoise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233))) * 43758.5453);\nif (vRainFade < rainNoise) discard;');
  };
  material.customProgramCacheKey = () => 'rain-dissolve-v1';
}

export class DolphinRain {
  static async create({ scene, statue, enabled = true, onChange = () => {} }) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const [gltf, colliderResponse] = await Promise.all([
      loader.loadAsync('./assets/dolphin.glb'),
      fetch('./assets/zhdun-collider.bin'),
      initializePhysics(),
    ]);
    if (!colliderResponse.ok) throw new Error('Could not load statue collision mesh');
    const zhdun = readCollider(await colliderResponse.arrayBuffer());
    statue.updateMatrixWorld(true);
    let statueMesh, dolphinMesh;
    statue.traverse((node) => { if (node.isMesh && !statueMesh) statueMesh = node; });
    gltf.scene.traverse((node) => { if (node.isMesh && !dolphinMesh) dolphinMesh = node; });
    if (!statueMesh || !dolphinMesh) throw new Error('Missing model mesh');
    // Use the exact same world transform as the visible statue.
    const point = new THREE.Vector3();
    for (let i = 0; i < zhdun.vertices.length; i += 3) {
      point.fromArray(zhdun.vertices, i).applyMatrix4(statueMesh.matrixWorld).toArray(zhdun.vertices, i);
    }
    const normalized = normalizeDolphin(dolphinMesh.geometry.getAttribute('position').array);
    const geometry = dolphinMesh.geometry.clone();
    geometry.setAttribute('position', new THREE.BufferAttribute(normalized.positions, 3));
    geometry.computeBoundingSphere();
    const maxBodies = matchMedia('(max-width: 760px)').matches ? 26 : 40;
    const simulation = new RainPhysics({ zhdun, dolphinParts: buildDolphinParts(normalized.positions), maxBodies });
    const rain = new DolphinRain({ scene, geometry, material: dolphinMesh.material, simulation, maxBodies, onChange });
    rain.setEnabled(enabled);
    if (enabled) for (let i = 0; i < 6; i++) simulation.spawn({ y: 4.2 + i * 0.45 });
    return rain;
  }

  constructor({ scene, geometry, material, simulation, maxBodies, onChange }) {
    this.scene = scene;
    this.simulation = simulation;
    this.onChange = onChange;
    this.phase = '';
    this.pose = new THREE.Object3D();
    this.fromRotation = new THREE.Quaternion();
    this.toRotation = new THREE.Quaternion();
    this.material = material.clone();
    addDissolve(this.material);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(maxBodies).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('rainFade', this.fade);
    this.mesh = new THREE.InstancedMesh(geometry, this.material, maxBodies);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    // One instanced draw uses shared geometry, textures and material for every dolphin.
    scene.add(this.mesh);
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 64;
    const context = shadowCanvas.getContext('2d');
    const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(20,30,25,.32)');
    gradient.addColorStop(0.45, 'rgba(20,30,25,.12)');
    gradient.addColorStop(1, 'rgba(20,30,25,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    this.shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    this.shadowMaterial = new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, depthWrite: false, opacity: 0.6 });
    addDissolve(this.shadowMaterial);
    const shadowGeometry = new THREE.PlaneGeometry(1, 1);
    this.shadowFade = new THREE.InstancedBufferAttribute(new Float32Array(maxBodies), 1).setUsage(THREE.DynamicDrawUsage);
    shadowGeometry.setAttribute('rainFade', this.shadowFade);
    this.shadows = new THREE.InstancedMesh(shadowGeometry, this.shadowMaterial, maxBodies);
    this.shadows.count = 0;
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 1;
    scene.add(this.shadows);
  }

  setEnabled(enabled) {
    this.simulation.enabled = enabled;
    this.notify();
  }

  setIntensity(value) { this.simulation.rate = [3.5, 7, 12][value - 1] || 7; }
  get enabled() { return this.simulation.enabled; }
  get animating() { return this.simulation.animating; }

  notify() {
    const phase = this.enabled ? 'raining' : this.simulation.particles.length ? 'clearing' : 'clear';
    if (phase !== this.phase) { this.phase = phase; this.onChange(phase); }
  }

  update(delta) {
    const alpha = this.simulation.step(delta);
    const particles = this.simulation.particles;
    this.mesh.count = this.shadows.count = particles.length;
    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      this.pose.position.set(
        THREE.MathUtils.lerp(particle.previousPosition.x, particle.position.x, alpha),
        THREE.MathUtils.lerp(particle.previousPosition.y, particle.position.y, alpha),
        THREE.MathUtils.lerp(particle.previousPosition.z, particle.position.z, alpha),
      );
      this.fromRotation.set(particle.previousRotation.x, particle.previousRotation.y, particle.previousRotation.z, particle.previousRotation.w);
      this.toRotation.set(particle.rotation.x, particle.rotation.y, particle.rotation.z, particle.rotation.w);
      this.pose.quaternion.copy(this.fromRotation).slerp(this.toRotation, alpha);
      this.pose.scale.setScalar(particle.size);
      this.pose.updateMatrix();
      this.mesh.setMatrixAt(i, this.pose.matrix);
      this.fade.setX(i, particle.fade);
      const height = Math.max(0, this.pose.position.y);
      this.pose.position.set(this.pose.position.x + height * 0.12, 0.012, this.pose.position.z - height * 0.08);
      this.pose.rotation.set(-Math.PI / 2, 0, 0);
      const shadowSize = particle.size * (1.2 + height * 0.22);
      this.pose.scale.set(shadowSize, shadowSize * 0.7, 1);
      this.pose.updateMatrix();
      this.shadows.setMatrixAt(i, this.pose.matrix);
      this.shadowFade.setX(i, particle.fade * Math.max(0.08, 1 - height / 6));
    }
    this.mesh.instanceMatrix.needsUpdate = this.shadows.instanceMatrix.needsUpdate = true;
    this.fade.needsUpdate = this.shadowFade.needsUpdate = true;
    this.notify();
  }

  dispose() {
    this.simulation.dispose();
    this.scene.remove(this.mesh, this.shadows);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.shadows.geometry.dispose();
    this.shadowMaterial.dispose();
    this.shadowTexture.dispose();
  }
}
