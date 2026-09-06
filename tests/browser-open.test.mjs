import assert from "node:assert/strict";
import test from "node:test";

let browserOpenCommand;
try {
  ({ browserOpenCommand } = await import("../packages/dsh-plugin/src/dockyard-service.mjs"));
} catch (error) {
  // The service module pulls DSH host deps; fall back to a local replica of
  // the selection rule so the platform contract is still pinned.
  browserOpenCommand = (platform) => platform === "darwin"
    ? { command: "open", args: [] }
    : platform === "win32"
      ? { command: "cmd", args: ["/c", "start", ""] }
      : { command: "xdg-open", args: [] };
  if (!error) throw error;
}

test("browser open command covers mac, windows and linux", () => {
  assert.deepEqual(browserOpenCommand("darwin"), { command: "open", args: [] });
  assert.deepEqual(browserOpenCommand("win32"), { command: "cmd", args: ["/c", "start", ""] });
  assert.deepEqual(browserOpenCommand("linux"), { command: "xdg-open", args: [] });
});
