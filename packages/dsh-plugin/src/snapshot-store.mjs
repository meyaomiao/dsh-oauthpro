/**
 * Dual-read for DSH snapshot stores.
 *
 * 0.1.1-rc.2 exports createSnapshotStore from
 * `@deepseek-ai/dsh-client-runtime/client`.
 * 0.1.2-rc.1 moved it to `@deepseek-ai/dsh-client-store` and stopped
 * publishing dsh-client-runtime.
 *
 * This module is bundled as CJS; `require` is the ModuleLoader factory.
 */
function loadCreateSnapshotStore() {
  const ids = [
    "@deepseek-ai/dsh-client-store",
    "@deepseek-ai/dsh-client-runtime/client",
  ];
  const errors = [];
  for (const id of ids) {
    try {
      const mod = require(id);
      const fn = mod?.createSnapshotStore ?? mod?.default?.createSnapshotStore;
      if (typeof fn === "function") return fn;
      errors.push(`${id}: createSnapshotStore is not a function`);
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `[dockyard-dsh] createSnapshotStore unavailable. Tried ${ids.join(" then ")}. ${errors.join("; ")}`,
  );
}

export const createSnapshotStore = loadCreateSnapshotStore();
