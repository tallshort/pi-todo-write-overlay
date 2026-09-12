import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import todoWriteOverlayExtension, {
	applyTodoPatch,
	applyTodoWrite,
	getTodoOverlayVisibility,
	normalizeTodoWriteParams,
	parseMaxVisibleTasksCommand,
	parseTodoOverlayCommand,
	parseTodoOverlayTitleCommand,
	planTodoOverlayRows,
	renderTodoOverlayPlainLines,
	renderTodoWriteSummary,
	restoreTodoWriteState,
	shouldIncrementTodoTurn,
} from "./index.ts";

describe("todo-write-overlay helpers", () => {
	it("infers patch when op is omitted but patch fields are present", () => {
		expect(normalizeTodoWriteParams({ set: [{ id: "task-1", status: "completed" }] })).toEqual({
			op: "patch",
			set: [{ id: "task-1", status: "completed" }],
			add: undefined,
			remove: undefined,
		});
	});

	it("requires explicit todos for replace and explicit todos: [] for clearing", () => {
		expect(() => normalizeTodoWriteParams({})).toThrow("requires an explicit");
		expect(() => normalizeTodoWriteParams({ op: "replace" })).toThrow("requires an explicit");
		expect(normalizeTodoWriteParams({ todos: [] })).toEqual({ op: "replace", todos: [] });
	});

	it("rejects mixed replace and patch fields before state changes", () => {
		expect(() => normalizeTodoWriteParams({ todos: [], set: [] })).toThrow("cannot include");
		expect(() => normalizeTodoWriteParams({ op: "patch", todos: [] })).toThrow('cannot include "todos"');
	});

	it("preserves explicit empty patches as no-ops", () => {
		expect(normalizeTodoWriteParams({ op: "patch" })).toEqual({
			op: "patch",
			set: undefined,
			add: undefined,
			remove: undefined,
		});
	});

	it("parses todo overlay command actions", () => {
		expect(parseTodoOverlayCommand("")).toBe("status");
		expect(parseTodoOverlayCommand(" full ")).toBe("full");
		expect(parseTodoOverlayCommand("COMPACT")).toBe("compact");
		expect(parseTodoOverlayCommand("hide")).toBe("hide");
		expect(parseTodoOverlayCommand("hide-once")).toBe("hide-once");
		expect(parseTodoOverlayCommand("max-visible 12")).toBe("max-visible");
		expect(parseTodoOverlayCommand("title Sprint tasks")).toBe("title");
		expect(parseTodoOverlayCommand('title ""')).toBe("title");
		expect(parseTodoOverlayCommand("max-visible 0")).toBe("invalid");
		expect(parseTodoOverlayCommand("show")).toBe("invalid");
	});

	it("parses positive max-visible values", () => {
		expect(parseMaxVisibleTasksCommand("max-visible 12")).toBe(12);
		expect(parseMaxVisibleTasksCommand("MAX-VISIBLE 1")).toBe(1);
		expect(parseMaxVisibleTasksCommand("max-visible 0")).toBeUndefined();
		expect(parseMaxVisibleTasksCommand("max-visible 1.5")).toBeUndefined();
		expect(parseMaxVisibleTasksCommand("max-visible 9007199254740992")).toBeUndefined();
	});

	it("parses quoted and empty title values", () => {
		expect(parseTodoOverlayTitleCommand("title Sprint tasks")).toEqual({ title: "Sprint tasks" });
		expect(parseTodoOverlayTitleCommand('TITLE  "Release checklist"  ')).toEqual({ title: "Release checklist" });
		expect(parseTodoOverlayTitleCommand('title ""')).toEqual({ title: undefined });
		expect(parseTodoOverlayTitleCommand("title 'My TODO'")).toEqual({ title: "My TODO" });
		expect(parseTodoOverlayTitleCommand("title ''")).toEqual({ title: undefined });
		expect(parseTodoOverlayTitleCommand("title 'Release \\'TODO\\''")).toEqual({ title: "Release 'TODO'" });
		expect(parseTodoOverlayTitleCommand('title "Release \\"TODO\\""')).toEqual({ title: 'Release "TODO"' });
		expect(parseTodoOverlayTitleCommand("title")).toBeUndefined();
		expect(parseTodoOverlayTitleCommand("title   ")).toBeUndefined();
		expect(parseTodoOverlayTitleCommand('title "unterminated')).toBeUndefined();
	});

	it("normalizes multiple in-progress tasks", () => {
		const applied = applyTodoWrite([
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "in_progress" },
			{ content: "third", status: "pending" },
		]);

		expect(applied.state.tasks.map((task) => task.status)).toEqual(["in_progress", "pending", "pending"]);
	});

	it("patches task status without resending the whole list", () => {
		const base = applyTodoWrite([
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "pending" },
		]).state;

		const patched = applyTodoPatch(base, {
			set: [
				{ id: "task-1", status: "completed" },
				{ id: "task-2", status: "in_progress" },
			],
		});

		expect(patched.warnings).toEqual([]);
		expect(patched.state.tasks.map((task) => task.status)).toEqual(["completed", "in_progress"]);
	});

	it("adds tasks with fresh non-colliding ids and removes by id", () => {
		const base = applyTodoWrite([{ content: "first", status: "in_progress" }]).state;

		const added = applyTodoPatch(base, {
			add: [{ content: "second", status: "pending" }],
		});
		expect(added.state.tasks.map((task) => task.id)).toEqual(["task-1", "task-2"]);

		const removed = applyTodoPatch(added.state, { remove: ["task-1"] });
		expect(removed.state.tasks.map((task) => task.id)).toEqual(["task-2"]);
		expect(removed.state.tasks[0]?.status).toBe("in_progress");
	});

	it("warns when a patch references an unknown id", () => {
		const base = applyTodoWrite([{ content: "first", status: "in_progress" }]).state;
		const result = applyTodoPatch(base, { set: [{ id: "task-9", status: "completed" }] });
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("task-9");
	});

	it("renders overlay plain lines without completed-item folding", () => {
		const applied = applyTodoWrite([
			{ content: "A", status: "completed" },
			{ content: "B", status: "completed" },
			{ content: "C", status: "completed", notes: "kept visible" },
		]);

		expect(renderTodoOverlayPlainLines(applied.state)).toEqual(["✓ A", "✓ B", "✓ C"]);
		expect(renderTodoWriteSummary(applied.state)).toContain("Progress: 3/3 done");
	});

	it("uses activeForm for the active overlay line", () => {
		const applied = applyTodoWrite([
			{ content: "Design", status: "completed" },
			{ content: "Implement", status: "in_progress", activeForm: "Implementing" },
			{ content: "Verify", status: "pending" },
		]);

		expect(renderTodoOverlayPlainLines(applied.state)).toEqual(["✓ Design", "→ Implementing", "○ Verify"]);
	});

	it("caps full-mode rows while retaining the active task and a completed summary", () => {
		const applied = applyTodoWrite([
			{ content: "Completed 1", status: "completed" },
			{ content: "Completed 2", status: "completed" },
			{ content: "Completed 3", status: "completed" },
			{ content: "Completed 4", status: "completed" },
			{ content: "Active", status: "in_progress" },
			{ content: "Pending 1", status: "pending" },
			{ content: "Pending 2", status: "pending" },
			{ content: "Pending 3", status: "pending" },
			{ content: "Pending 4", status: "pending" },
			{ content: "Pending 5", status: "pending" },
			{ content: "Pending 6", status: "pending" },
			{ content: "Pending 7", status: "pending" },
			{ content: "Pending 8", status: "pending" },
			{ content: "Pending 9", status: "pending" },
			{ content: "Pending 10", status: "pending" },
		]);

		const rows = planTodoOverlayRows(applied.state);
		expect(rows).toHaveLength(8);
		expect(rows[0]).toEqual({ kind: "completed-summary", count: 4 });
		expect(rows[1]).toMatchObject({ kind: "task", task: { content: "Active", status: "in_progress" } });
		expect(rows.filter((row) => row.kind === "task").map((row) => row.task.content)).toEqual([
			"Active",
			"Pending 1",
			"Pending 2",
			"Pending 3",
			"Pending 4",
			"Pending 5",
			"Pending 6",
		]);
	});

	it("increments turns only for final assistant messages", () => {
		expect(shouldIncrementTodoTurn({ role: "assistant", stopReason: "stop" })).toBe(true);
		expect(shouldIncrementTodoTurn({ role: "assistant", stopReason: "toolUse" })).toBe(false);
		expect(shouldIncrementTodoTurn({ role: "toolResult" })).toBe(false);
		expect(shouldIncrementTodoTurn({ role: "user" })).toBe(false);
	});

	it("hides fully completed overlays after the grace period", () => {
		const applied = applyTodoWrite([{ content: "Done", status: "completed" }]);
		const now = Date.now();
		expect(getTodoOverlayVisibility(applied.state, { completedAt: now, completedTurn: 1 }, 1, now)).toMatchObject({
			hidden: false,
			completionGraceActive: true,
		});
		expect(
			getTodoOverlayVisibility(applied.state, { completedAt: now - 91_000, completedTurn: 1 }, 3, now),
		).toMatchObject({ hidden: true, completionGraceActive: false });
	});

	it("restores legacy persisted tasks", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "/tmp/project/session.json",
				getBranch: () => [
					{
						type: "custom",
						customType: "todo-write-overlay-state",
						data: {
							tasks: [
								{ id: "task-1", content: "cleanup", status: "abandoned" },
								{ id: "task-2", content: "ship", status: "pending" },
							],
							updatedAt: Date.now(),
						},
					},
				],
			},
		} as unknown as ExtensionContext;

		const restored = restoreTodoWriteState(ctx);
		expect(restored.tasks.map((task) => task.status)).toEqual(["completed", "in_progress"]);
	});
	it("uses the latest state when the overlay opens after a subsequent update", async () => {
		type OverlayFactory = (
			tui: { requestRender(): void },
			theme: {
				fg(_color: string, text: string): string;
				bold(text: string): string;
				strikethrough(text: string): string;
			},
			keybindings: unknown,
			done: () => void,
		) => { render(width: number): string[] };
		type RegisteredTodoTool = { execute(...args: unknown[]): Promise<unknown> };

		let createOverlay: OverlayFactory | undefined;
		let todoTool: RegisteredTodoTool | undefined;
		const pi = {
			appendEntry: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerTool: (tool: unknown) => {
				todoTool = tool as RegisteredTodoTool;
			},
			on: () => {},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: "/tmp/overlay-opening-race",
			hasUI: true,
			sessionManager: { getSessionFile: () => "/tmp/overlay-opening-race/session.json" },
			ui: {
				custom: (factory: unknown) => {
					createOverlay = factory as OverlayFactory;
					return new Promise<void>(() => {});
				},
			},
		} as unknown as ExtensionContext;

		await todoWriteOverlayExtension(pi);
		if (!todoTool) throw new Error("todo_write was not registered");
		await todoTool.execute("first", { todos: [{ content: "Initial", status: "in_progress" }] }, undefined, undefined, ctx);
		await todoTool.execute(
			"second",
			{ set: [{ id: "task-1", content: "Updated while opening" }] },
			undefined,
			undefined,
			ctx,
		);
		if (!createOverlay) throw new Error("overlay factory was not registered");

		const component = createOverlay(
			{ requestRender: () => {} },
			{ fg: (_color, text) => text, bold: (text) => text, strikethrough: (text) => text },
			undefined,
			() => {},
		);
		const rendered = component.render(42).join("\n");
		expect(rendered).toContain("Updated while opening");
	});
});
