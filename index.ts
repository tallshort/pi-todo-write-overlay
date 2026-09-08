import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Key, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

type TodoTask = {
	id: string;
	content: string;
	status: TodoStatus;
	activeForm?: string;
	notes?: string;
};

type TodoOverlayDisplayMode = "full" | "compact";

type TodoOverlaySettings = {
	displayMode: TodoOverlayDisplayMode;
	title?: string;
};

type TodoState = {
	tasks: TodoTask[];
};

type TodoOverlayRecord = {
	opening: boolean;
	component?: TodoOverlayComponent;
	handle?: OverlayHandle;
	close?: () => void;
};

const StatusEnum = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
	description: "Task status",
});

const InputTask = Type.Object({
	content: Type.String({ description: "Task description" }),
	status: StatusEnum,
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous label shown while in progress (for example, 'Running tests')",
		}),
	),
	notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
});

const PatchSetTask = Type.Object({
	id: Type.String({ description: "Task ID to update; use the task-N value shown by the previous todo_write result." }),
	content: Type.Optional(Type.String({ description: "Task description (only when changing it)" })),
	status: Type.Optional(StatusEnum),
	activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while in progress" })),
	notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
});

const TodoWriteParams = Type.Object(
	{
		op: Type.Optional(
			Type.Union([Type.Literal("replace"), Type.Literal("patch")], {
				description:
					"replace (default): replace the complete list with todos. patch: send only changes through set/add/remove; this is cheaper for larger lists.",
			}),
		),
		todos: Type.Optional(Type.Array(InputTask, { description: "Complete task list when op=replace" })),
		set: Type.Optional(Type.Array(PatchSetTask, { description: "Partial updates to existing tasks when op=patch" })),
		add: Type.Optional(Type.Array(InputTask, { description: "Tasks to add when op=patch" })),
		remove: Type.Optional(Type.Array(Type.String(), { description: "Task IDs to remove when op=patch" })),
	},
	{ additionalProperties: true },
);

type InputTaskType = Static<typeof InputTask>;
type PatchSetTaskType = Static<typeof PatchSetTask>;
type TodoWriteParamsType = Static<typeof TodoWriteParams>;

type NormalizedTodoWriteCommand =
	| { op: "replace"; todos: InputTaskType[] }
	| { op: "patch"; set?: PatchSetTaskType[]; add?: InputTaskType[]; remove?: string[] };

export function normalizeTodoWriteParams(params: TodoWriteParamsType): NormalizedTodoWriteCommand {
	const hasOwn = (key: keyof TodoWriteParamsType): boolean => Object.hasOwn(params, key);
	const hasTodos = hasOwn("todos");
	const patchFields = (["set", "add", "remove"] as const).filter(hasOwn);
	const hasPatchFields = patchFields.length > 0;
	const op = params.op ?? (hasPatchFields ? "patch" : "replace");

	if (op === "replace") {
		if (!hasTodos) throw new Error('todo_write replace requires an explicit "todos" array. Use todos: [] to clear.');
		if (hasPatchFields) throw new Error("todo_write replace cannot include set, add, or remove fields.");
		return { op, todos: params.todos ?? [] };
	}

	if (hasTodos) throw new Error('todo_write patch cannot include "todos".');
	return { op, set: params.set, add: params.add, remove: params.remove };
}

const todoStateStore = new Map<string, TodoState>();
const todoOverlayStore = new Map<string, TodoOverlayRecord>();
const todoOverlayMetaStore = new Map<string, { completedAt?: number; completedTurn?: number }>();
const todoOverlayAgentRunningStore = new Map<string, boolean>();
const todoOverlayHiddenStore = new Map<string, boolean>();
const todoTurnStore = new Map<string, number>();
const TODO_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TODO_SPINNER_INTERVAL_MS = 120;
const TODO_HIDE_COMPLETED_AFTER_TURNS = 2;
const TODO_HIDE_COMPLETED_AFTER_MS = 90_000;
const TODO_STATE_ENTRY_TYPE = "todo-write-overlay-state";
const TODO_OVERLAY_SETTINGS_FILE = join(homedir(), CONFIG_DIR_NAME, "todo-write-overlay.json");
let todoOverlayDisplayMode: TodoOverlayDisplayMode = "full";
let todoOverlayTitle: string | undefined = "TODO";
function createEmptyState(): TodoState {
	return { tasks: [] };
}

