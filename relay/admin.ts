import {
  closeSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { RelayStore } from "./store";

/** Local operator provisioning; never return or print the bearer credential. */
export function createRoomCredential(
  store: RelayStore,
  options: {
    dataDirectory: string;
    roomName: string;
    ownerName: string;
    initialize?: boolean;
  },
) {
  let createdFile: string | undefined;
  try {
    // Keep the database change uncommitted until the private file is flushed.
    // A failed write must not leave a room whose owner credential was lost.
    return store.db.transaction(() => {
      const credential = options.initialize
        ? store.initialize(options.roomName, options.ownerName)
        : store.createRoom(options.roomName, options.ownerName);
      const output = resolve(
        options.dataDirectory,
        options.initialize
          ? "owner-credential.json"
          : `owner-credential-${credential.roomId}.json`,
      );
      const file = openSync(output, "wx", 0o600);
      createdFile = output;
      try {
        writeFileSync(file, JSON.stringify(credential, null, 2) + "\n");
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      return { roomId: credential.roomId, output };
    })();
  } catch (error) {
    // Never remove an existing file when exclusive creation fails.
    if (createdFile) unlinkSync(createdFile);
    throw error;
  }
}
