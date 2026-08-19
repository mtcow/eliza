/** Renders the canonical resting pill and its optional hold-to-talk gesture. */

import * as React from "react";

import { useBranding } from "../../config/branding";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { RestingPillButton } from "./RestingPillButton";
import type { ShellPhase } from "./shell-state";

export interface HomePillProps {
  phase: ShellPhase;
  /** Actual overlay state; voice may respond while the pill remains closed. */
  open?: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Begin hold-to-talk capture; absent for the click-only macOS detached pill. */
  onHoldStart?: () => void;
  /** Finish an active hold-to-talk capture and send it. */
  onHoldEnd?: () => void;
  /** Cancel an active hold without sending. */
  onHoldCancel?: () => void;
  speaking?: boolean;
  signingIn?: boolean;
  /** Removes the ordinary in-page bottom margin in the exact native frame. */
  tightNativeHitbox?: boolean;
}

/**
 * Persistent launcher trigger. Hosts may opt into the established hold-to-talk
 * quasimode; the macOS detached pill deliberately omits those handlers.
 */
export function HomePill({
  phase,
  open,
  onOpen,
  onClose,
  onHoldStart,
  onHoldEnd,
  onHoldCancel,
  speaking = false,
  signingIn = false,
  tightNativeHitbox = false,
}: HomePillProps): React.JSX.Element {
  const { appName } = useBranding();
  const needsAuth = phase === "needs-auth";
  const isOpen = open ?? (phase === "summoned" || phase === "responding");
  const holdTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdActiveRef = React.useRef(false);
  const pressPointRef = React.useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = React.useRef(false);
  const onHoldStartRef = React.useRef(onHoldStart);
  const onHoldEndRef = React.useRef(onHoldEnd);
  const onHoldCancelRef = React.useRef(onHoldCancel);
  onHoldStartRef.current = onHoldStart;
  onHoldEndRef.current = onHoldEnd;
  onHoldCancelRef.current = onHoldCancel;

  const clearHoldTimer = React.useCallback(() => {
    if (holdTimerRef.current === null) return;
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }, []);

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (needsAuth || !onHoldStartRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      pressPointRef.current = { x: event.clientX, y: event.clientY };
      suppressClickRef.current = false;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // error-policy:J4 Pointer capture is an optional browser enhancement;
        // the target-local down/up path remains functional when unavailable.
      }
      clearHoldTimer();
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        holdActiveRef.current = true;
        suppressClickRef.current = true;
        onHoldStartRef.current?.();
      }, HOLD_THRESHOLD_MS);
    },
    [clearHoldTimer, needsAuth],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      clearHoldTimer();
      if (!holdActiveRef.current) return;
      holdActiveRef.current = false;
      const origin = pressPointRef.current;
      pressPointRef.current = null;
      const dx = origin ? event.clientX - origin.x : 0;
      const dy = origin ? event.clientY - origin.y : 0;
      if (Math.hypot(dx, dy) > SLIDE_CANCEL_PX) {
        onHoldCancelRef.current?.();
        return;
      }
      onHoldEndRef.current?.();
    },
    [clearHoldTimer],
  );

  const handlePointerCancel = React.useCallback(() => {
    clearHoldTimer();
    pressPointRef.current = null;
    if (!holdActiveRef.current) return;
    holdActiveRef.current = false;
    onHoldCancelRef.current?.();
  }, [clearHoldTimer]);

  React.useEffect(() => {
    if (phase !== "listening") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !holdActiveRef.current) return;
      holdActiveRef.current = false;
      clearHoldTimer();
      pressPointRef.current = null;
      onHoldCancelRef.current?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [clearHoldTimer, phase]);

  React.useEffect(() => clearHoldTimer, [clearHoldTimer]);

  const handleClick = React.useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (isOpen) onClose();
    else onOpen();
  }, [isOpen, onClose, onOpen]);

  const label = needsAuth
    ? signingIn
      ? `Signing in to ${appName} Cloud`
      : `Sign in with ${appName} Cloud`
    : phase === "listening"
      ? `${appName} is listening — release to send`
      : phase === "processing"
        ? `${appName} is transcribing your words`
        : speaking
          ? `${appName} is speaking`
          : isOpen
            ? `Close ${appName}`
            : `Open ${appName}`;

  return (
    <RestingPillButton
      aria-label={label}
      aria-busy={needsAuth && signingIn ? true : undefined}
      aria-pressed={needsAuth ? undefined : isOpen}
      data-phase={phase}
      data-speaking={speaking || undefined}
      data-testid="shell-home-pill"
      markTestId="shell-home-pill-mark"
      breathing={phase === "booting" || phase === "responding"}
      markClassName={cn(
        phase === "booting" && "opacity-65",
        phase === "responding" &&
          (speaking
            ? "shadow-[0_0_14px_rgba(255,138,42,0.85)]"
            : "shadow-[0_0_10px_rgba(255,138,42,0.6)]"),
      )}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{ zIndex: Z_SHELL_OVERLAY }}
      className={tightNativeHitbox ? "mb-0" : "mb-2"}
    />
  );
}

/** Press duration that distinguishes a click from hold-to-talk. */
export const HOLD_THRESHOLD_MS = 150;

/** Pointer travel that cancels an active hold instead of sending. */
export const SLIDE_CANCEL_PX = 44;
