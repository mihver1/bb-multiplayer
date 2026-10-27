# Your own BB. One team context.

Connect independent BB installations to a shared, self-hosted project room.
Keep agent execution, worktrees, terminals and provider keys local while your team
discusses explicitly shared conversations.

- Team page with members, last-seen presence and near-live thread previews.
- A movable **Team** floating widget in the main thread — no side panel required.
- Message-anchored discussion branches: each root comment keeps its replies
  underneath, with resolve/reopen and collapsible resolved replies. Message
  actions open the widget with the selected quotation.
- Add selected feedback to **your own agent's draft** — never auto-execute remote comments.
- One-use invitations, individual credentials and revocation.
- Durable sync recovery after disconnects and restarts.

**Experimental pilot:** one project/room per installation, bounded text previews,
2-second sync. Requires running the included relay behind HTTPS for remote users.
No E2EE or automatic secret redaction. Review conversations before sharing;
pausing does not retract already published content.

See README.md for installation, server setup, trust boundaries and current limits.
