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

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatBytes(bytes) {
  const value = toNumber(bytes, 0);
  if (value <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unitIdx = 0;

  while (scaled >= 1024 && unitIdx < units.length - 1) {
    scaled /= 1024;
    unitIdx += 1;
  }

  const precision = scaled >= 100 || unitIdx === 0 ? 0 : 1;
  return `${scaled.toFixed(precision)} ${units[unitIdx]}`;
}

function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatPercent(ratio) {
  const num = toNumber(ratio, 0);
  const clamped = Math.min(1, Math.max(0, num));
  return `${(clamped * 100).toFixed(1)}%`;
}

function shortenText(text, limit = 46) {
  if (!text) return "이름없음";
  if (text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  return `${text.slice(0, limit - 3)}...`;
}

function taskStatusLabel(status) {
  const map = {
    waiting: "대기",
    downloading: "다운로드중",
    paused: "일시정지",
    finishing: "마무리중",
    hashing: "해시검사중",
    hash_checking: "해시검사중",
    checking: "검사중",
    seeding: "시딩중",
    finished: "완료",
    error: "오류",
    extracting: "압축해제중",
    filehosting_waiting: "호스팅대기",
    filehosting_downloading: "호스팅다운로드",
  };
  return map[status] || status || "알수없음";
}

function taskSortTime(task) {
  return toNumber(task?.additional?.detail?.create_time, 0);
}

function taskSize(task) {
  return toNumber(task?.size, 0);
}

function taskDownloaded(task) {
  return toNumber(task?.additional?.transfer?.size_downloaded, 0);
}

function taskDownloadSpeed(task) {
  return toNumber(task?.additional?.transfer?.speed_download, 0);
}

function taskUploadSpeed(task) {
  return toNumber(task?.additional?.transfer?.speed_upload, 0);
}

const ACTIVE_STATUSES = new Set([
  "waiting",
  "downloading",
  "finishing",
  "hashing",
  "hash_checking",
  "checking",
  "seeding",
  "extracting",
  "filehosting_waiting",
  "filehosting_downloading",
]);

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

      // DSM compatibility: send control parameters in query and upload only file as POST body.
      const queryParams = new URLSearchParams({
        api: "SYNO.DownloadStation.Task",
        version: String(task.maxVersion),
        method: "create",
        _sid: this.sid,
      });
      if (this.destination) {
        queryParams.set("destination", this.destination);
      }

      const form = new FormData();
      form.append("file", fileBuffer, {
        filename,
        contentType: "application/x-bittorrent",
      });

      let response = await this.http.post(
        `/webapi/${task.path}?${queryParams.toString()}`,
        form,
        {
          headers: form.getHeaders(),
          maxBodyLength: 20 * 1024 * 1024,
          maxContentLength: 20 * 1024 * 1024,
        },
      );

      this.assertHttpOk(response, "토렌트 파일 등록 실패");
      if (response.data?.success) return;

      // Fallback: some DSM versions accept all parameters in multipart body.
      if (response.data?.error?.code === 101) {
        const fallbackForm = new FormData();
        fallbackForm.append("api", "SYNO.DownloadStation.Task");
        fallbackForm.append("version", String(task.maxVersion));
        fallbackForm.append("method", "create");
        fallbackForm.append("_sid", this.sid);
        if (this.destination) {
          fallbackForm.append("destination", this.destination);
        }
        fallbackForm.append("file", fileBuffer, {
          filename,
          contentType: "application/x-bittorrent",
        });

        response = await this.http.post(`/webapi/${task.path}`, fallbackForm, {
          headers: fallbackForm.getHeaders(),
          maxBodyLength: 20 * 1024 * 1024,
          maxContentLength: 20 * 1024 * 1024,
        });

        this.assertHttpOk(response, "토렌트 파일 등록 실패");
        this.assertSynologySuccess(response.data, "토렌트 파일 등록 실패");
        return;
      }

      this.assertSynologySuccess(response.data, "토렌트 파일 등록 실패");
    });
  }

  async listTasks(options = {}) {
    const offset = toNumber(options.offset, 0);
    const limit = Math.max(1, toNumber(options.limit, 50));

    return this.runWithRetry(async () => {
      const { task } = await this.queryApiInfo();
      const query = new URLSearchParams({
        api: "SYNO.DownloadStation.Task",
        version: String(task.maxVersion),
        method: "list",
        offset: String(offset),
        limit: String(limit),
        additional: "detail,transfer",
        _sid: this.sid,
      });

      const response = await this.http.get(`/webapi/${task.path}?${query.toString()}`);
      this.assertHttpOk(response, "작업 목록 조회 실패");
      this.assertSynologySuccess(response.data, "작업 목록 조회 실패");
      return response.data?.data || { tasks: [], total: 0 };
    });
  }

  async getTaskSnapshot(maxTasks = 200) {
    const safeMax = Math.max(1, toNumber(maxTasks, 200));
    const pageSize = 50;
    const tasks = [];
    let offset = 0;
    let total = 0;

    while (tasks.length < safeMax) {
      const data = await this.listTasks({
        offset,
        limit: Math.min(pageSize, safeMax - tasks.length),
      });
      const page = Array.isArray(data.tasks) ? data.tasks : [];
      total = Math.max(total, toNumber(data.total, page.length));
      tasks.push(...page);

      if (page.length === 0 || tasks.length >= total) {
        break;
      }
      offset += page.length;
    }

    return {
      total: Math.max(total, tasks.length),
      tasks,
    };
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
    "/stat - Download Station 상태 요약",
    "/task - 다운로드 진행 상황",
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

  async function ensureAuthorized(ctx) {
    if (!isAuthorized(ctx.chat.id)) {
      await rejectUnauthorized(ctx);
      return false;
    }
    return true;
  }

  bot.start(async (ctx) => {
    if (!(await ensureAuthorized(ctx))) return;
    await ctx.reply(usage);
  });

  bot.command("help", async (ctx) => {
    if (!(await ensureAuthorized(ctx))) return;
    await ctx.reply(usage);
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(`chat_id: ${ctx.chat.id}`);
  });

  bot.command("stat", async (ctx) => {
    if (!(await ensureAuthorized(ctx))) return;

    try {
      const snapshot = await synology.getTaskSnapshot(200);
      const tasks = snapshot.tasks || [];
      const counts = {};
      let totalDownloadSpeed = 0;
      let totalUploadSpeed = 0;

      for (const task of tasks) {
        const status = task.status || "unknown";
        counts[status] = (counts[status] || 0) + 1;
        totalDownloadSpeed += taskDownloadSpeed(task);
        totalUploadSpeed += taskUploadSpeed(task);
      }

      const activeCount = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length;
      const downloadingCount = counts.downloading || 0;
      const waitingCount = counts.waiting || 0;
      const pausedCount = counts.paused || 0;
      const seedingCount = counts.seeding || 0;
      const finishedCount = counts.finished || 0;
      const errorCount = counts.error || 0;

      const lines = [
        "Download Station 상태",
        "- 연결 상태: 정상",
        `- 총 작업: ${snapshot.total}건`,
        `- 진행중: ${activeCount}건 (다운로드 ${downloadingCount} / 대기 ${waitingCount} / 시딩 ${seedingCount})`,
        `- 일시정지: ${pausedCount}건`,
        `- 완료: ${finishedCount}건`,
        `- 오류: ${errorCount}건`,
        `- 현재 속도: ↓ ${formatSpeed(totalDownloadSpeed)} | ↑ ${formatSpeed(totalUploadSpeed)}`,
      ];

      if (snapshot.total > tasks.length) {
        lines.push(`- 참고: 최근 ${tasks.length}건 기준으로 속도/상태를 집계했습니다.`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (error) {
      await ctx.reply(`상태 조회 실패: ${error.message}`);
    }
  });

  bot.command("task", async (ctx) => {
    if (!(await ensureAuthorized(ctx))) return;

    try {
      const snapshot = await synology.getTaskSnapshot(200);
      const tasks = (snapshot.tasks || []).slice().sort((a, b) => taskSortTime(b) - taskSortTime(a));
      const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
      const target = activeTasks.length > 0 ? activeTasks : tasks;
      const selected = target.slice(0, 10);

      if (selected.length === 0) {
        await ctx.reply("등록된 다운로드 작업이 없습니다.");
        return;
      }

      const lines = [
        activeTasks.length > 0
          ? `진행중 작업 ${selected.length}건`
          : `진행중 작업이 없어 최근 작업 ${selected.length}건을 보여줍니다.`,
      ];

      selected.forEach((task, index) => {
        const status = taskStatusLabel(task.status);
        const title = shortenText(task.title);
        const size = taskSize(task);
        const downloaded = taskDownloaded(task);
        const speed = taskDownloadSpeed(task);

        let progressText = "-";
        if (size > 0) {
          progressText = `${formatBytes(downloaded)} / ${formatBytes(size)} (${formatPercent(downloaded / size)})`;
        } else if (task.status === "finished") {
          progressText = "완료";
        } else if (downloaded > 0) {
          progressText = `${formatBytes(downloaded)} 다운로드됨`;
        }

        const speedText = speed > 0 ? ` | ↓ ${formatSpeed(speed)}` : "";
        lines.push(`${index + 1}. ${status} | ${progressText}${speedText} | ${title}`);
      });

      if (snapshot.total > tasks.length) {
        lines.push(`참고: 전체 ${snapshot.total}건 중 최근 ${tasks.length}건만 조회했습니다.`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (error) {
      await ctx.reply(`작업 조회 실패: ${error.message}`);
    }
  });

  bot.on("message", async (ctx) => {
    if (!(await ensureAuthorized(ctx))) return;

    const message = ctx.message || {};
    if (typeof message.text === "string" && message.text.trim().startsWith("/")) {
      return;
    }

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