function isTodoOverlayDisplayMode(value: unknown): value is TodoOverlayDisplayMode {
	return value === "full" || value === "compact";
}

async function loadTodoOverlaySettings(): Promise<TodoOverlaySettings> {
	try {
		const settings = JSON.parse(await readFile(TODO_OVERLAY_SETTINGS_FILE, "utf8")) as Partial<TodoOverlaySettings>;
		return {
			displayMode: isTodoOverlayDisplayMode(settings.displayMode) ? settings.displayMode : "full",
			title: typeof settings.title === "string" && settings.title.trim() ? settings.title : undefined,
		};
	} catch {
		return { displayMode: "full", title: "TODO" };
	}
}

async function persistTodoOverlayDisplayMode(displayMode: TodoOverlayDisplayMode): Promise<void> {
	await mkdir(dirname(TODO_OVERLAY_SETTINGS_FILE), { recursive: true });
	const settings: TodoOverlaySettings = {
		displayMode,
		...(todoOverlayTitle === undefined ? {} : { title: todoOverlayTitle }),
	};
	await writeFile(TODO_OVERLAY_SETTINGS_FILE, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
}

function toggleTodoOverlayDisplayMode(): TodoOverlayDisplayMode {
	return todoOverlayDisplayMode === "full" ? "compact" : "full";
}

async function setTodoOverlayDisplayMode(displayMode: TodoOverlayDisplayMode): Promise<void> {
	await persistTodoOverlayDisplayMode(displayMode);
	todoOverlayDisplayMode = displayMode;
	for (const record of todoOverlayStore.values()) {
		record.component?.setDisplayMode(displayMode);
	}
}

function getTodoStateKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	return sessionFile ? `session:${sessionFile}` : `cwd:${ctx.cwd}`;
}

function cloneTasks(tasks: TodoTask[]): TodoTask[] {
	return tasks.map((task) => ({ ...task }));
}

function cloneState(state: TodoState): TodoState {
	return { tasks: cloneTasks(state.tasks) };
}

