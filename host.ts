import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { mirrorHostContract } from "./provider/contracts";
export { experimental_providerBridge } from "./provider/bridge";

export default experimental_defineHostEntry({
  contract: mirrorHostContract,
  handlers: {
    async workspace({ mirrorId }, context) {
      // Dedicated empty directory, never the user's checkout; SDK validates UUID.
      const path = join(
        context.experimental_paths.dataDir,
        "mirror-workspaces",
        mirrorId,
      );
      await mkdir(path, { recursive: true, mode: 0o700 });
      return { path };
    },
  },
});
