/*
 * po0 防火墙自动加白 · Egern 可控版
 *
 * 基于 kelenetwork/po0fw 的 Egern 原生脚本：
 * - 主接口保持 https://124.221.69.228/api/firewall/<token>/add[?slot=N]
 * - 仅当主接口返回 HTTP 400 且明确提示 serviceId is required 时，调用控制台
 *   token 备用接口；其它 HTTP 或网络错误不回退
 * - 响应必须确认当前 /24 已在白名单；带 @槽位时还必须确认槽位一致
 * - token 只来自 ctx.env.tokens，不写入日志或通知
 */

const API_BASE = "https://124.221.69.228/api/firewall/";
const FALLBACK_API =
  "https://console.po0.io/modules/servers/penguin/api/firewall.php?action=add&token=";
const STORE_PREFIX = "po0_fw_custom_";
const HIST_WINDOW_MS = 24 * 3600 * 1000;
const HTTP_TIMEOUT_MS = 15000;

function redactSecrets(value) {
  return String(value || "").replace(/pgnfw_[A-Za-z0-9_-]+(?:@\d+)?/gi, "pgnfw_***");
}

function excerpt(value) {
  return redactSecrets(value).replace(/\s+/g, " ").trim().slice(0, 120);
}

// tokens 分隔符兼容 , | ; 、 空白；每段可带 @槽位 后缀。
function parseTokens(raw) {
  return String(raw || "")
    .split(/[,|;、\s]+/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.indexOf("pgnfw_") === 0;
    })
    .map(function (s) {
      const at = s.indexOf("@");
      if (at === -1) return { token: s, slot: null };
      const n = parseInt(s.slice(at + 1), 10);
      return { token: s.slice(0, at), slot: isNaN(n) ? null : n };
    });
}

function onCellular(ctx) {
  try {
    const d = ctx.device || {};
    const onWifi = !!(d.wifi && d.wifi.ssid);
    const hasCell = !!(d.cellular && (d.cellular.carrier || d.cellular.radio));
    return !onWifi && hasCell;
  } catch (e) {
    return false;
  }
}

function readHistory(ctx, key) {
  let history;
  try {
    history = ctx.storage.getJSON(key) || [];
  } catch (e) {
    history = [];
  }
  if (!Array.isArray(history)) history = [];
  const cutoff = Date.now() - HIST_WINDOW_MS;
  return history.filter(function (entry) {
    return entry && entry.ts > cutoff;
  });
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// Egern 对非 2xx 响应会直接 throw；这里把 HTTP status/body 恢复为统一结构。
async function requestText(ctx, method, url, options) {
  try {
    const response = await ctx.http[method](url, options);
    let text = "";
    try {
      text = await response.text();
    } catch (e) {}
    return { status: Number(response.status) || 0, text: text };
  } catch (e) {
    const message = redactSecrets((e && e.message) || e);
    const match = message.match(/status:\s*(\d{3})(?:\s*,\s*body:\s*([\s\S]*))?/i);
    if (!match) return { networkError: message || "网络请求失败" };
    return {
      status: parseInt(match[1], 10),
      text: match[2] !== undefined ? match[2] : "",
    };
  }
}

function needsServiceIdFallback(exchange) {
  if (!exchange || exchange.status !== 400) return false;
  const data = safeJSON(exchange.text);
  const detail = [
    exchange.text,
    data && data.message,
    data && data.error,
    data && data.detail,
  ].join(" ");
  return /serviceId\s+is\s+required/i.test(detail);
}

// 任一侧为 /24 段时按前三段比较，两侧均为精确 IP 时要求全等。
function sameC24(a, b) {
  if (!a || !b) return false;
  a = String(a);
  b = String(b);
  if (a === b) return true;
  if (a.slice(-3) !== "/24" && b.slice(-3) !== "/24") return false;
  const pa = a.replace("/24", "").split(".");
  const pb = b.replace("/24", "").split(".");
  return (
    pa.length === 4 &&
    pb.length === 4 &&
    pa[0] === pb[0] &&
    pa[1] === pb[1] &&
    pa[2] === pb[2]
  );
}

function normalizeResponse(data, requestedSlot, source) {
  const raw = Array.isArray(data.whitelist) ? data.whitelist : [];
  const entries = raw.map(function (entry) {
    if (entry && typeof entry === "object") {
      return { ip: entry.ip, slot: entry.slot };
    }
    return { ip: entry, slot: null };
  });

  data.source = source;
  data.slotOf = {};
  entries.forEach(function (entry) {
    if (entry.ip && entry.slot !== null && entry.slot !== undefined) {
      data.slotOf[entry.ip] = entry.slot;
    }
  });
  data.whitelist = entries
    .map(function (entry) {
      return entry.ip;
    })
    .filter(Boolean);

  const currentEntry = entries.find(function (entry) {
    return sameC24(entry.ip, data.currentIp);
  });
  data.currentSlot = currentEntry ? currentEntry.slot : undefined;
  data.applied = data.enabled === true && !!currentEntry;

  if (data.applied && requestedSlot !== null && requestedSlot !== undefined) {
    if (
      data.currentSlot === null ||
      data.currentSlot === undefined ||
      String(data.currentSlot) !== String(requestedSlot)
    ) {
      data.applied = false;
      data.slotMismatch = true;
      data.error =
        (source === "fallback" ? "备用接口已加白，但" : "已加白，但") +
        "未固定到槽位 " +
        requestedSlot;
    }
  }
  return data;
}

function parseApiResult(exchange, requestedSlot, source) {
  const sourceName = source === "fallback" ? "备用接口" : "默认接口";
  if (exchange.networkError) {
    return { error: sourceName + "网络失败: " + excerpt(exchange.networkError), source: source };
  }

  const data = safeJSON(exchange.text);
  if (exchange.status === 403) {
    return {
      error: "槽位冲突：本机 IP 已在其它槽位，请先去 UI 删除",
      conflict: true,
      currentIp: data && data.currentIp,
      source: source,
    };
  }
  if (exchange.status < 200 || exchange.status >= 300) {
    return {
      error:
        sourceName +
        " " +
        (exchange.status || "未知状态") +
        ": " +
        (excerpt(exchange.text) || "无响应体"),
      source: source,
    };
  }
  if (!data || typeof data !== "object") {
    return {
      error: sourceName + "响应异常: " + (excerpt(exchange.text) || "空响应"),
      source: source,
    };
  }
  if (data.tokenAvailable === false) {
    return { error: sourceName + " token 不可用", source: source };
  }
  return normalizeResponse(data, requestedSlot, source);
}

async function apiCall(ctx, token, slot) {
  let primaryUrl = API_BASE + encodeURIComponent(token) + "/add";
  if (slot !== null && slot !== undefined && slot !== "") {
    primaryUrl += "?slot=" + encodeURIComponent(slot);
  }

  const primary = await requestText(ctx, "post", primaryUrl, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "",
    timeout: HTTP_TIMEOUT_MS,
    credentials: "omit",
  });

  // 不对超时、TLS、401、403 等错误盲目回退，只匹配已确认的 serviceId 兼容问题。
  if (!needsServiceIdFallback(primary)) {
    return parseApiResult(primary, slot, "primary");
  }

  const fallback = await requestText(ctx, "get", FALLBACK_API + encodeURIComponent(token), {
    headers: { Accept: "application/json" },
    timeout: HTTP_TIMEOUT_MS,
    credentials: "omit",
  });
  return parseApiResult(fallback, slot, "fallback");
}

