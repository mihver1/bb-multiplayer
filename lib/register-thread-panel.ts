import type { ComponentType } from "react";
import type { JsonValue, PluginAppBuilder } from "@get-bb/plugin-sdk/app";

/** BB 0.46 / SDK 0.6.49 uses threadPanelAction. Prefer the unified tab API
 * on newer BB, but keep the installed server's published baseline type-safe.
 * Remove this adapter when the minimum host SDK moves to 0.6.79.
 */
export function registerThreadPanel(
  app: PluginAppBuilder,
  component: ComponentType<{ threadId: string; params: JsonValue | null }>,
) {
  const registration = {
    id: "discussion",
    title: "Multiplayer",
    icon: "multiplayer/people" as const,
    component,
  };
  const slots = app.slots as typeof app.slots & {
    experimental_tab?: (
      input: typeof registration & {
        context: { kind: "thread" };
        availability: "action";
      },
    ) => void;
  };
  if (typeof slots.experimental_tab === "function") {
    slots.experimental_tab({
      ...registration,
      context: { kind: "thread" },
      availability: "action",
    });
  } else {
    app.slots.threadPanelAction(registration);
  }
}
