import { mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { name, uuid } from "../shared/protocol";
import { RelayStore } from "./store";
import { createRelayServer } from "./http";
import { createRoomCredential } from "./admin";

const command = process.argv[2];
const after = process.argv[3];
if (
  !["init", "create-room", "list-rooms", "serve"].includes(command) ||
  process.argv.length > (command === "list-rooms" ? 4 : 3)
)
  throw new Error(
    "Usage: tsx relay/main.ts init | create-room | list-rooms [after-room-id] | serve",
  );
const afterRoomId = after === undefined ? "" : uuid.parse(after);

process.umask(0o077);
const data = resolve(process.env.MULTIPLAYER_DATA_DIR ?? ".multiplayer");
await mkdir(data, { recursive: true, mode: 0o700 });
const dbPath = resolve(data, "relay.db");
const db = new Database(dbPath);
await chmod(dbPath, 0o600);
const store = new RelayStore(db);
if (command === "init" || command === "create-room") {
  try {
    const roomName = name.parse(
      process.env.MULTIPLAYER_ROOM_NAME ?? "Our project",
    );
    const ownerName = name.parse(process.env.MULTIPLAYER_OWNER_NAME ?? "Owner");
    const { roomId, output } = createRoomCredential(store, {
      dataDirectory: data,
      roomName,
      ownerName,
      initialize: command === "init",
    });
    console.log(
      `Created room ${roomId}. Owner credential saved privately to ${output}. Do not commit or share this file.`,
    );
  } finally {
    db.close();
  }
} else if (command === "list-rooms") {
  try {
    console.log(JSON.stringify(store.listRooms(afterRoomId), null, 2));
  } finally {
    db.close();
  }
} else if (command === "serve") {
  const host = process.env.MULTIPLAYER_HOST ?? "127.0.0.1";
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.MULTIPLAYER_PORT ?? "4789");
  const server = createRelayServer(store);
  server.listen(port, host, () =>
    console.log(
      `Multiplayer relay listening on ${host}:${port}. Use a TLS reverse proxy for remote clients.`,
    ),
  );
  const stop = () =>
    server.close(() => {
      db.close();
    });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
