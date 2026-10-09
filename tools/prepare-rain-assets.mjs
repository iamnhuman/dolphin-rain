import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { MeshoptDecoder } from '../dist/vendor/three/addons/libs/meshopt_decoder.module.js';
import { MeshoptSimplifier } from './vendor/meshopt_simplifier.module.js';

const root = path.resolve(import.meta.dirname, '..');
await Promise.all([MeshoptDecoder.ready, MeshoptSimplifier.ready]);

function readModel(filename) {
  const data = fs.readFileSync(filename);
  if (data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2) throw new Error('Expected GLB 2.0');
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.toString('utf8', 20, 20 + jsonLength));
  const binary = data.subarray(28 + jsonLength);
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error('Expected a single mesh');
  const views = new Map();
  function view(index) {
    if (views.has(index)) return views.get(index);
    const descriptor = json.bufferViews[index];
    const compression = descriptor.extensions?.EXT_meshopt_compression;
    let bytes;
    if (compression) {
      bytes = new Uint8Array(compression.count * compression.byteStride);
      MeshoptDecoder.decodeGltfBuffer(bytes, compression.count, compression.byteStride,
        binary.subarray(compression.byteOffset, compression.byteOffset + compression.byteLength), compression.mode, compression.filter);
    } else bytes = binary.subarray(descriptor.byteOffset || 0, (descriptor.byteOffset || 0) + descriptor.byteLength);
    views.set(index, bytes);
    return bytes;
  }
  function attribute(index, components) {
    const accessor = json.accessors[index];
    const descriptor = json.bufferViews[accessor.bufferView];
    const bytes = view(accessor.bufferView);
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const componentBytes = { 5120: 1, 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
    const stride = descriptor.byteStride || components * componentBytes;
    const output = accessor.componentType === 5125 ? new Uint32Array(accessor.count * components) : new Float32Array(accessor.count * components);
    for (let i = 0; i < accessor.count; i++) for (let c = 0; c < components; c++) {
      const offset = (accessor.byteOffset || 0) + i * stride + c * componentBytes;
      let value;
      switch (accessor.componentType) {
        case 5120: value = dataView.getInt8(offset); if (accessor.normalized) value = Math.max(-1, value / 127); break;
        case 5121: value = dataView.getUint8(offset); if (accessor.normalized) value /= 255; break;
        case 5123: value = dataView.getUint16(offset, true); break;
        case 5125: value = dataView.getUint32(offset, true); break;
        case 5126: value = dataView.getFloat32(offset, true); break;
        default: throw new Error('Unsupported component type');
      }
      output[i * components + c] = value;
    }
    return output;
  }
  const primitive = json.meshes[0].primitives[0];
  return { json, binary, view, positions: attribute(primitive.attributes.POSITION, 3), normals: attribute(primitive.attributes.NORMAL, 3), uvs: attribute(primitive.attributes.TEXCOORD_0, 2), indices: attribute(primitive.indices, 1) };
}

function compact(model, indices) {
  const [remap, count] = MeshoptSimplifier.compactMesh(indices);
  function move(values, components) {
    const output = new Float32Array(count * components);
    for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) {
      for (let c = 0; c < components; c++) output[remap[i] * components + c] = values[i * components + c];
    }
    return output;
  }
  return { positions: move(model.positions, 3), normals: move(model.normals, 3), uvs: move(model.uvs, 2), indices };
}

function packCollider(mesh) {
  const output = Buffer.alloc(8 + mesh.positions.byteLength + mesh.indices.byteLength);
  output.writeUInt32LE(mesh.positions.length / 3, 0);
  output.writeUInt32LE(mesh.indices.length, 4);
  Buffer.from(mesh.positions.buffer).copy(output, 8);
  Buffer.from(mesh.indices.buffer).copy(output, 8 + mesh.positions.byteLength);
  return output;
}

