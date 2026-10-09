import RAPIER from './vendor/rapier/rapier.mjs';

export const FIXED_STEP = 1 / 120;
let engineReady;
export function initializePhysics() {
  engineReady ??= RAPIER.init();
  return engineReady;
}

export function readCollider(buffer) {
  const header = new DataView(buffer);
  const vertexCount = header.getUint32(0, true);
  const indexCount = header.getUint32(4, true);
  if (buffer.byteLength !== 8 + vertexCount * 12 + indexCount * 4) throw new Error('Invalid collision mesh');
  return { vertices: new Float32Array(buffer, 8, vertexCount * 3), indices: new Uint32Array(buffer, 8 + vertexCount * 12, indexCount) };
}

/** Real rigid bodies; rendering never sets their position or rotation. */
export class RainPhysics {
  constructor({ zhdun, dolphinParts, random = Math.random, maxBodies = 38, rate = 7 }) {
    this.random = random;
    this.maxBodies = maxBodies;
    this.rate = rate;
    this.enabled = true;
    this.time = 0;
    this.accumulator = 0;
    this.spawnAccumulator = 0;
    this.particles = [];
    this.colliderOwners = new Map();
    this.metrics = { spawned: 0, removed: 0, groundContacts: 0, zhdunContacts: 0, dolphinContacts: 0 };
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_STEP;
    this.world.integrationParameters.numSolverIterations = 8;
    this.events = new RAPIER.EventQueue(true);
    this.ground = this.world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50)
      .setTranslation(0, -0.1, 0).setFriction(0.7).setRestitution(0.38));
    this.zhdun = this.world.createCollider(RAPIER.ColliderDesc.trimesh(zhdun.vertices, zhdun.indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(0.42).setRestitution(0.48).setContactSkin(0.002));
    this.sizes = [0.48, 0.59, 0.70, 0.81];
    this.parts = this.sizes.map((size) => dolphinParts.map((part) => {
      const scaled = new Float32Array(part.length);
      for (let i = 0; i < part.length; i++) scaled[i] = part[i] * size;
      const descriptor = RAPIER.ColliderDesc.convexHull(scaled);
      if (!descriptor) throw new Error('Degenerate dolphin collision part');
      return descriptor;
    }));
  }

  spawn(overrides = {}) {
    if (this.particles.length >= this.maxBodies) return null;
    const random = this.random;
    const angle = random() * Math.PI * 2;
    // A mix of central drops and a surrounding annulus hits all parts of the statue.
    const radius = random() < 0.42 ? Math.sqrt(random()) * 1.05 : 1.15 + Math.sqrt(random()) * 1.65;
    const x = overrides.x ?? Math.cos(angle) * radius;
    const y = overrides.y ?? 5.2 + random() * 1.8;
    const z = overrides.z ?? Math.sin(angle) * radius;
    const sizeIndex = overrides.sizeIndex ?? Math.floor(random() * this.sizes.length);
    // Uniform random orientation (Shoemake), with a different angular momentum per drop.
    const u = random(), v = random() * Math.PI * 2, w = random() * Math.PI * 2;
    const rotation = overrides.rotation ?? { x: Math.sqrt(1 - u) * Math.sin(v), y: Math.sqrt(1 - u) * Math.cos(v), z: Math.sqrt(u) * Math.sin(w), w: Math.sqrt(u) * Math.cos(w) };
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z).setRotation(rotation)
      .setLinvel(overrides.vx ?? (random() - 0.5) * 1.5 - x * 0.10, overrides.vy ?? -random() * 0.9, overrides.vz ?? (random() - 0.5) * 1.5 - z * 0.10)
      .setAngvel(overrides.angularVelocity ?? { x: (random() - 0.5) * 5, y: (random() - 0.5) * 4, z: (random() - 0.5) * 5 })
      .setLinearDamping(0.06).setAngularDamping(0.10).setCcdEnabled(true));
    const particle = {
      body, size: this.sizes[sizeIndex], sizeIndex, bornAt: this.time, groundAt: null,
      fadeAt: Infinity, fade: 1, phase: random() * Math.PI * 2, wind: overrides.wind ?? true,
      position: { x, y, z }, previousPosition: { x, y, z }, rotation: { ...rotation }, previousRotation: { ...rotation }, colliders: [],
    };
    const restitution = overrides.restitution ?? 0.30 + random() * 0.28;
    const friction = 0.35 + random() * 0.25;
    for (const descriptor of this.parts[sizeIndex]) {
      descriptor.setDensity(180).setFriction(friction).setRestitution(restitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setContactSkin(0.0015).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const collider = this.world.createCollider(descriptor, body);
      particle.colliders.push(collider.handle);
      this.colliderOwners.set(collider.handle, particle);
    }
    this.particles.push(particle);
    this.metrics.spawned++;
    return particle;
  }

  step(delta) {
    // Never catch up hidden-tab time; the caller also resets its frame clock on visibility changes.
    this.accumulator += Math.min(Math.max(delta, 0), 0.1);
    while (this.accumulator + 1e-10 >= FIXED_STEP) {
      this.accumulator -= FIXED_STEP;
      this.time += FIXED_STEP;
      if (this.enabled) {
        this.spawnAccumulator += FIXED_STEP * this.rate;
        while (this.spawnAccumulator >= 1) { this.spawnAccumulator--; this.spawn(); }
      } else this.spawnAccumulator = 0;
      for (const particle of this.particles) {
        Object.assign(particle.previousPosition, particle.position);
        Object.assign(particle.previousRotation, particle.rotation);
        if (particle.wind && !particle.body.isSleeping()) {
          const force = particle.body.mass() * 0.24;
          particle.body.resetForces(false);
          particle.body.addForce({ x: Math.sin(this.time * 1.1 + particle.phase) * force, y: 0, z: Math.cos(this.time * 0.85 + particle.phase) * force }, false);
        }
      }
      this.world.step(this.events);
      this.events.drainCollisionEvents((first, second, started) => {
        if (!started) return;
        const firstParticle = this.colliderOwners.get(first);
        const secondParticle = this.colliderOwners.get(second);
        const particle = firstParticle || secondParticle;
        if (!particle) return;
        const other = firstParticle ? second : first;
        if (other === this.ground.handle) {
          this.metrics.groundContacts++;
          if (particle.groundAt === null) {
            particle.groundAt = this.time;
            particle.fadeAt = this.time + 0.7 + this.random() * 0.6;
          }
        } else if (other === this.zhdun.handle) this.metrics.zhdunContacts++;
        else if (firstParticle && secondParticle) this.metrics.dolphinContacts++;
      });
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const particle = this.particles[i];
        Object.assign(particle.position, particle.body.translation());
        Object.assign(particle.rotation, particle.body.rotation());
        particle.fade = Math.min(1, Math.max(0, 1 - (this.time - particle.fadeAt) / 0.5));
        if (particle.fade === 0 || this.time - particle.bornAt > 12 || particle.position.y < -5 || Math.abs(particle.position.x) > 20 || Math.abs(particle.position.z) > 20) this.remove(i);
      }
    }
    this.accumulator = Math.max(this.accumulator, 0);
    return this.accumulator / FIXED_STEP;
  }

  remove(index) {
    const particle = this.particles[index];
    for (const handle of particle.colliders) this.colliderOwners.delete(handle);
    this.world.removeRigidBody(particle.body);
    this.particles.splice(index, 1);
    this.metrics.removed++;
  }

  get animating() { return this.enabled || this.particles.length > 0; }
  dispose() {
    this.events.free();
    this.world.free();
    this.particles.length = 0;
    this.colliderOwners.clear();
  }
}
