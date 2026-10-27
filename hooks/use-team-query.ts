import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";

export function useTeamQuery<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const current = ++generation.current;
    void load().then(
      (value) => {
        if (current === generation.current) {
          setData(value);
          setError(null);
        }
      },
      (cause) => {
        if (current === generation.current)
          setError(
            cause instanceof Error ? cause.message : "Could not load team data",
          );
      },
    );
  }, [load]);
  useEffect(() => {
    setData(null);
    refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  useRealtime("changed", refresh);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);
  return { data, error, refresh };
}
