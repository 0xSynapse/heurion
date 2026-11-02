/**
 * Cloudflare Email Routing Worker for Heurion Platform
 * 
 * 作用：拦截所有发往 *@heurion.org 的外部来信，以 Webhook 形式自动推送到 Heurion 生产服务器。
 * Heurion 平台收到后自动执行「方案 3」：
 * 1. 精准存入对应医生的 Heurion 站内【📥 收件箱】
 * 2. 若医生绑定了个人外部邮箱（如 Gmail/医院邮箱），自动将副本实时转交至其个人邮箱
 * 
 * 部署指引：
 * 1. 登录 Cloudflare 控制台 -> Workers & Pages -> Create Worker
 * 2. 将本文件代码粘贴入 Worker 编辑器中并保存部署（例如名称: heurion-inbound-mail）
 * 3. 在 Worker 的 Settings -> Variables 中添加环境变量：
 *    - HEURION_INBOUND_URL: https://heurion.org/api/mail/inbound
 *    - MAIL_INBOUND_SECRET: 你的安全通信密钥（与 Heurion 服务器 .env 中的 MAIL_INBOUND_SECRET 一致）
 * 4. 进入 Cloudflare 控制台 -> 域名 heurion.org -> Email Routing -> Routing Rules：
 *    - 添加 Catch-all 规则：Catch-all address -> Send to a Worker -> 选择本 Worker (heurion-inbound-mail)
 */

function decodeMimeWords(str) {
  if (!str || !str.includes("=?")) return str;
  const cleaned = str.replace(/(\?=\s+=\?)/g, "?==?");
  return cleaned.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const enc = encoding.toUpperCase();
      const cs = (charset || "utf-8").toLowerCase();
      if (enc === "B") {
        const bin = atob(text);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder(cs.includes("gb") ? "gb18030" : "utf-8").decode(bytes);
      } else if (enc === "Q") {
        const replaced = text.replace(/_/g, " ");
        const bytes = [];
        for (let i = 0; i < replaced.length; i++) {
          if (replaced[i] === "=" && i + 2 < replaced.length && /^[0-9A-Fa-f]{2}$/.test(replaced.slice(i + 1, i + 3))) {
            bytes.push(parseInt(replaced.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(replaced.charCodeAt(i));
          }
        }
        return new TextDecoder(cs.includes("gb") ? "gb18030" : "utf-8").decode(new Uint8Array(bytes));
      }
    } catch {
      return text;
    }
    return text;
  });
}

function looksLikeQuotedPrintable(str) {
  if (!str) return false;
  if (/=\r?\n/.test(str)) return true;
  if (/(?:=[0-9A-Fa-f]{2}){2,}/.test(str)) return true;
  if (/=3D/i.test(str) || /=(?:20|09)(?:\r?\n|$)/.test(str) || /=0D=0A/i.test(str)) return true;
  return false;
}

function decodeQuotedPrintable(str, charset) {
  if (!str) return "";
  const hasSoftBreak = /=\r?\n/.test(str);
  const s = hasSoftBreak ? str.replace(/=\r?\n/g, "") : str;
  if (!/=[0-9A-Fa-f]{2}/.test(s)) return s;
  if (!hasSoftBreak && !looksLikeQuotedPrintable(s)) return s;

  const cs = (charset || "").toLowerCase();
  return s.replace(/(?:=[0-9A-Fa-f]{2})+/g, (match, offset, fullStr) => {
    const before = fullStr.slice(Math.max(0, offset - 200), offset);
    if (/https?:\/\/[^\s<>"']*?[?#&][A-Za-z0-9_.-]+$/i.test(before) && !/^=3D/i.test(match)) {
      return match;
    }
    const bytes = [];
    for (let i = 0; i < match.length; i += 3) {
      bytes.push(parseInt(match.slice(i + 1, i + 3), 16));
    }
    const u8 = new Uint8Array(bytes);
    let decoded = "";
    if (cs.includes("gb")) {
      try { decoded = new TextDecoder("gb18030", { fatal: true }).decode(u8); } catch {}
    }
    if (!decoded) {
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(u8);
      } catch {
        if (u8.length >= 2) {
          try { decoded = new TextDecoder("gb18030", { fatal: true }).decode(u8); } catch {}
        }
      }
    }
    if (!decoded || decoded.includes("\uFFFD") || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) {
      return match;
    }
    return decoded;
  });
}

function decodeBase64Chunk(raw, charset) {
  if (!raw) return raw;
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (l && /\s/.test(l)) {
      return raw;
    }
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (
    compact.length < 12 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) ||
    /^[A-Za-z]+$/.test(compact)
  ) {
    return raw;
  }

  try {
    const bin = atob(compact);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    let decoded = "";
    const cs = (charset || "").toLowerCase();
    if (cs.includes("gb")) {
      try { decoded = new TextDecoder("gb18030", { fatal: true }).decode(bytes); } catch {}
    }
    if (!decoded) {
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {}
    }
    if (!decoded || decoded.includes("\uFFFD")) return raw;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) {
      return raw;
    }

    // 含有中文，或者是正常可读文本
    if (/[\u4e00-\u9fa5]/.test(decoded)) {
      return decoded;
    }
    const cleanChars = decoded.replace(/[\r\n\t\x20-\x7e\u00a0-\uffff]/g, "");
    if (cleanChars.length === 0 && decoded.trim().length > 3) {
      return decoded;
    }
  } catch {}
  return raw;
}