async function ensure(ctx, item, index, cellular) {
  const kvState = STORE_PREFIX + index;
  const kvHist = STORE_PREFIX + "hist_" + index;
  const state = await apiCall(ctx, item.token, item.slot);
  if (state.applied) {
    const history = readHistory(ctx, kvHist);
    const last = history.length ? history[history.length - 1] : null;
    if (!last || last.ip !== state.currentIp) {
      history.push({ ip: state.currentIp, src: cellular ? "cell" : "fixed", ts: Date.now() });
      ctx.storage.setJSON(kvHist, history.slice(-10));
    }
  }
  return { kvState: kvState, kvHist: kvHist, slot: item.slot, st: state };
}

function describe(ctx, index, result) {
  const state = result.st;
  const pin =
    result.slot !== null && result.slot !== undefined && result.slot !== ""
      ? " 📌" + result.slot
      : "";
  const via = state.source === "fallback" ? " ↪备用" : "";
  const head = "#" + (index + 1) + pin + via + " ";
  if (state.error) return head + "❌ " + state.error;
  if (state.enabled === false) return head + "⚠️ 防火墙未启用";
  if (!state.applied) {
    return (
      head +
      "❌ 加白未生效 " +
      ((state.whitelist && state.whitelist.length) || 0) +
      "/" +
      (state.limit || "?")
    );
  }

  const history = readHistory(ctx, result.kvHist);
  const cellIps = {};
  history.forEach(function (entry) {
    if (entry.src === "cell") cellIps[entry.ip] = true;
  });
  const slotOf = state.slotOf || {};
  const ips = state.whitelist
    .map(function (ip) {
      const slotTag = slotOf[ip] !== undefined ? " 📌" + slotOf[ip] : "";
      return (
        ip + slotTag + (cellIps[ip] ? " 📶" : "") + (sameC24(ip, state.currentIp) ? " ←" : "")
      );
    })
    .join("\n    ");
  return head + "✅ " + state.whitelist.length + "/" + state.limit + "\n    " + ips;
}

export default async function (ctx) {
  const tokens = parseTokens(ctx.env && ctx.env.tokens);
  if (tokens.length === 0) {
    ctx.notify({
      title: "po0 防火墙加白",
      subtitle: "未配置 token",
      body: "模块参数 tokens 填入 pgnfw_ token，多个用英文逗号分隔",
    });
    return;
  }

  const cellular = onCellular(ctx);
  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    results.push(await ensure(ctx, tokens[i], i, cellular));
  }

  let okCount = 0;
  let exitIp = "?";
  let changed = false;
  const lines = [];
  for (let i = 0; i < results.length; i++) {
    const state = results[i].st;
    if (state.applied) okCount++;
    if (state.currentIp) exitIp = state.currentIp;
    lines.push(describe(ctx, i, results[i]));

    const storedState =
      (state.currentIp || "?") +
      "|" +
      (state.applied ? "1" : "0") +
      "|" +
      (state.source || "?") +
      "|" +
      (state.error || "");
    if (ctx.storage.get(results[i].kvState) !== storedState) {
      ctx.storage.set(results[i].kvState, storedState);
      changed = true;
    }
  }

  const title =
    "po0 加白 " + okCount + "/" + results.length + " · 出口 " + exitIp + (cellular ? " 📶" : "");
  if (changed) {
    ctx.notify({ title: "po0 防火墙加白", subtitle: title, body: lines.join("\n") });
  }
}
