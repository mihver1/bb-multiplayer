import { useState, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Identity } from "../shared/protocol";
import type { rpcContract } from "../server";
import { Button } from "./ui/button";

/** A deliberate owner action; UI visibility is not an authorization boundary. */
export function MemberAdministration({
  projectId,
  identity,
  online,
  onChanged,
}: {
  projectId: string;
  identity: Identity;
  online: boolean;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmation, setConfirmation] = useState<{
    memberId: string;
    admin: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  if (identity.member.role !== "owner" || identity.member.revoked) return null;
  if (identity.capabilities?.memberAdministration !== true)
    return (
      <p className="text-xs text-muted-foreground">
        Upgrade the relay to appoint administrators. Existing collaboration
        remains available.
      </p>
    );
  const members = identity.members.filter(
    (m) => m.role === "member" && !m.revoked && m.id !== identity.member.id,
  );
  const target = members.find((m) => m.id === confirmation?.memberId);
  return (
    <section
      aria-label="Administrator management"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <h3 className="text-sm font-semibold">Administrators</h3>
      <p className="text-xs text-muted-foreground">
        Administrators can create and connect new project rooms on this server.
        They cannot appoint administrators or manage members of this room. They
        own rooms they create; removing administrator rights does not remove
        those rooms or their ownership.
      </p>
      {!members.length && (
        <p className="text-xs text-muted-foreground">
          Invite a teammate first, then appoint them here after they join.
        </p>
      )}
      {members.map((member) => (
        <div
          key={member.id}
          className="flex items-center justify-between gap-3 text-sm"
        >
          <span>
            {member.name} · {member.admin ? "Administrator" : "Member"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !online}
            aria-label={`${member.admin ? "Remove administrator rights from" : "Make administrator:"} ${member.name}`}
            onClick={() => {
              setConfirmation({ memberId: member.id, admin: !member.admin });
              setError(null);
            }}
          >
            {member.admin ? "Remove administrator" : "Make administrator"}
          </Button>
        </div>
      ))}
      {target && confirmation && (
        <div
          role="group"
          aria-label="Confirm administrator change"
          className="space-y-2 border-t border-border pt-3"
        >
          <p className="text-sm">
            {confirmation.admin
              ? `Allow ${target.name} to create new rooms on this server?`
              : `Remove ${target.name}'s permission to create new rooms using this membership? Rooms they already own are unaffected.`}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !online}
              onClick={() => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                setError(null);
                void rpc
                  .call("setMemberAdmin", { projectId, ...confirmation })
                  .then(
                    () => {
                      setConfirmation(null);
                      onChanged();
                    },
                    (cause) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not change administrator rights",
                      ),
                  )
                  .finally(() => {
                    lock.current = false;
                    setBusy(false);
                  });
              }}
            >
              Confirm {confirmation.admin ? "appointment" : "removal"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
