import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { IdleStatus, RetryStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
		setKeybindings(new KeybindingsManager());
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});

	it("shows the clear binding when the interrupt binding is disabled", () => {
		initTheme("dark");
		vi.useFakeTimers();
		setKeybindings(new KeybindingsManager({ "app.interrupt": [] }));
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);

		const rendered = indicator
			.render(120)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");

		expect(rendered).toContain("(ctrl+c to cancel)");
		indicator.dispose();
	});
});
