require("dotenv").config();

const https = require("https");
const axios = require("axios");
const FormData = require("form-data");
const { Telegraf } = require("telegraf");

function getEnv(name, fallback = "") {
  const value = process.env[name];
  if (value == null || value === "") {
    if (fallback !== "") {
      return fallback;
    }
    throw new Error(`필수 환경변수 누락: ${name}`);
  }
  return value;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseAllowedChatIds(raw) {
  return new Set(
    (raw || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
}

function extractMagnets(text) {
  if (!text) return [];
  const regex = /magnet:\?xt=urn:[^\s<>"']+/gi;
  const matches = text.match(regex) || [];
  return [...new Set(matches)];
}

class SynologyDownloadStation {
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.username = options.username;
    this.password = options.password;
    this.destination = options.destination || "";
    this.allowSelfSigned = options.allowSelfSigned;
    this.sid = null;
    this.apiInfo = null;

    const isHttps = this.baseUrl.startsWith("https://");
    const httpsAgent =
      isHttps && this.allowSelfSigned
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 20000,
      httpsAgent,
      validateStatus: (status) => status >= 200 && status < 500,
    });
  }

  async queryApiInfo() {
    if (this.apiInfo) return this.apiInfo;

    const query = new URLSearchParams({
      api: "SYNO.API.Info",
      version: "1",
      method: "query",
      query: "SYNO.API.Auth,SYNO.DownloadStation.Task",
    });

    const response = await this.http.get(`/webapi/query.cgi?${query.toString()}`);
    this.assertHttpOk(response, "SYNO API 정보 조회 실패");
    this.assertSynologySuccess(response.data, "SYNO API 정보 조회 실패");

    const authInfo = response.data?.data?.["SYNO.API.Auth"];
    const taskInfo = response.data?.data?.["SYNO.DownloadStation.Task"];
    if (!authInfo || !taskInfo) {
      throw new Error("필수 Synology API 정보를 찾지 못했습니다.");
    }

    this.apiInfo = {
      auth: authInfo,
      task: taskInfo,
    };
    return this.apiInfo;
  }

  async login(force = false) {
    if (this.sid && !force) return this.sid;

    const { auth } = await this.queryApiInfo();
    const query = new URLSearchParams({
      api: "SYNO.API.Auth",
      version: String(auth.maxVersion),
      method: "login",
      account: this.username,
      passwd: this.password,
      session: "DownloadStation",
      format: "sid",
    });

    const response = await this.http.get(`/webapi/${auth.path}?${query.toString()}`);
    this.assertHttpOk(response, "Synology 로그인 실패");
    this.assertSynologySuccess(response.data, "Synology 로그인 실패");

    const sid = response.data?.data?.sid;
    if (!sid) {
      throw new Error("Synology SID를 받지 못했습니다.");
    }

    this.sid = sid;
    return sid;
  }

  async createTaskFromUri(uri) {
    return this.runWithRetry(async () => {
      const { task } = await this.queryApiInfo();
      const payload = {
        api: "SYNO.DownloadStation.Task",
        version: String(task.maxVersion),
        method: "create",
        uri,
        _sid: this.sid,
      };

      if (this.destination) {
        payload.destination = this.destination;
      }

      const response = await this.http.post(
        `/webapi/${task.path}`,
        new URLSearchParams(payload).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      this.assertHttpOk(response, "마그넷 등록 실패");
      this.assertSynologySuccess(response.data, "마그넷 등록 실패");
    });
  }

  async createTaskFromTorrentFile(filename, fileBuffer) {
    return this.runWithRetry(async () => {
      const { task } = await this.queryApiInfo();
      const form = new FormData();
      form.append("api", "SYNO.DownloadStation.Task");
      form.append("version", String(task.maxVersion));
      form.append("method", "create");
      form.append("_sid", this.sid);
      if (this.destination) {
        form.append("destination", this.destination);
      }
      form.append("file", fileBuffer, {
        filename,
        contentType: "application/x-bittorrent",
      });

      const response = await this.http.post(`/webapi/${task.path}`, form, {
        headers: form.getHeaders(),
        maxBodyLength: 20 * 1024 * 1024,
        maxContentLength: 20 * 1024 * 1024,
      });

      this.assertHttpOk(response, "토렌트 파일 등록 실패");
      this.assertSynologySuccess(response.data, "토렌트 파일 등록 실패");
    });
  }

  async runWithRetry(action) {
    await this.login();
    try {
      return await action();
    } catch (error) {
      if (error && error.isSessionError) {
        await this.login(true);
        return action();
      }
      throw error;
    }
  }

  assertHttpOk(response, prefix) {
    if (response.status >= 400) {
      throw new Error(`${prefix}: HTTP ${response.status}`);
    }
  }

  assertSynologySuccess(data, prefix) {
    if (data && data.success) return;

    const code = data?.error?.code;
    const error = new Error(code ? `${prefix} (code: ${code})` : prefix);
    if ([105, 106, 107, 119].includes(code)) {
      error.isSessionError = true;
    }
    throw error;
  }
}

async function main() {
  const botToken = getEnv("TELEGRAM_BOT_TOKEN");
  const allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const synology = new SynologyDownloadStation({
    baseUrl: getEnv("SYNOLOGY_BASE_URL"),
    username: getEnv("SYNOLOGY_USERNAME"),
    password: getEnv("SYNOLOGY_PASSWORD"),
    destination: process.env.SYNOLOGY_DOWNLOAD_DIR || "",
    allowSelfSigned: parseBoolean(process.env.SYNOLOGY_ALLOW_SELF_SIGNED, false),
  });

  const bot = new Telegraf(botToken);

  const usage = [
    "아래 방식으로 보내면 NAS Download Station에 등록됩니다.",
    "1) 마그넷 링크를 텍스트로 전송",
    "2) .torrent 파일을 첨부로 전송",
    "",
    "명령어:",
    "/id - 현재 채팅 ID 확인",
    "/help - 사용법 보기",
  ].join("\n");

  function isAuthorized(chatId) {
    if (allowedChatIds.size === 0) return true;
    return allowedChatIds.has(String(chatId));
  }

  async function rejectUnauthorized(ctx) {
    await ctx.reply(
      "허용되지 않은 채팅입니다. /id로 채팅 ID를 확인해서 TELEGRAM_ALLOWED_CHAT_IDS에 추가하세요.",
    );
  }

  bot.start(async (ctx) => {
    if (!isAuthorized(ctx.chat.id)) {
      await rejectUnauthorized(ctx);
      return;
    }
    await ctx.reply(usage);
  });

  bot.command("help", async (ctx) => {
    if (!isAuthorized(ctx.chat.id)) {
      await rejectUnauthorized(ctx);
      return;
    }
    await ctx.reply(usage);
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(`chat_id: ${ctx.chat.id}`);
  });

  bot.on("message", async (ctx) => {
    if (!isAuthorized(ctx.chat.id)) {
      await rejectUnauthorized(ctx);
      return;
    }

    const message = ctx.message || {};
    const text = [message.text, message.caption].filter(Boolean).join("\n");
    const magnets = extractMagnets(text);

    const added = [];
    const failed = [];

    for (const magnet of magnets) {
      try {
        await synology.createTaskFromUri(magnet);
        added.push("마그넷 링크 1건");
      } catch (error) {
        failed.push(`마그넷 등록 실패: ${error.message}`);
      }
    }

    if (message.document) {
      const fileName = message.document.file_name || `upload_${Date.now()}.torrent`;
      const isTorrent =
        fileName.toLowerCase().endsWith(".torrent") ||
        message.document.mime_type === "application/x-bittorrent";

      if (!isTorrent) {
        failed.push("첨부 파일이 .torrent 형식이 아닙니다.");
      } else {
        try {
          const fileLink = await ctx.telegram.getFileLink(message.document.file_id);
          const fileResponse = await axios.get(fileLink.toString(), {
            responseType: "arraybuffer",
            maxBodyLength: 20 * 1024 * 1024,
            maxContentLength: 20 * 1024 * 1024,
          });
          await synology.createTaskFromTorrentFile(fileName, Buffer.from(fileResponse.data));
          added.push(`토렌트 파일 1건 (${fileName})`);
        } catch (error) {
          failed.push(`토렌트 파일 등록 실패: ${error.message}`);
        }
      }
    }

    if (added.length === 0 && failed.length === 0) {
      await ctx.reply("마그넷 링크 또는 .torrent 파일을 보내주세요.\n\n" + usage);
      return;
    }

    const lines = [];
    if (added.length > 0) {
      lines.push(`등록 완료: ${added.join(", ")}`);
    }
    if (failed.length > 0) {
      lines.push(`실패: ${failed.join(" | ")}`);
    }
    await ctx.reply(lines.join("\n"));
  });

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  await synology.login();
  await bot.launch();
  console.log("Synology Telegram torrent bridge is running.");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
