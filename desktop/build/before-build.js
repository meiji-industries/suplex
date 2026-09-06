// The desktop shell has no runtime dependencies. Returning false tells electron-builder that
// node_modules are handled outside it, so it stops walking up to the workspace root and
// bundling Forge's server dependency graph (better-sqlite3 included) into the app.
module.exports = async () => false;
