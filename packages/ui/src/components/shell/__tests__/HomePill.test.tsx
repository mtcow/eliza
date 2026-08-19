/**
 * Verifies the deterministic click-only resting pill contract with a real
 * jsdom render and no native host or model runtime.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  certifyWidget,
  type GeometryProvider,
} from "../../../testing/widget-cert";
import { HOLD_THRESHOLD_MS, HomePill } from "../HomePill";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HomePill", () => {
  it("renders the canonical visible 64x44 resting target", () => {
    const { container } = render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />,
    );
    const button = screen.getByRole("button", { name: /open eliza/i });
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-16");
    expect(button.className).toContain("pointer-events-auto");
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("bg-[#181a20]/95");
    expect(screen.getByTestId("shell-home-pill-mark").className).toContain(
      "w-12",
    );

    const geometry: GeometryProvider = {
      box: (element) =>
        element === button
          ? { top: 0, left: 0, width: 64, height: 44 }
          : { top: 0, left: 0, width: 0, height: 0 },
      computed: () => ({ overflowX: "visible", overflowY: "visible" }),
    };
    expect(
      certifyWidget("resting-pill", container, geometry, {
        dimensions: ["tap-target"],
      }),
    ).toMatchObject({ passed: true, violations: [] });
  });

  it("uses the same exact painted target in a detached native host", () => {
    render(
      <HomePill
        phase="idle"
        onOpen={() => {}}
        onClose={() => {}}
        tightNativeHitbox
      />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("mb-0");
    expect(button.className).not.toContain("pt-10");
    expect(button.className).not.toContain("px-8");
  });

  it("is click-only and opens exactly once after an arbitrarily long press", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="idle" onOpen={onOpen} onClose={() => {}} />);
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(button, { button: 0, pointerType: "mouse" });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("retains hold-to-talk when a non-macOS host supplies voice handlers", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    render(
      <HomePill
        phase="idle"
        onOpen={onOpen}
        onClose={() => {}}
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
      />,
    );
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 1);
    fireEvent.pointerUp(button, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(button);

    expect(onHoldStart).toHaveBeenCalledOnce();
    expect(onHoldEnd).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("cancels a held utterance when the pointer slides off the pill", () => {
    vi.useFakeTimers();
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    const onHoldCancel = vi.fn();
    render(
      <HomePill
        phase="idle"
        onOpen={() => {}}
        onClose={() => {}}
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
        onHoldCancel={onHoldCancel}
      />,
    );
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 1);
    fireEvent.pointerUp(button, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 100,
      clientY: 10,
    });

    expect(onHoldStart).toHaveBeenCalledOnce();
    expect(onHoldCancel).toHaveBeenCalledOnce();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  it("does not change geometry on hover", () => {
    render(<HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />);
    const button = screen.getByRole("button");
    const before = button.className;
    fireEvent.mouseEnter(button);
    expect(button.className).toBe(before);
    expect(button.className).not.toContain("w-[600px]");
    expect(button.className).not.toContain("w-[36rem]");
  });

  it("closes through the same click path when the shell is open", () => {
    const onClose = vi.fn();
    render(<HomePill phase="summoned" onOpen={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close eliza/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens from a closed pill while a voice response is active", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      <HomePill
        phase="responding"
        open={false}
        onOpen={onOpen}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open eliza/i }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps authentication state accessible without changing pill geometry", () => {
    render(
      <HomePill
        phase="needs-auth"
        signingIn
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: /signing in/i });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-16");
  });
});
