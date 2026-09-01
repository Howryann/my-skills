#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { migrateSessionEntries } from "@earendil-works/pi-coding-agent";

const DEFAULT_COUNT = 1;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_POLL_MILLISECONDS = 500;

class UsageError extends Error {}

function usage() {
	return `Usage: node wait.ts <session.jsonl> [options]

Options:
  --count <n>           Latest assistant entries to print (default: 1)
  --timeout <seconds>   Maximum wait time (default: 1800)
  --poll <milliseconds> Poll interval (default: 500)
  --help                Show this help

The default output is one session entry as JSON. With --count greater than 1,
the output is a JSON array ordered from oldest to newest.`;
}

function numericOption(raw, name, { integer = false, positive = false } = {}) {
	const value = Number(raw);
	if (
		!Number.isFinite(value) ||
		(integer && !Number.isInteger(value)) ||
		(positive ? value <= 0 : value < 0)
	) {
		throw new UsageError(`Invalid ${name}: ${String(raw)}`);
	}
	return value;
}

function parseArguments(argv) {
	const options = {
		count: DEFAULT_COUNT,
		help: false,
		pollMilliseconds: DEFAULT_POLL_MILLISECONDS,
		sessionPath: undefined,
		timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") {
			options.help = true;
			continue;
		}
		if (argument === "--count") {
			options.count = numericOption(argv[++index], "--count", {
				integer: true,
				positive: true,
			});
			continue;
		}
		if (argument === "--timeout") {
			options.timeoutSeconds = numericOption(
				argv[++index],
				"--timeout",
			);
			continue;
		}
		if (argument === "--poll") {
			options.pollMilliseconds = numericOption(argv[++index], "--poll", {
				integer: true,
				positive: true,
			});
			continue;
		}
		if (argument.startsWith("-")) {
			throw new UsageError(`Unknown option: ${argument}`);
		}
		if (options.sessionPath !== undefined) {
			throw new UsageError(`Unexpected argument: ${argument}`);
		}
		options.sessionPath = argument;
	}

	if (!options.help && options.sessionPath === undefined) {
		throw new UsageError("Missing session JSONL path");
	}
	return options;
}

function parseCompleteSession(content) {
	const lines = content.split("\n");
	const entries = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (
				typeof entry !== "object" ||
				entry === null ||
				Array.isArray(entry)
			) {
				throw new Error("entry is not an object");
			}
			entries.push(entry);
		} catch (error) {
			// appendFileSync 可能正好写到一半；此时不能退回旧 assistant 作为结果。
			if (index === lines.length - 1 && !content.endsWith("\n")) {
				return undefined;
			}
			throw new Error(
				`Session contains invalid JSON on line ${index + 1}: ${error.message}`,
			);
		}
	}
	return entries;
}

function activeBranch(fileEntries) {
	if (fileEntries.length === 0) return [];
	if (fileEntries[0].type !== "session") {
		throw new Error("Session header is missing or invalid");
	}

	// 只在内存中迁移旧格式，避免等待器改写正在由 Pi 追加的 session 文件。
	migrateSessionEntries(fileEntries);
	const entries = fileEntries.filter((entry) => entry.type !== "session");
	if (entries.length === 0) return [];

	const byId = new Map();
	for (const entry of entries) {
		if (typeof entry.id !== "string") {
			throw new Error("Session entry is missing an id");
		}
		if (entry.parentId !== null && typeof entry.parentId !== "string") {
			throw new Error(`Session entry ${entry.id} has an invalid parentId`);
		}
		if (byId.has(entry.id)) {
			throw new Error(`Session contains duplicate entry id ${entry.id}`);
		}
		byId.set(entry.id, entry);
	}

	// Pi 的 JSONL 是追加式树，最后一个完整 entry 就是持久化的 active leaf。
	const branch = [];
	const visited = new Set();
	let current = entries.at(-1);
	while (current !== undefined) {
		if (visited.has(current.id)) {
			throw new Error(`Session branch contains a cycle at ${current.id}`);
		}
		visited.add(current.id);
		branch.push(current);
		if (current.parentId === null) break;
		const parent = byId.get(current.parentId);
		if (parent === undefined) {
			throw new Error(
				`Session branch references missing parent ${current.parentId}`,
			);
		}
		current = parent;
	}
	return branch.reverse();
}

function terminalAssistantEntries(branch, count) {
	const messages = branch.filter((entry) => entry.type === "message");
	const latest = messages.at(-1);
	if (latest?.message?.role !== "assistant") return undefined;

	const stopReason = latest.message.stopReason;
	// toolUse 只结束一次模型调用，后面仍会追加 toolResult 和新的 assistant。
	if (
		typeof stopReason !== "string" ||
		stopReason.length === 0 ||
		stopReason === "pending" ||
		stopReason === "toolUse"
	) {
		return undefined;
	}

	return messages
		.filter((entry) => entry.message?.role === "assistant")
		.slice(-count);
}

async function readResult(sessionPath, count) {
	let content;
	try {
		content = await readFile(sessionPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw new Error(`Could not read session ${sessionPath}: ${error.message}`);
	}
	if (!content.trim()) return undefined;

	const entries = parseCompleteSession(content);
	if (entries === undefined) return undefined;
	return terminalAssistantEntries(activeBranch(entries), count);
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForResult(options) {
	const timeoutMilliseconds = options.timeoutSeconds * 1000;
	const deadline = Date.now() + timeoutMilliseconds;

	while (true) {
		const result = await readResult(options.sessionPath, options.count);
		if (result !== undefined) return result;

		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Timed out after ${options.timeoutSeconds}s waiting for a terminal assistant message in ${options.sessionPath}`,
			);
		}
		await sleep(Math.min(options.pollMilliseconds, remaining));
	}
}

try {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		console.log(usage());
	} else {
		const entries = await waitForResult(options);
		const output = options.count === 1 ? entries[0] : entries;
		console.log(JSON.stringify(output, null, 2));
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	if (error instanceof UsageError) console.error(`\n${usage()}`);
	process.exitCode = error instanceof UsageError ? 2 : 1;
}
