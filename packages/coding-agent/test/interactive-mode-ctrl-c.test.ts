import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type HandleCtrlCContext = {
	session: {
		isRetrying: boolean;
		abortRetry: () => void;
	};
	lastSigintTime: number;
	clearEditor: () => void;
	shutdown: () => Promise<void>;
};

type InteractiveModePrototypeWithHandleCtrlC = {
	handleCtrlC(this: HandleCtrlCContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeWithHandleCtrlC;

function callHandleCtrlC(context: HandleCtrlCContext): void {
	interactiveModePrototype.handleCtrlC.call(context);
}

function createContext(isRetrying: boolean): HandleCtrlCContext {
	return {
		session: {
			isRetrying,
			abortRetry: vi.fn(),
		},
		lastSigintTime: 0,
		clearEditor: vi.fn(),
		shutdown: vi.fn(async () => undefined),
	};
}

describe("InteractiveMode.handleCtrlC", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("aborts an active retry without starting the quit sequence", () => {
		const context = createContext(true);
		context.lastSigintTime = 900;

		callHandleCtrlC(context);

		expect(context.session.abortRetry).toHaveBeenCalledTimes(1);
		expect(context.clearEditor).not.toHaveBeenCalled();
		expect(context.shutdown).not.toHaveBeenCalled();
		expect(context.lastSigintTime).toBe(0);
	});

	test("retains clear then double-press quit behavior when not retrying", () => {
		const context = createContext(false);
		const now = vi.spyOn(Date, "now");
		now.mockReturnValueOnce(1000).mockReturnValueOnce(1200);

		callHandleCtrlC(context);
		callHandleCtrlC(context);

		expect(context.session.abortRetry).not.toHaveBeenCalled();
		expect(context.clearEditor).toHaveBeenCalledTimes(1);
		expect(context.shutdown).toHaveBeenCalledTimes(1);
		expect(context.lastSigintTime).toBe(1000);
	});
});
