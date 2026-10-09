import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializePhysics, RainPhysics, readCollider } from '../dist/rain-physics.js';
import { normalizeDolphin, buildDolphinParts } from '../dist/dolphin-shapes.js';

await initializePhysics();
const colliderFile = fs.readFileSync(new URL('../dist/assets/zhdun-collider.bin', import.meta.url));
const localStatue = readCollider(colliderFile.buffer.slice(colliderFile.byteOffset, colliderFile.byteOffset + colliderFile.byteLength));
const originalStatue = fs.readFileSync(new URL('../dist/assets/zhdun.glb', import.meta.url));
const statueJson = JSON.parse(originalStatue.toString('utf8', 20, 20 + originalStatue.readUInt32LE(12)));
const bounds = statueJson.accessors[0];
const scale = 3.4 / (bounds.max[1] - bounds.min[1]);
const centerX = (bounds.min[0] + bounds.max[0]) / 2;
const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
const worldStatue = new Float32Array(localStatue.vertices.length);
for (let i = 0; i < localStatue.vertices.length; i += 3) {
  worldStatue[i] = -(localStatue.vertices[i + 2] - centerZ) * scale;
  worldStatue[i + 1] = (localStatue.vertices[i + 1] - bounds.min[1]) * scale + 0.018;
  worldStatue[i + 2] = (localStatue.vertices[i] - centerX) * scale;
}
const dolphinFile = fs.readFileSync(new URL('../dist/assets/dolphin.glb', import.meta.url));
const jsonLength = dolphinFile.readUInt32LE(12);
const dolphinJson = JSON.parse(dolphinFile.toString('utf8', 20, 20 + jsonLength));
const positionAccessor = dolphinJson.accessors[0];
const positionView = dolphinJson.bufferViews[positionAccessor.bufferView];
const bytes = dolphinFile.subarray(28 + jsonLength + positionView.byteOffset, 28 + jsonLength + positionView.byteOffset + positionView.byteLength);
const positions = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const dolphinParts = buildDolphinParts(normalizeDolphin(positions).positions);

function seeded(seed = 51) {
  return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
}
function makeSimulation(extra = {}) {
  const simulation = new RainPhysics({ zhdun: { vertices: worldStatue, indices: localStatue.indices }, dolphinParts, random: seeded(), ...extra });
  simulation.enabled = false;
  return simulation;
}
const stationary = { rotation: { x: 0, y: 0, z: 0, w: 1 }, angularVelocity: { x: 0, y: 0, z: 0 }, vx: 0, vy: 0, vz: 0, wind: false };

test('free fall follows gravity without animated position overrides', () => {
  const simulation = makeSimulation();
  try {
    const drop = simulation.spawn({ ...stationary, x: 3, y: 4.5, z: 2, sizeIndex: 0 });
    for (let i = 0; i < 24; i++) simulation.step(1 / 120);
    assert.ok(drop.position.y > 4.28 && drop.position.y < 4.33, `Unexpected free fall: ${drop.position.y}`);
    assert.ok(Math.abs(drop.position.x - 3) < 1e-5);
    assert.ok(drop.body.linvel().y < -1.9);
    assert.equal(drop.fade, 1);
  } finally { simulation.dispose(); }
});

test('fast drops collide with the floor, rebound, then remove bodies and colliders', () => {
  const simulation = makeSimulation();
  try {
    const drop = simulation.spawn({ ...stationary, x: 3, y: 2, z: 0, vy: -35, sizeIndex: 1 });
    let bounced = false, minimumY = Infinity;
    for (let i = 0; i < 360 && simulation.particles.length; i++) {
      simulation.step(1 / 120);
      if (simulation.particles.includes(drop)) {
        minimumY = Math.min(minimumY, drop.position.y);
        if (drop.body.linvel().y > 2) bounced = true;
      }
    }
    assert.ok(simulation.metrics.groundContacts > 0);
    assert.ok(bounced, 'The dolphin must rebound from the floor');
    assert.ok(minimumY > -0.2, 'CCD must prevent tunneling through the floor');
    assert.equal(simulation.particles.length, 0);
    assert.equal(simulation.colliderOwners.size, 0);
    assert.equal(simulation.world.bodies.len(), 0);
    assert.equal(simulation.world.colliders.len(), 2);
  } finally { simulation.dispose(); }
});

test('the actual statue mesh blocks a drop at head height', () => {
  const simulation = makeSimulation();
  try {
    const drop = simulation.spawn({ ...stationary, x: 0, y: 5.1, z: 0, vy: -1, sizeIndex: 0 });
    let contactHeight = null;
    for (let i = 0; i < 120; i++) {
      simulation.step(1 / 120);
      if (simulation.metrics.zhdunContacts) { contactHeight = drop.position.y; break; }
    }
    assert.ok(simulation.metrics.zhdunContacts > 0, 'Must contact the mesh, not pass through it');
    assert.ok(contactHeight > 3, `Expected a head collision; got y=${contactHeight}`);
    assert.equal(simulation.metrics.groundContacts, 0);
  } finally { simulation.dispose(); }
});

test('an oblique hit bounces off the belly instead of crossing the statue', () => {
  const simulation = makeSimulation();
  try {
    const drop = simulation.spawn({ ...stationary, x: 2.2, y: 1.1, z: 0, vx: -5, sizeIndex: 0 });
    let bounced = false;
    for (let i = 0; i < 80; i++) {
      simulation.step(1 / 120);
      if (simulation.metrics.zhdunContacts && drop.body.linvel().x > 0.1) { bounced = true; break; }
    }
    assert.ok(simulation.metrics.zhdunContacts > 0);
    assert.ok(bounced, 'Sideways impact should redirect the dolphin');
  } finally { simulation.dispose(); }
});

test('dolphins collide with one another in the air', () => {
  const simulation = makeSimulation();
  try {
    simulation.spawn({ ...stationary, x: 3, y: 3, z: -0.55, vz: 2, sizeIndex: 2 });
    simulation.spawn({ ...stationary, x: 3, y: 3, z: 0.55, vz: -2, sizeIndex: 2 });
    for (let i = 0; i < 48; i++) simulation.step(1 / 120);
    assert.ok(simulation.metrics.dolphinContacts > 0);
  } finally { simulation.dispose(); }
});

test('fixed steps agree across display frame rates and stopping rain drains the world', () => {
  const slower = makeSimulation({ maxBodies: 30 }), faster = makeSimulation({ maxBodies: 30 });
  try {
    slower.enabled = faster.enabled = true;
    for (let i = 0; i < 120; i++) slower.step(1 / 30);
    for (let i = 0; i < 576; i++) faster.step(1 / 144);
    assert.equal(slower.metrics.spawned, faster.metrics.spawned);
    assert.equal(slower.particles.length, faster.particles.length);
    assert.ok(slower.particles.length <= 30);
    for (let i = 0; i < slower.particles.length; i++) {
      assert.ok(Math.abs(slower.particles[i].position.y - faster.particles[i].position.y) < 1e-4);
      assert.ok(Number.isFinite(slower.particles[i].fade));
    }
    assert.ok(slower.metrics.zhdunContacts > 0);
    assert.ok(slower.metrics.groundContacts > 0);
    slower.enabled = false;
    const spawned = slower.metrics.spawned;
    for (let i = 0; i < 1800; i++) slower.step(1 / 120);
    assert.equal(slower.metrics.spawned, spawned);
    assert.equal(slower.particles.length, 0);
    assert.equal(slower.colliderOwners.size, 0);
  } finally { slower.dispose(); faster.dispose(); }
});
