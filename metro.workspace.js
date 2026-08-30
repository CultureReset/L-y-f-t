/**
 * Shared Metro configuration for the apps in this monorepo.
 *
 * Two things Metro does not do out of the box, both needed here:
 *
 * 1. Follow workspace packages. Metro only watches the app directory, so the
 *    shared packages have to be added to `watchFolders` and to the module
 *    resolution paths, or importing `@lift/ui` fails to bundle.
 *
 * 2. Resolve TypeScript's `.js` import specifiers. Under ESM-style module
 *    resolution, TypeScript requires relative imports to be written with a
 *    `.js` extension even though the file on disk is `.ts`/`.tsx`. Metro takes
 *    the specifier literally and cannot find the file, so the resolver below
 *    retries those requests against the real source extensions.
 *
 *    That retry has to honour platform extensions itself. Metro normally tries
 *    `thing.web.ts` before `thing.ts`; a resolver that answers with `thing.ts`
 *    the moment it exists silently disables every platform-specific file in
 *    the codebase, which is how a module that only works on a device ends up
 *    in the web bundle.
 */

const path = require('node:path');
const fs = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/**
 * Rewrite a `./thing.js` specifier to whichever sibling source file exists.
 * Returns undefined when the request is not a relative `.js` import, or when
 * no source file matches — in which case Metro's own resolver handles it.
 */
const resolveSourceExtension = (context, moduleName, platform) => {
  if (!moduleName.endsWith('.js')) return undefined;
  if (!moduleName.startsWith('./') && !moduleName.startsWith('../')) return undefined;

  const originDir = path.dirname(context.originModulePath);
  const withoutExtension = path.resolve(originDir, moduleName.slice(0, -'.js'.length));

  // Platform-specific first, exactly as Metro would: `push.web.ts` beats
  // `push.native.ts` beats `push.ts`.
  const qualifiers = [
    ...(platform ? [`.${platform}`] : []),
    ...(platform && platform !== 'web' ? ['.native'] : []),
    '',
  ];

  for (const qualifier of qualifiers) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = `${withoutExtension}${qualifier}${extension}`;
      if (fs.existsSync(candidate)) return { type: 'sourceFile', filePath: candidate };
    }
  }
  return undefined;
};

/**
 * Build a Metro config for an app inside this workspace.
 *
 * @param {string} projectRoot Absolute path to the app directory.
 */
const createWorkspaceMetroConfig = (projectRoot) => {
  const workspaceRoot = path.resolve(projectRoot, '../..');
  const config = getDefaultConfig(projectRoot);

  config.watchFolders = [workspaceRoot];
  config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(workspaceRoot, 'node_modules'),
  ];
  // Two copies of React would break hooks; always resolve to the hoisted one.
  config.resolver.disableHierarchicalLookup = true;

  const defaultResolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const rewritten = resolveSourceExtension(context, moduleName, platform);
    if (rewritten) return rewritten;
    return defaultResolveRequest
      ? defaultResolveRequest(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };

  return config;
};

module.exports = { createWorkspaceMetroConfig };
