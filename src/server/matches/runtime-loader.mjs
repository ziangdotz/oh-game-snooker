import createFactoryLoader from '../../runtime/factory-loader.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import decodeRgbaPng from './png-decoder.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME_CATALOG = path.join(ROOT, 'src/runtime/runtime-catalog.json');
const COLLISION_JSON = path.join(ROOT, 'src/assets/collision/tiger-club-collision.json');

async function importFactories(catalog) {
  const factories = new Map();
  for (const entry of catalog.modules) {
    if (entry.kind !== 'factory') {
      continue;
    }
    const url = pathToFileURL(path.join(ROOT, entry.source)).href;
    const imported = await import(url);
    if (typeof imported.default !== 'function') {
      throw new Error('Runtime module does not export a factory: ' + entry.id);
    }
    factories.set(entry.id, imported.default);
  }
  return factories;
}

/** Native factory loader with a cache per instance, mirroring the browser ABI. */
export async function createRuntimeCatalog() {
  const catalog = JSON.parse(await readFile(RUNTIME_CATALOG, 'utf8'));
  const factories = await importFactories(catalog);
  const createLoader = () => createFactoryLoader(factories);
  return { catalog, createLoader };
}

export async function loadCollisionMesh(loadModule, jsonPath = COLLISION_JSON) {
  const data = JSON.parse(await readFile(jsonPath, 'utf8'));
  const MeshBody = loadModule('domain/physics/mesh-body');
  const normalTableApi = loadModule('domain/physics/physics-api').exts.uv4pg;
  const body = new MeshBody(data);
  // The browser asset queue stamps its cache key onto the mesh body, and every
  // serialized world carries it; match that identifier exactly.
  body.id = path.basename(jsonPath);
  const tables = new Map();
  for (const group of body.groups) {
    const textureName = data[group.name]?.nt;
    if (!textureName) {
      continue;
    }
    let table = tables.get(textureName);
    if (!table) {
      const image = decodeRgbaPng(
        await readFile(path.resolve(path.dirname(jsonPath), textureName)),
      );
      table = normalTableApi.createNTableWithImgData(image);
      tables.set(textureName, table);
    }
    normalTableApi.extendPolyGroup(group, table);
  }
  return { body, textures: [...tables.keys()] };
}

export { ROOT };
