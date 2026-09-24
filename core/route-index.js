'use strict';

// What routes this server answers, read from Express rather than from a maintained
// list. Mounted routers are followed: a route missed here is a route nothing checks.

function mountPrefix(layer) {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  // Express keeps the mount path as a regexp; the literal part is what we need.
  const zrodlo = layer.regexp.source
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\$$/, '');
  return zrodlo === '/' ? '' : zrodlo;
}

function walk(stack, prefix, byPath) {
  for (const layer of stack) {
    if (layer.route && layer.route.path) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods || {})
        .filter(m => layer.route.methods[m])
        .map(m => m.toUpperCase());

      for (const p of paths) {
        const pelna = `${prefix}${p}`;
        if (!byPath.has(pelna)) byPath.set(pelna, new Set());
        methods.forEach(m => byPath.get(pelna).add(m));
      }
      continue;
    }

    if (layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + mountPrefix(layer), byPath);
    }
  }
}

function collectRoutes(app) {
  const byPath = new Map();
  walk((app._router && app._router.stack) || [], '', byPath);

  return [...byPath.entries()]
    .map(([path, methods]) => ({
      path,
      methods: [...methods].sort(),
      parameterised: path.includes(':'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { collectRoutes };