function decodeEmailBody(body, charset) {
  if (!body) return "";
  let text = body.trim();

  // 1. 全文 Base64 探测与解码（无论是否有换行与行首缩进）
  const fullDecoded = decodeBase64Chunk(text, charset);
  if (fullDecoded !== text) {
    text = fullDecoded;
  } else {
    // 2. 分段 Base64 探测（如邮件带有部分未分块明文，或带有引用头部）
    const blocks = text.split(/\r?\n\r?\n/);
    let changed = false;
    const decodedBlocks = blocks.map(b => {
      const trimmedBlock = b.trim();
      const d = decodeBase64Chunk(trimmedBlock, charset);
      if (d !== trimmedBlock) {
        changed = true;
        return d;
      }
      return b;
    });
    if (changed) {
      text = decodedBlocks.join("\n\n");
    }
  }

  // 3. Quoted-Printable 探测与解码 (支持 UTF-8 与 GB18030，保护普通 URL 参数)
  if (looksLikeQuotedPrintable(text)) {
    text = decodeQuotedPrintable(text, charset);
  }

  // 4. 清理残留的 MIME boundary 标记
  text = text.replace(/--[a-zA-Z0-9_\-=]+--?\s*$/g, "").trim();
  return text;
}

function htmlToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function parseMimeEmail(rawText) {
  if (!rawText) return "";

  // 1. 尝试从 Content-Type 中提取 multipart boundary
  const boundaryMatch = rawText.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1].trim();
    const parts = rawText.split(new RegExp(`--${boundary}(?:--)?`));

    // 优先寻找 text/plain 分块
    for (const part of parts) {
      const headerBodySplit = part.split(/\r?\n\r?\n/);
      if (headerBodySplit.length > 1) {
        const headerSection = headerBodySplit[0] || "";
        if (/content-type:\s*text\/plain/i.test(headerSection)) {
          const partBody = headerBodySplit.slice(1).join("\n\n").trim();
          const charsetMatch = headerSection.match(/charset="?([^"\r\n;]+)"?/i);
          const charset = charsetMatch ? charsetMatch[1].trim() : "utf-8";
          return decodeEmailBody(partBody, charset);
        }
      }
    }

    // 备选：寻找 text/html 分块（部分客户端仅发送 HTML）
    for (const part of parts) {
      const headerBodySplit = part.split(/\r?\n\r?\n/);
      if (headerBodySplit.length > 1) {
        const headerSection = headerBodySplit[0] || "";
        if (/content-type:\s*text\/html/i.test(headerSection)) {
          const partBody = headerBodySplit.slice(1).join("\n\n").trim();
          const charsetMatch = headerSection.match(/charset="?([^"\r\n;]+)"?/i);
          const charset = charsetMatch ? charsetMatch[1].trim() : "utf-8";
          const decodedHtml = decodeEmailBody(partBody, charset);
          return htmlToPlainText(decodedHtml);
        }
      }
    }
  }

  // 2. 单分块纯文本邮件：去除顶部头部字段并按 charset 与 transfer-encoding 解码
  const headerBodySplit = rawText.split(/\r?\n\r?\n/);
  if (headerBodySplit.length > 1) {
    const headerSection = headerBodySplit[0] || "";
    const partBody = headerBodySplit.slice(1).join("\n\n").trim();
    const charsetMatch = headerSection.match(/charset="?([^"\r\n;]+)"?/i);
    const charset = charsetMatch ? charsetMatch[1].trim() : "utf-8";
    return decodeEmailBody(partBody, charset);
  }

  return decodeEmailBody(rawText);
}

export default {
  async fetch(request, env, ctx) {
    return new Response("Heurion Inbound Email Worker is active", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },

  async email(message, env, ctx) {
    const headerFrom = decodeMimeWords(message.headers.get("from") || "").trim();
    const from = headerFrom || message.from;
    const to = message.to;
    const rawSubject = message.headers.get("subject") || "(无主题)";
    const subject = decodeMimeWords(rawSubject);
    
    // 读取原始邮件正文
    let rawText = "";
    try {
      rawText = await new Response(message.raw).text();
    } catch (err) {
      console.error("读取邮件流失败:", err);
    }

    // 解析文本正文（去除 MIME 头并按编码规范全方位智能解码）
    const finalBody = parseMimeEmail(rawText);

    const payload = {
      from,
      to,
      subject,
      body: finalBody,
    };

    const targetUrl = env.HEURION_INBOUND_URL || "https://heurion.org/api/mail/inbound";
    const secret = env.MAIL_INBOUND_SECRET || "";

    const headers = {
      "Content-Type": "application/json",
    };
    if (secret) {
      headers["X-Inbound-Secret"] = secret;
    }

    try {
      const res = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error(`Heurion 接收端返回错误 ${res.status}: ${errText}`);
      } else {
        console.log(`[Heurion Email Routing] 邮件成功投递至平台: from=${from} to=${to} subject=${subject}`);
      }
    } catch (err) {
      console.error("请求 Heurion Webhook 接口失败:", err);
    }
  },
};