function writeDolphin(model, mesh) {
  const json = structuredClone(model.json);
  const chunks = [];
  let length = 0;
  json.bufferViews = [];
  function add(bytes, target, stride) {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const index = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length, ...(target ? { target } : {}), ...(stride ? { byteStride: stride } : {}) });
    chunks.push(data);
    const padding = (4 - data.length % 4) % 4;
    if (padding) chunks.push(Buffer.alloc(padding));
    length += data.length + padding;
    return index;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zhdun-textures-'));
  try {
    json.images = model.json.images.map((image, i) => {
      const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
      const input = path.join(temporary, `input-${i}.${extension}`);
      const output = path.join(temporary, `output-${i}.${extension}`);
      fs.writeFileSync(input, model.view(image.bufferView));
      execFileSync('/usr/bin/sips', ['--resampleHeightWidthMax', '1024', input, '--out', output], { stdio: 'ignore' });
      return { ...image, bufferView: add(fs.readFileSync(output)) };
    });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const positionView = add(mesh.positions, 34962, 12);
  const normalView = add(mesh.normals, 34962, 12);
  const uvView = add(mesh.uvs, 34962, 8);
  const indexView = add(mesh.indices, 34963);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) { const a = i % 3; min[a] = Math.min(min[a], mesh.positions[i]); max[a] = Math.max(max[a], mesh.positions[i]); }
  const count = mesh.positions.length / 3;
  json.accessors = [
    { bufferView: positionView, componentType: 5126, count, type: 'VEC3', min, max },
    { bufferView: normalView, componentType: 5126, count, type: 'VEC3' },
    { bufferView: uvView, componentType: 5126, count, type: 'VEC2' },
    { bufferView: indexView, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
  ];
  json.meshes[0].primitives[0] = { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 };
  json.buffers = [{ byteLength: length }];
  delete json.extensionsUsed;
  delete json.extensionsRequired;
  json.asset.generator = 'meshoptimizer 0.24.0; rain rendering derivative';
  const encodedJson = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.concat([encodedJson, Buffer.alloc((4 - encodedJson.length % 4) % 4, 0x20)]);
  const binary = Buffer.concat(chunks);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + paddedJson.length + binary.length, 8); header.writeUInt32LE(paddedJson.length, 12); header.write('JSON', 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, paddedJson, binHeader, binary]);
}

const dolphin = readModel(path.join(root, 'source-assets/dolphin-original.glb'));
const attributes = new Float32Array(dolphin.positions.length / 3 * 5);
for (let i = 0; i < dolphin.positions.length / 3; i++) {
  attributes.set(dolphin.normals.subarray(i * 3, i * 3 + 3), i * 5);
  attributes.set(dolphin.uvs.subarray(i * 2, i * 2 + 2), i * 5 + 3);
}
const [dolphinIndices, dolphinError] = MeshoptSimplifier.simplifyWithAttributes(dolphin.indices, dolphin.positions, 3, attributes, 5, [0.05, 0.05, 0.05, 0.1, 0.1], null, 36000, 0.018);
const dolphinMesh = compact(dolphin, dolphinIndices);
fs.writeFileSync(path.join(root, 'dist/assets/dolphin.glb'), writeDolphin(dolphin, dolphinMesh));

const zhdun = readModel(path.join(root, 'dist/assets/zhdun.glb'));
const [zhdunIndices, colliderError] = MeshoptSimplifier.simplify(zhdun.indices, zhdun.positions, 3, 60000, 0.006);
const collider = compact(zhdun, zhdunIndices);
fs.writeFileSync(path.join(root, 'dist/assets/zhdun-collider.bin'), packCollider(collider));
console.log(JSON.stringify({ dolphin: { originalTriangles: dolphin.indices.length / 3, triangles: dolphinIndices.length / 3, error: dolphinError, bytes: fs.statSync(path.join(root, 'dist/assets/dolphin.glb')).size }, zhdunCollider: { triangles: zhdunIndices.length / 3, error: colliderError, bytes: 8 + collider.positions.byteLength + collider.indices.byteLength } }, null, 2));