function normalizeInProgressTask(tasks: TodoTask[]): void {
	if (tasks.length === 0) return;

	const inProgressTasks = tasks.filter((task) => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = tasks.find((task) => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

function hasRemainingTasks(state: TodoState): boolean {
	return state.tasks.some((task) => task.status === "pending" || task.status === "in_progress");
}

function hasInProgressTask(state: TodoState): boolean {
	return state.tasks.some((task) => task.status === "in_progress");
}

type TodoOverlayVisibility = {
	hidden: boolean;
	completionGraceActive: boolean;
	meta?: { completedAt: number; completedTurn: number };
};

export function getTodoOverlayVisibility(
	state: TodoState,
	meta: { completedAt?: number; completedTurn?: number } | undefined,
	currentTurn: number,
	now: number,
): TodoOverlayVisibility {
	if (state.tasks.length === 0) return { hidden: true, completionGraceActive: false };
	if (hasRemainingTasks(state)) return { hidden: false, completionGraceActive: false };

	const completedTurn = meta?.completedTurn ?? currentTurn;
	const completedAt = meta?.completedAt ?? now;
	const elapsedTurns = Math.max(0, currentTurn - completedTurn);
	const elapsedMs = Math.max(0, now - completedAt);
	const hidden = elapsedTurns >= TODO_HIDE_COMPLETED_AFTER_TURNS || elapsedMs >= TODO_HIDE_COMPLETED_AFTER_MS;

	return {
		hidden,
		completionGraceActive: !hidden,
		meta: { completedAt, completedTurn },
	};
}

export function applyTodoWrite(todos: InputTaskType[]): {
	state: TodoState;
} {
	const tasks: TodoTask[] = todos.map((todo, index) => ({
		id: `task-${index + 1}`,
		content: todo.content,
		status: todo.status,
		activeForm: todo.activeForm,
		notes: todo.notes,
	}));
	normalizeInProgressTask(tasks);
	return { state: { tasks } };
}

function nextTaskId(tasks: TodoTask[]): string {
	let max = 0;
	for (const task of tasks) {
		const match = /^task-(\d+)$/.exec(task.id);
		if (match?.[1]) max = Math.max(max, Number.parseInt(match[1], 10));
	}
	return `task-${max + 1}`;
}

export type TodoPatch = {
	set?: PatchSetTaskType[];
	add?: InputTaskType[];
	remove?: string[];
};

export function applyTodoPatch(
	state: TodoState,
	patch: TodoPatch,
): {
	state: TodoState;
	warnings: string[];
} {
	const tasks = cloneTasks(state.tasks);
	const warnings: string[] = [];

	for (const id of patch.remove ?? []) {
		const index = tasks.findIndex((task) => task.id === id);
		if (index === -1) {
			warnings.push(`Task to remove was not found: ${id}`);
			continue;
		}
		tasks.splice(index, 1);
	}

	for (const update of patch.set ?? []) {
		const task = tasks.find((candidate) => candidate.id === update.id);
		if (!task) {
			warnings.push(`Task to update was not found: ${update.id}`);
			continue;
		}
		if (update.content !== undefined) task.content = update.content;
		if (update.status !== undefined) task.status = update.status;
		if (update.activeForm !== undefined) task.activeForm = update.activeForm;
		if (update.notes !== undefined) task.notes = update.notes;
	}

	for (const todo of patch.add ?? []) {
		tasks.push({
			id: nextTaskId(tasks),
			content: todo.content,
			status: todo.status,
			activeForm: todo.activeForm,
			notes: todo.notes,
		});
	}

	normalizeInProgressTask(tasks);
	return { state: { tasks }, warnings };
}

export function renderTodoOverlayPlainLines(state: TodoState): string[] {
	return state.tasks.map((task) => {
		const marker = task.status === "completed" ? "✓" : task.status === "in_progress" ? "→" : "○";
		const displayText = task.status === "in_progress" && task.activeForm ? task.activeForm : task.content;
		return `${marker} ${displayText}`;
	});
}

export function renderTodoWriteSummary(state: TodoState): string {
	if (state.tasks.length === 0) return "Task list cleared.";

	const remainingTasks = state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
	const doneCount = state.tasks.filter((task) => task.status === "completed").length;

	const lines: string[] = [];
	if (remainingTasks.length === 0) {
		lines.push("Remaining tasks: none.");
	} else {
		lines.push(`Remaining tasks (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.id} ${task.content} [${task.status}]`);
		}
	}

	lines.push(`Progress: ${doneCount}/${state.tasks.length} done`);

	for (const task of state.tasks) {
		const marker = task.status === "completed" ? "✓" : task.status === "in_progress" ? "→" : "○";
		lines.push(`  ${marker} ${task.id} ${task.content}`);
	}

	return lines.join("\n");
}

function buildTodoTurnContext(state: TodoState): string | null {
	if (state.tasks.length === 0) return null;

	const summary = renderTodoWriteSummary(state);
	const activeTask = state.tasks.find((task) => task.status === "in_progress");
	const activeLine = activeTask
		? [
				`Current task: ${activeTask.id} ${activeTask.activeForm ?? activeTask.content}`,
				"When this task is complete, update todo_write before calling another tool or responding.",
			]
		: hasRemainingTasks(state)
			? [
					"Tasks remain, but no task is in_progress. Use todo_write to set the next active task before continuing.",
				]
			: [];

	return [
		"[todo-reminder] Current todo_write state snapshot",
		"Source: session-memory state maintained by the todo_write_overlay tool.",
		"Treat this content as the latest authoritative state for this turn.",
		"Do not describe a state that conflicts with this snapshot; update todo_write first when state changes.",
		"",
		summary,
		...(activeLine.length > 0 ? ["", ...activeLine] : []),
	].join("\n");
}

type TodoStateEntryData = {
	tasks: TodoTask[];
	updatedAt: number;
};

function persistTodoWriteStateEntry(pi: Pick<ExtensionAPI, "appendEntry">, state: TodoState): void {
	pi.appendEntry<TodoStateEntryData>(TODO_STATE_ENTRY_TYPE, {
		tasks: cloneTasks(state.tasks),
		updatedAt: Date.now(),
	});
}

function clearTodoWriteState(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	pi: Pick<ExtensionAPI, "appendEntry">,
): void {
	const empty = createEmptyState();
	writeTodoWriteState(ctx, empty);
	persistTodoWriteStateEntry(pi, empty);
}

type PersistedTodoStatus = TodoStatus | "abandoned";

type PersistedTodoTask = {
	id: string;
	content: string;
	status: PersistedTodoStatus;
	activeForm?: string;
	notes?: string;
};

type PersistedTodoStateEntryData = {
	tasks: PersistedTodoTask[];
	updatedAt: number;
};

function _isPersistedStatus(value: unknown): value is PersistedTodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function isPersistedTodoTask(value: unknown): value is PersistedTodoTask {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PersistedTodoTask>;
	return (
		typeof candidate.id === "string" && typeof candidate.content === "string" && _isPersistedStatus(candidate.status)
	);
}

function migrateLegacyTasks(tasks: PersistedTodoTask[]): TodoTask[] {
	const migrated = tasks.map((task) => ({
		id: task.id,
		content: task.content,
		status: task.status === "abandoned" ? "completed" : task.status,
		activeForm: task.activeForm,
		notes: task.notes,
	}));
	normalizeInProgressTask(migrated);
	return migrated;
}

function isPersistedTodoStateEntryData(value: unknown): value is PersistedTodoStateEntryData {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PersistedTodoStateEntryData>;
	return (
		Array.isArray(candidate.tasks) &&
		typeof candidate.updatedAt === "number" &&
		candidate.tasks.every((task) => isPersistedTodoTask(task))
	);
}

export function restoreTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== TODO_STATE_ENTRY_TYPE) continue;
		if (isPersistedTodoStateEntryData(entry.data)) {
			const restored = { tasks: migrateLegacyTasks(entry.data.tasks) };
			writeTodoWriteState(ctx, restored);
			return restored;
		}
	}

	const empty = createEmptyState();
	writeTodoWriteState(ctx, empty);
	return empty;
}

function readTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const key = getTodoStateKey(ctx);
	const state = todoStateStore.get(key) ?? createEmptyState();
	return { tasks: cloneTasks(state.tasks) };
}

function writeTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, state: TodoState): void {
	const key = getTodoStateKey(ctx);
	todoStateStore.set(key, { tasks: cloneTasks(state.tasks) });
}

function getTodoTurn(key: string): number {
	return todoTurnStore.get(key) ?? 0;
}

function incrementTodoTurn(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
	const key = getTodoStateKey(ctx);
	todoTurnStore.set(key, getTodoTurn(key) + 1);
}

export function shouldIncrementTodoTurn(message: { role: string; stopReason?: string }): boolean {
	return message.role === "assistant" && message.stopReason !== "toolUse";
}

function setTodoOverlayAgentRunning(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, running: boolean): void {
	const key = getTodoStateKey(ctx);
	todoOverlayAgentRunningStore.set(key, running);
}

export type TodoOverlayCommandAction = "full" | "compact" | "hide" | "status" | "invalid";

export function parseTodoOverlayCommand(args: string): TodoOverlayCommandAction {
	const action = args.trim().toLowerCase();
	if (action === "") return "status";
	if (action === "full" || action === "compact" || action === "hide") return action;
	return "invalid";
}

function isTodoOverlayHidden(key: string): boolean {
	return todoOverlayHiddenStore.get(key) ?? false;
}

function setTodoOverlayHidden(key: string, hidden: boolean): void {
	todoOverlayHiddenStore.set(key, hidden);
}

