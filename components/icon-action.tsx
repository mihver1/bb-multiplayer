import { forwardRef } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Button, type ButtonProps } from "./ui/button";
import { cn } from "../lib/utils";

/** Compact controls keep an accessible name and a hover/focus explanation,
 * including while disabled (e.g. before selecting feedback).
 */
export const IconAction = forwardRef<
  HTMLButtonElement,
  ButtonProps & { label: string; hint?: string }
>(function IconAction(
  {
    label,
    hint = label,
    className,
    children,
    type = "button",
    variant = "ghost",
    ...props
  },
  ref,
) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            className="inline-flex shrink-0"
            tabIndex={props.disabled ? 0 : undefined}
            aria-label={props.disabled ? hint : undefined}
          >
            <Button
              {...props}
              ref={ref}
              type={type}
              variant={variant}
              size="icon"
              aria-label={label}
              className={cn(
                "size-7 shrink-0 text-muted-foreground hover:text-foreground",
                className,
              )}
            >
              {children}
            </Button>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          >
            {hint}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
});

export function SharingSettingsGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-glyph="sharing-settings"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="9" cy="18" r="2" />
    </svg>
  );
}

export function PostCommentGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-glyph="post-comment"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5m-6 6 6-6 6 6" />
    </svg>
  );
}

export function MessageToDraftGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-glyph="message-to-draft"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 18H8l-5 3V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5" />
      <path d="M13 16h8m-3-3 3 3-3 3" />
    </svg>
  );
}
