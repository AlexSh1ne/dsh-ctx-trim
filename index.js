/**
 * dsh-ctx-trim — 宿主半边（v0.2，HTTP 路线）。
 *
 * 为什么走 HTTP 路由：客户端半边拿不到宿主服务（客户端服务表里只有
 * slots / locale / theme / sessions / layout / uiWorkspace / workspaces / timer），
 * 所以按钮只能 fetch 打一条宿主路由。这条路 dsh-meme 已经跑通。
 *
 * 为什么不用 ctx.compaction.compactRegion：
 * BasicCompactionEngine 里它写死 owner: 'current-turn'，会话没有开着的 turn 时直接抛
 *   "compactRegion: no open turn — automatic compaction events must be enclosed in a turn"
 * 我们是空闲时按按钮，永远没有 open turn；它还要整张 surface 在摘要期间不变。
 * 官方空闲手动压缩只有 compactNow，但它自己选区间（retain 0，只留最后一条），
 * 给不了「保留最近 N 条」的两档控制。
 * 所以按 live-compact 验证过的写法自己走一遍公开事务：
 *   compaction/start → compaction/summary → user/message(replace) → compaction/end → flush
 * 外层用 agent.runMaintenance 占住空闲，跟 driver 的回合互斥。
 *
 * 摘要不调模型：优先借用同 profile 的 dsh-live-compact/plan.js（profile 在用的本地
 * 摘要器），拿不到就退回自己那版摘录。摘要若不比切掉的原文小，直接放弃不写。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "ctx-trim";

/** 只把 webServer 当硬依赖；其余服务在用的时候用 ctx.get 取，取不到就报人话。 */
export const inject = ["webServer"];

// 前缀路由的匹配规则是「相等，或以 `${prefix}/` 开头」，所以这里不能带尾斜杠：
// 带上之后 /dsh-ctx-trim/status 永远匹配不到（踩过，404）。
const ROUTE_PREFIX = "/dsh-ctx-trim";
const MAX_BODY = 64 * 1024;
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. " +
  "Treat the captured context as established background and build on it without restating it. " +
  "Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/** 两档：保留多少比例的现价 token；floor 防止小会话一刀切光。 */