function hideTodoOverlay(key: string): void {
	const record = todoOverlayStore.get(key);
	if (!record) return;
	record.close?.();
	record.handle?.hide();
	record.component?.dispose();
	todoOverlayStore.delete(key);
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "...", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

class TodoOverlayComponent {
	private state: TodoState;
	private agentRunning: boolean;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		state: TodoState,
		agentRunning: boolean,
		displayMode: TodoOverlayDisplayMode,
	) {
		this.state = cloneState(state);
		this.agentRunning = agentRunning;
		this.displayMode = displayMode;
		this.syncTimer();
	}

	private displayMode: TodoOverlayDisplayMode;

	setState(state: TodoState): void {
		this.state = cloneState(state);
		this.syncTimer();
		this.tui.requestRender();
	}

	setDisplayMode(displayMode: TodoOverlayDisplayMode): void {
		this.displayMode = displayMode;
		this.tui.requestRender();
	}
	setAgentRunning(running: boolean): void {
		this.agentRunning = running;
		this.syncTimer();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.displayMode === "compact") {
			const innerWidth = Math.max(1, width - 2);
			const border = (text: string) => this.theme.fg("dim", text);
			const doneCount = this.state.tasks.filter((task) => task.status === "completed").length;
			const progressText = this.theme.fg("dim", ` ${doneCount}/${this.state.tasks.length} done `);
			const titlePad = Math.max(0, innerWidth - visibleWidth(progressText));
			return [
				`${border("╭")}${border("─".repeat(titlePad))}${progressText}${border("╮")}`,
				`${border("│")}${padAnsi(this.renderCompactLine(), innerWidth)}${border("│")}`,
				`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`,
			];
		}

		const innerWidth = Math.max(1, width - 2);
		const border = (text: string) => this.theme.fg("dim", text);
		const row = (text: string) => `${border("│")}${padAnsi(text, innerWidth)}${border("│")}`;
		const doneCount = this.state.tasks.filter((task) => task.status === "completed").length;
		const totalCount = this.state.tasks.length;
		const progress = totalCount === 0 ? "0/0" : `${doneCount}/${totalCount}`;
		const progressText = this.theme.fg("dim", ` ${progress} done `);
		const title = todoOverlayTitle ? this.theme.fg("accent", this.theme.bold(` ${todoOverlayTitle} `)) : "";
		const titleWidth = visibleWidth(title) + visibleWidth(progressText);
		const titlePad = Math.max(0, innerWidth - titleWidth);
		const lines = [`${border("╭")}${title}${border("─".repeat(titlePad))}${progressText}${border("╮")}`];

		if (this.state.tasks.length === 0) {
			lines.push(row(` ${this.theme.fg("dim", "No tasks")}`));
		} else {
			for (const task of this.state.tasks) {
				lines.push(row(this.renderTaskLine(task)));
			}
		}

		lines.push(`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`);
		return lines;
	}

	private renderCompactLine(): string {
		const inProgress = this.state.tasks.find((task) => task.status === "in_progress");
		if (inProgress) return this.renderTaskLine(inProgress);

		const firstPending = this.state.tasks.find((task) => task.status === "pending");
		if (firstPending) return this.renderTaskLine(firstPending);

		return ` ${this.theme.fg("success", "✓ all done")}`;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private renderTaskLine(task: TodoTask): string {
		const displayText = task.status === "in_progress" && task.activeForm ? task.activeForm : task.content;
		if (task.status === "completed") {
			return ` ${this.theme.fg("success", "✓")} ${this.theme.fg("dim", this.theme.strikethrough(displayText))}`;
		}
		if (task.status === "in_progress") {
			const marker = this.agentRunning ? this.currentSpinner() : "→";
			return ` ${this.theme.fg("accent", marker)} ${this.theme.fg("toolOutput", displayText)}`;
		}
		return ` ${this.theme.fg("muted", "○")} ${this.theme.fg("muted", displayText)}`;
	}

	private currentSpinner(): string {
		return TODO_SPINNER_FRAMES[Math.floor(Date.now() / TODO_SPINNER_INTERVAL_MS) % TODO_SPINNER_FRAMES.length] ?? "•";
	}

	private syncTimer(): void {
		const shouldRun = !this.disposed && this.agentRunning && hasInProgressTask(this.state);
		if (shouldRun && !this.timer) {
			this.timer = setInterval(() => this.tui.requestRender(), TODO_SPINNER_INTERVAL_MS);
			return;
		}
		if (!shouldRun && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

function showOrUpdateTodoOverlay(ctx: ExtensionContext, key: string, state: TodoState): void {
	const agentRunning = todoOverlayAgentRunningStore.get(key) ?? false;
	const record = todoOverlayStore.get(key);
	if (record?.component) {
		record.component.setState(state);
		record.component.setAgentRunning(agentRunning);
		return;
	}
	if (record?.opening) return;

	todoOverlayStore.set(key, { opening: true });
	const initialState = cloneState(state);
	const overlayPromise = ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const component = new TodoOverlayComponent(tui, theme, initialState, agentRunning, todoOverlayDisplayMode);
			const current = todoOverlayStore.get(key) ?? { opening: false };
			todoOverlayStore.set(key, { ...current, opening: false, component, close: done });
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-right",
				width: 42,
				maxHeight: "60%",
				margin: 0,
				nonCapturing: true,
				visible: (termWidth) => termWidth >= 70,
			},
			onHandle: (handle) => {
				const current = todoOverlayStore.get(key) ?? { opening: false };
				todoOverlayStore.set(key, { ...current, handle });
			},
		},
	);
	void overlayPromise
		.finally(() => {
			const current = todoOverlayStore.get(key);
			current?.component?.dispose();
			todoOverlayStore.delete(key);
		})
		.catch(() => {});
}

