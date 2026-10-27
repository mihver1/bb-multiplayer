import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { name } from "../shared/protocol";
import { RelayStore } from "./store";
import { createRelayServer } from "./http";

process.umask(0o077);
const data = resolve(process.env.MULTIPLAYER_DATA_DIR ?? ".multiplayer");
await mkdir(data, { recursive: true, mode: 0o700 });
const dbPath = resolve(data, "relay.db");
const db = new Database(dbPath);
await chmod(dbPath, 0o600);
const store = new RelayStore(db);
const command = process.argv[2];
if (command === "init") {
  const roomName = name.parse(
    process.env.MULTIPLAYER_ROOM_NAME ?? "Our project",
  );
  const ownerName = name.parse(process.env.MULTIPLAYER_OWNER_NAME ?? "Owner");
  const output = resolve(data, "owner-credential.json");
  try {
    await readFile(output);
    throw new Error("Credential file already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credential = store.initialize(roomName, ownerName);
  await writeFile(output, JSON.stringify(credential, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Initialized room. Owner credential saved privately to ${output}. Do not commit or share this file.`,
  );
  db.close();
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
} else {
  db.close();
  throw new Error("Usage: tsx relay/main.ts init | serve");
}
