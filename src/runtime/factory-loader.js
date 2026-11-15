/** One isolated factory cache, shared by browser and authoritative matches. */
export default function createFactoryLoader(factories) {
  const instances = new Map();
  function requireModule(id) {
    if (instances.has(id)) {
      return instances.get(id).exports;
    }
    const factory = factories.get(id);
    if (!factory) {
      throw new Error(`Unknown runtime module: ${id}`);
    }
    const module = { id, loaded: false, exports: {} };
    instances.set(id, module);
    try {
      factory.call(module.exports, module, module.exports, requireModule);
    } catch (error) {
      instances.delete(id);
      throw error;
    }
    module.loaded = true;
    return module.exports;
  }

  return requireModule;
}