async function syncTodoOverlay(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "appendEntry">): Promise<void> {
	if (!ctx.hasUI) return;

	const key = getTodoStateKey(ctx);
	const state = readTodoWriteState(ctx);
	const visibility = getTodoOverlayVisibility(state, todoOverlayMetaStore.get(key), getTodoTurn(key), Date.now());

	if (visibility.meta) {
		todoOverlayMetaStore.set(key, visibility.meta);
	} else {
		todoOverlayMetaStore.delete(key);
	}

	if (visibility.hidden || state.tasks.length === 0) {
		if (visibility.hidden && state.tasks.length > 0) {
			clearTodoWriteState(ctx, pi);
			todoOverlayMetaStore.delete(key);
		}
		hideTodoOverlay(key);
		return;
	}

	if (isTodoOverlayHidden(key)) {
		hideTodoOverlay(key);
		return;
	}

	showOrUpdateTodoOverlay(ctx, key, state);
}

export default async function todoWriteOverlayExtension(pi: ExtensionAPI): Promise<void> {
	const settings = await loadTodoOverlaySettings();
	todoOverlayDisplayMode = settings.displayMode;
	todoOverlayTitle = settings.title;
	pi.registerCommand("todo-overlay", {
		description: "Set the todo overlay display. Usage: /todo-overlay full|compact|hide",
		getArgumentCompletions(prefix: string) {
			const filtered = ["full", "compact", "hide"].filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		async handler(args, ctx) {
			const key = getTodoStateKey(ctx);
			const action = parseTodoOverlayCommand(args);

			if (action === "invalid") {
				ctx.ui.notify("Usage: /todo-overlay full, compact, or hide", "warning");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(`todo overlay: ${isTodoOverlayHidden(key) ? "hidden" : "shown"}`, "info");
				return;
			}

			if (action === "full" || action === "compact") {
				try {
					await setTodoOverlayDisplayMode(action);
					setTodoOverlayHidden(key, false);
					await syncTodoOverlay(ctx, pi);
					ctx.ui.notify(`TODO overlay mode: ${action}`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not save TODO overlay mode: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (action === "hide") {
				setTodoOverlayHidden(key, true);
				hideTodoOverlay(key);
				ctx.ui.notify("Todo overlay hidden. Use /todo-overlay full or /todo-overlay compact to show it again.", "info");
			}
		},
	});

	pi.registerShortcut(Key.ctrlShift("t"), {
		description: "Toggle TODO overlay display mode",
		handler: async (ctx) => {
			const nextMode = toggleTodoOverlayDisplayMode();
			try {
				await setTodoOverlayDisplayMode(nextMode);
				ctx.ui.notify(`TODO overlay mode: ${nextMode}`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not save TODO overlay mode: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "todo_write",
		executionMode: "sequential",
		label: "Task manager",
		description: `Create and manage a structured task list for the current coding session. Use it to track progress, break down complex requests, and show the user the active work in a top-right overlay.

## When to use
- Complex multi-step work with three or more steps
- Requests containing multiple tasks
- Non-trivial work that needs a plan before implementation or debugging

## When not to use
- A single simple task that can be performed directly
- Simple work that finishes in fewer than three steps
- Pure conversation or information-only responses

## Rules
- Keep task content concise and in the user's language
- Update task status as work progresses
- Mark a task completed immediately when it finishes; do not batch updates
- Keep exactly one task in_progress
- Reconcile the current task state before starting a new task
- Remove tasks that are no longer meaningful
- Mark tasks completed only when fully done; keep blocked work in_progress
- Update the task list before continuing when requirements change

## Update mode (op)
- Use op=replace (the default) with the full todos list only when first creating or substantially reorganizing the list.
- Use op=patch for partial updates to an existing list; prefer set/add/remove changes as the list grows to keep arguments small.
  - set: update fields on existing tasks. Example: finish one task and start the next => set: [{id:"task-1", status:"completed"}, {id:"task-2", status:"in_progress"}]
  - add: add a task
  - remove: remove a task ID
- Do not invent IDs; use the task-N values shown by the previous todo_write result.

## Fields
- content: imperative task description (for example, "Run tests")
- status: pending | in_progress | completed
- activeForm: (optional) present-continuous label shown while in progress (for example, "Running tests")
- notes: (optional) additional context`,
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = normalizeTodoWriteParams(params);
			let state: TodoState;
			let warnings: string[] = [];
			if (command.op === "patch") {
				const result = applyTodoPatch(readTodoWriteState(ctx), {
					set: command.set,
					add: command.add,
					remove: command.remove,
				});
				state = result.state;
				warnings = result.warnings;
			} else {
				state = applyTodoWrite(command.todos).state;
			}
			const summary = renderTodoWriteSummary(state);
			writeTodoWriteState(ctx, state);
			persistTodoWriteStateEntry(pi, state);
			await syncTodoOverlay(ctx, pi);
			const text =
				warnings.length > 0
					? `${summary}\n\nWarnings:\n${warnings.map((warning) => `  - ${warning}`).join("\n")}`
					: summary;
			return {
				content: [{ type: "text" as const, text }],
				details: { tasks: state.tasks, summary, warnings },
			};
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const details = result.details as { summary?: unknown } | undefined;
			const summary = typeof details?.summary === "string" ? details.summary : "";
			return new Text(summary ? theme.fg("toolOutput", summary) : "", 0, 0);
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = readTodoWriteState(ctx);
		if (state.tasks.length === 0) return;

		const key = getTodoStateKey(ctx);
		const visibility = getTodoOverlayVisibility(state, todoOverlayMetaStore.get(key), getTodoTurn(key), Date.now());
		if (visibility.hidden) {
			clearTodoWriteState(ctx, pi);
			todoOverlayMetaStore.delete(key);
			hideTodoOverlay(key);
			return;
		}

		const content = buildTodoTurnContext(state);
		if (!content) return;
		return {
			message: {
				customType: "todo-write-context",
				content,
				display: false,
				details: { summary: renderTodoWriteSummary(state) },
			},
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		setTodoOverlayAgentRunning(ctx, true);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("agent_end", async (_event, ctx) => {
		setTodoOverlayAgentRunning(ctx, false);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_start", async (_event, ctx) => {
		setTodoOverlayAgentRunning(ctx, false);
		restoreTodoWriteState(ctx);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_tree", async (_event, ctx) => {
		setTodoOverlayAgentRunning(ctx, false);
		restoreTodoWriteState(ctx);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_compact", async (_event, ctx) => {
		restoreTodoWriteState(ctx);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!shouldIncrementTodoTurn(event.message)) return;
		incrementTodoTurn(ctx);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const key = getTodoStateKey(ctx);
		hideTodoOverlay(key);
		todoOverlayMetaStore.delete(key);
		todoOverlayAgentRunningStore.delete(key);
		todoOverlayHiddenStore.delete(key);
		todoTurnStore.delete(key);
	});
}