const MODES = {
  normal: { keepRatio: 0.3, floorTokens: 6000, pack: false, label: "正常压缩" },
  deep: { keepRatio: 0.1, floorTokens: 2500, pack: true, label: "深度压缩" },
};

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function packsDir() {
  const dir = join(dshHome(), "im", "ctxpacks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function logLine(line) {
  try {
    appendFileSync(join(packsDir(), "pending.log"), `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* 记日志失败不影响压缩本身 */
  }
}

function recentLog(limit = 6) {
  try {
    const text = readFileSync(join(packsDir(), "pending.log"), "utf8");
    return text.split("\n").filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

function service(ctx, key) {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  if (!error) return "未知原因";
  return error instanceof Error ? error.message : String(error);
}

function messageTextOf(value) {
  const content = value?.content ?? value?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function eventText(session, seq) {
  const event = session.eventAt(seq);
  if (!event) return "";
  if (event.type === "user/message") return messageTextOf(event.data);
  if (event.type === "assistant/message") return messageTextOf(event.data?.message);
  if (event.type === "tool/result") return messageTextOf(event.data?.message);
  if (event.type === "system/message") return messageTextOf(event.data?.message);
  if (event.type === "developer/message") return messageTextOf(event.data?.message);
  return messageTextOf(event.data);
}

function roleOf(session, seq) {
  const type = session.eventAt(seq)?.type;
  if (type === "assistant/message") return "assistant";
  if (type === "tool/result") return "tool";
  return "user";
}

function isCheckpoint(session, seq) {
  const event = session.eventAt(seq);
  if (!event) return false;
  if (event.data?.source?.kind === "compact-checkpoint") return true;
  return eventText(session, seq).includes("Spine extract.");
}

/** 有没有一次没收尾的 compaction（别的压缩正在跑就不许再下刀）。 */
function compactionActive(session) {
  let open = false;
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type === "compaction/start") open = true;
      else if (event.type === "compaction/end") open = false;
    }
  } catch {
    return false;
  }
  return open;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * 选区间：从尾部往前攒 token，攒够 keepTokens 就停；两端都收到结构边界上。
 */
function plan(session, meter, modeName) {
  const mode = MODES[modeName] ?? MODES.normal;
  const nodes = session.surface.nodes;
  const measurement = meter.measure(session);
  const priced = measurement.nodes;
  if (nodes.length !== priced.length) {
    return { ok: false, message: "拿不到逐条 token 计量，先不压（surface 和计量对不上）。" };
  }
  const first = safe(() => session.eventAt(nodes[0])?.type === "system/message", false) ? 1 : 0;
  if (nodes.length - first < 4) return { ok: false, message: `消息太少（${nodes.length} 条），不值得压。` };

  const total = measurement.totalTokens;
  const keepTokens = Math.max(mode.floorTokens, Math.floor(total * mode.keepRatio));

  let keepFrom = nodes.length;
  let accumulated = 0;
  for (let index = nodes.length - 1; index >= first; index -= 1) {
    accumulated += priced[index].tokens;
    keepFrom = index;
    if (accumulated >= keepTokens) break;
  }

  let endIdx = keepFrom - 1;
  let guard = 0;
  while (endIdx >= first && guard <= nodes.length) {
    guard += 1;
    if (isCheckpoint(session, nodes[endIdx])) {
      endIdx -= 1;
      continue;
    }
    if (!safe(() => toolPairingBalancedAfter(session, nodes[endIdx]), true)) {
      endIdx -= 1;
      continue;
    }
    break;
  }

  let startIdx = first;
  guard = 0;
  while (startIdx <= endIdx && guard <= nodes.length) {
    guard += 1;
    if (isCheckpoint(session, nodes[startIdx])) {
      startIdx += 1;
      continue;
    }
    if (!safe(() => toolPairingBalancedBefore(session, nodes[startIdx]), true)) {
      startIdx += 1;
      continue;
    }
    break;
  }

  if (startIdx > endIdx) {
    return { ok: false, message: "没找到能安全下刀的区间（不是切在工具调用中间，就是撞上压缩标记）。" };
  }

  const cutNodes = priced.slice(startIdx, endIdx + 1);
  const cutSeqs = nodes.slice(startIdx, endIdx + 1);
  const cutTokens = cutNodes.reduce((sum, node) => sum + (node?.tokens ?? 0), 0);
  const cutHeuristic = cutNodes.reduce((sum, node) => sum + (node?.heuristicTokens ?? node?.tokens ?? 0), 0);

  return {
    ok: true,
    mode,
    nodes,
    total,
    startSeq: nodes[startIdx],
    endSeq: nodes[endIdx],
    cutSeqs,
    cutTokens,
    cutHeuristic,
    keepNodes: nodes.length - cutSeqs.length,
  };
}

function packSpan(sessionId, selected, spanText) {
  if (!selected.mode.pack) return null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(packsDir(), `${String(sessionId).slice(-12)}-${stamp}.md`);
    writeFileSync(
      file,
      `# 深度压缩：切下的原文\n\n- 会话：${sessionId}\n- 时间：${new Date().toISOString()}\n` +
        `- 区间：${selected.startSeq} → ${selected.endSeq}（${selected.cutSeqs.length} 条，约 ${selected.cutTokens} token）\n\n---\n\n${spanText}\n`,
      "utf8",
    );
    return file;
  } catch {
    return null;
  }
}

let digestModule;
async function localDigest(messages, spanText) {
  if (digestModule === undefined) {
    try {
      const module = await import("dsh-live-compact/plan.js");
      digestModule = typeof module.planMessages === "function" ? module.planMessages : null;
    } catch {
      digestModule = null;
    }
  }
  if (digestModule) {
    try {
      const card = digestModule(messages);
      if (card && typeof card.text === "string" && card.text.length > 0) return card.text;
    } catch {
      /* 退到自己的摘录 */
    }
  }
  return fallbackDigest(messages, spanText);
}

function fallbackDigest(messages, spanText) {
  const lines = [];
  for (const message of messages) {
    const text = String(message.content || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`- [${message.role}] ${text.slice(0, 220)}`);
    if (lines.length >= 60) break;
  }
  return [
    "Local extract (no model).",
    `Shadowed characters: ${String(spanText || "").length}.`,
    "Excerpt of the shadowed span:",
    ...(lines.length ? lines : ["- (empty)"]),
  ].join("\n");
}

function frameSummary(digest) {
  return [
    { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    { type: "text", text: digest },
    { type: "text", text: SUMMARY_CLOSE_TAG },
  ];
}

/** 真下刀：整段 append 不 await，保证 start/summary/replace/end 紧挨着。 */
function commit(session, selected, compactionId, checkpointMessage) {
  const lifecycle = { compactionId, turn: null };
  const startEvent = session.append("compaction/start", lifecycle);
  const summaryEvent = session.append("compaction/summary", {
    compactionId,
    summary: checkpointMessage.content,
    shadowedRange: { start: selected.startSeq, end: selected.endSeq },
    shadowedSeqs: [...selected.cutSeqs],
    shadowedTokenCount: selected.cutHeuristic,
    provider: "local",
    model: "ctx-trim-extract",
  });
  session.append("user/message", checkpointMessage, {
    surfaceOp: { op: "replace", startSeq: selected.startSeq, endSeq: selected.endSeq },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selected.cutSeqs],
  });
  session.append("compaction/end", lifecycle);
}

async function runTrim(ctx, sessionId, modeName, dry) {
  const agents = service(ctx, "agents");
  const sessions = service(ctx, "sessions");
  const meter = service(ctx, "tokenMeter");
  if (!agents || typeof agents.get !== "function") return { ok: false, message: "宿主没有 agents 服务，压不了。" };
  if (!meter || typeof meter.measure !== "function") return { ok: false, message: "宿主没有 tokenMeter 服务，压不了。" };

  const agent = agents.get(sessionId);
  if (!agent) return { ok: false, message: "这个会话不在运行（可能已归档、或由别的进程持有），压不了。" };
  const session = agent.session;
  if (!session) return { ok: false, message: "拿不到会话对象。" };
  if (typeof agent.runMaintenance !== "function") return { ok: false, message: "这个 agent 不支持空闲维护，压不了。" };
  if (compactionActive(session)) return { ok: false, message: "已经有一次压缩没收尾，先等它结束。" };

  const mode = MODES[modeName] ? modeName : "normal";
  const selected = plan(session, meter, mode);
  if (!selected.ok) return { ok: false, message: selected.message };

  // 摘要必须在事务开始前算好：事务里不能有 await。
  const messages = selected.cutSeqs.map((seq) => ({ role: roleOf(session, seq), content: eventText(session, seq) }));
  const spanText = messages.map((message) => message.content).join("\n\n");
  const packFile = packSpan(sessionId, selected, spanText);
  let digest = await localDigest(messages, spanText);
  if (packFile) digest += `\nFull shadowed text saved to: ${packFile}`;

  const compactionId = randomUUID();
  const checkpointMessage = createUserMessage({
    content: frameSummary(digest),
    source: compactCheckpointSource(compactionId),
  });

  const framed = safe(() => meter.estimateMessage(checkpointMessage), 0);
  if (framed > 0 && framed >= selected.cutTokens) {
    return {
      ok: false,
      message: `摘要没比切掉的原文小（${framed} ≥ ${selected.cutTokens} token），这一刀不划算，放弃。`,
    };
  }

  const before = selected.total;
  // 试跑：把选区间、取原文、做摘要、估大小全走一遍，只是不落盘。
  if (dry) {
    return {
      ok: true,
      dry: true,
      mode,
      cutNodes: selected.cutSeqs.length,
      cutTokens: selected.cutTokens,
      keepNodes: selected.keepNodes,
      before,
      framed,
      digestChars: digest.length,
      digestHead: digest.slice(0, 400),
      message: `试跑：会切掉 ${selected.cutSeqs.length} 条（约 ${selected.cutTokens} token），摘要 ${digest.length} 字 / 约 ${framed} token，保留最近 ${selected.keepNodes} 条。`,
    };
  }

  let task;
  try {
    // runMaintenance 同步抛错 = agent 正忙，这一轮还在跑。
    task = agent.runMaintenance(async (signal) => {
      signal?.throwIfAborted?.();
      if (compactionActive(session)) throw new Error("已经有一次压缩没收尾");
      commit(session, selected, compactionId, checkpointMessage);
      if (sessions && typeof sessions.flush === "function") await sessions.flush(session);
      return true;
    });
  } catch (error) {
    return { ok: false, message: `这个会话正在跑（${errorMessage(error)}），等这一轮结束再压。` };
  }

  try {
    await task;
  } catch (error) {
    return { ok: false, message: `压缩失败：${errorMessage(error)}` };
  }

  const after = safe(() => meter.measure(session).totalTokens, null);
  const message =
    `切掉 ${selected.cutSeqs.length} 条（约 ${selected.cutTokens} token），保留最近 ${selected.keepNodes} 条。` +
    (before != null && after != null ? `上下文 token：${before} → ${after}` : "") +
    (packFile ? `；原文已存 ${packFile}` : "");
  logLine(`${mode} 成功：${message}`);
  return {
    ok: true,
    mode,
    cutNodes: selected.cutSeqs.length,
    cutTokens: selected.cutTokens,
    before,
    after,
    packFile,
    message,
  };
}

function status(ctx, sessionId) {
  const agents = service(ctx, "agents");
  const meter = service(ctx, "tokenMeter");
  const base = { ok: true, sessionId: sessionId ?? null, recent: recentLog() };
  if (!agents || typeof agents.get !== "function" || !meter) {
    return { ...base, ok: false, message: "宿主服务不全（agents / tokenMeter）" };
  }
  if (!sessionId) return { ...base, ok: false, message: "缺 sessionId" };
  const agent = agents.get(sessionId);
  if (!agent) return { ...base, ok: false, message: "这个会话不在运行" };
  const session = agent.session;
  const modes = {};
  for (const key of Object.keys(MODES)) {
    const value = plan(session, meter, key);
    modes[key] = value.ok
      ? { label: value.mode.label, cutNodes: value.cutSeqs.length, cutTokens: value.cutTokens, keepNodes: value.keepNodes }
      : { label: MODES[key].label, error: value.message };
  }
  return {
    ...base,
    ok: true,
    nodes: session.surface.nodes.length,
    tokens: safe(() => meter.measure(session).totalTokens, null),
    compacting: compactionActive(session),
    modes,
  };
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求体太大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length === 0 ? {} : JSON.parse(text);
}

export function apply(ctx) {
  const webServer = ctx.webServer ?? service(ctx, "webServer");
  // 留一行落地证据：apply 到底有没有跑、跑的时候看得到哪些服务。
  logLine(
    `apply: webServer=${typeof webServer?.register === "function"} agents=${typeof service(ctx, "agents")?.get === "function"} ` +
      `sessions=${typeof service(ctx, "sessions")?.flush === "function"} meter=${typeof service(ctx, "tokenMeter")?.measure === "function"}`,
  );
  if (!webServer || typeof webServer.register !== "function") {
    ctx.logger?.warn?.("ctx-trim: 没有 webServer，路由没挂上");
    return;
  }

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { ok: false, message: "请求地址解析失败" });
      return;
    }

    // 这两个接口能改会话，所以挡掉「别的网页发起的跨站请求」；
    // 浏览器同源是 same-origin，直接 curl 没有这个头（本机调试要用）。
    const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    if (site && site !== "same-origin" && site !== "none") {
      sendJson(res, 403, { ok: false, message: "只接受同源请求" });
      return;
    }

    if (url.pathname === `${ROUTE_PREFIX}/status`) {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      try {
        sendJson(res, 200, status(ctx, url.searchParams.get("sessionId") || undefined));
      } catch (error) {
        sendJson(res, 500, { ok: false, message: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === `${ROUTE_PREFIX}/run`) {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      // 只收 JSON：跨站表单发不出这个 content-type，顺手挡掉一半 CSRF。
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        sendJson(res, 415, { ok: false, message: "只收 application/json" });
        return;
      }
      try {
        const body = await readJson(req);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const mode = typeof body.mode === "string" ? body.mode : "normal";
        if (!sessionId) {
          sendJson(res, 400, { ok: false, message: "缺 sessionId" });
          return;
        }
        const result = await runTrim(ctx, sessionId, mode, body.dry === true);
        sendJson(res, result.ok ? 200 : 409, result);
      } catch (error) {
        sendJson(res, 400, { ok: false, message: errorMessage(error) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, message: "没有这个接口" });
  };

  ctx.effect(
    () =>
      webServer.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        handler,
      }),
    "ctx-trim: /dsh-ctx-trim 路由",
  );
}
