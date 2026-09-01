#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const skillDirectory = dirname(fileURLToPath(import.meta.url));
const waitScript = join(skillDirectory, "wait.ts");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-wait-check-"));

function jsonl(entries) {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function header() {
	return {
		type: "session",
		version: 3,
		id: "session-check",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/check",
	};
}

function user(id, parentId, text) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistant(id, parentId, text, stopReason = "stop") {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "check",
			model: "check",
			usage: {},
			stopReason,
			timestamp: 2,
		},
	};
}

function toolResult(id, parentId) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:03.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		},
	};
}

async function runWait(arguments_) {
	return await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [waitScript, ...arguments_], {
			cwd: skillDirectory,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const killTimer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("wait.ts 检查子进程超过 5 秒"));
		}, 5_000);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(killTimer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(killTimer);
			resolve({ code, stderr, stdout });
		});
	});
}

try {
	const branchedSession = join(temporaryDirectory, "branched.jsonl");
	await writeFile(
		branchedSession,
		jsonl([
			header(),
			user("user-root", null, "root"),
			assistant("assistant-common", "user-root", "common"),
			user("user-old", "assistant-common", "old branch"),
			assistant("assistant-old", "user-old", "abandoned"),
			user("user-active", "assistant-common", "active branch"),
			assistant("assistant-active", "user-active", "active"),
		]),
	);
	const branchResult = await runWait([
		branchedSession,
		"--count",
		"2",
		"--timeout",
		"1",
		"--poll",
		"5",
	]);
	assert.equal(branchResult.code, 0, branchResult.stderr);
	assert.deepEqual(
		JSON.parse(branchResult.stdout).map(
			(entry) => entry.message.content[0].text,
		),
		["common", "active"],
		"必须排除 abandoned branch 上的 assistant",
	);

	const partialSession = join(temporaryDirectory, "partial.jsonl");
	await writeFile(
		partialSession,
		`${jsonl([
			header(),
			user("partial-user", null, "first turn"),
			assistant("partial-assistant", "partial-user", "old result"),
		])}{"type":"message"`,
	);
	const partialResult = await runWait([
		partialSession,
		"--timeout",
		"0.05",
		"--poll",
		"5",
	]);
	assert.equal(partialResult.code, 1);
	assert.match(
		partialResult.stderr,
		/Timed out/,
		"未写完的尾行存在时不能返回旧 assistant",
	);

	const malformedSession = join(temporaryDirectory, "malformed.jsonl");
	await writeFile(
		malformedSession,
		`${jsonl([
			header(),
			user("malformed-user", null, "task"),
		])}not-json\n${jsonl([
			assistant("malformed-assistant", "malformed-user", "result"),
		])}`,
	);
	const malformedResult = await runWait([
		malformedSession,
		"--timeout",
		"1",
	]);
	assert.equal(malformedResult.code, 1);
	assert.match(
		malformedResult.stderr,
		/invalid JSON on line 3/,
		"完整的 malformed 行必须让读取失败",
	);

	const toolSession = join(temporaryDirectory, "tool-use.jsonl");
	const toolEntries = [
		header(),
		user("tool-user", null, "use a tool"),
		assistant("tool-assistant", "tool-user", "calling", "toolUse"),
	];
	await writeFile(toolSession, jsonl(toolEntries));
	const prematureResult = await runWait([
		toolSession,
		"--timeout",
		"0.05",
		"--poll",
		"5",
	]);
	assert.equal(prematureResult.code, 1);
	assert.match(
		prematureResult.stderr,
		/Timed out/,
		"toolUse 不能被误判为任务完成",
	);

	toolEntries.push(
		toolResult("tool-result", "tool-assistant"),
		assistant("tool-final", "tool-result", "finished"),
	);
	await writeFile(toolSession, jsonl(toolEntries));
	const finalResult = await runWait([
		toolSession,
		"--timeout",
		"1",
		"--poll",
		"5",
	]);
	assert.equal(finalResult.code, 0, finalResult.stderr);
	assert.equal(
		JSON.parse(finalResult.stdout).message.content[0].text,
		"finished",
	);

	console.log(
		JSON.stringify({ name: "check-subagent-wait", status: "completed" }),
	);
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
