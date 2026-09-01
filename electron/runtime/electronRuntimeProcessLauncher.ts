import { utilityProcess } from "electron";
import type { RuntimeProcessLauncher } from "@freebuddy/runtime-host";

export function createElectronRuntimeProcessLauncher(): RuntimeProcessLauncher {
  return {
    launch(input) {
      const child = utilityProcess.fork(input.entryPath, [], {
        serviceName: "freebuddy-runtime",
        stdio: "pipe",
        env: input.env
      });
      return {
        pid: child.pid,
        send(message) {
          child.postMessage(message);
        },
        onMessage(handler) {
          // UtilityProcess emits the deserialized message itself. Unlike a
          // MessagePort "message" event, there is no wrapping `{ data }`
          // object on the host side.
          const listener = (message: unknown) => handler(message);
          child.on("message", listener);
          return () => child.off("message", listener);
        },
        onExit(handler) {
          const listener = (code: number) => handler(code);
          child.on("exit", listener);
          return () => child.off("exit", listener);
        },
        kill() {
          child.kill();
        }
      };
    }
  };
}
