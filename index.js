require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs/promises");
const https = require("https");
const path = require("path");
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

function sanitizeTorrentFilename(name) {
  const input = typeof name === "string" ? name : "";
  const hasExt = input.toLowerCase().endsWith(".torrent");
  const base = hasExt ? input.slice(0, -8) : input;

  const ascii = base
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const safeBase = ascii || `upload_${Date.now()}`;
  return `${safeBase}.torrent`;
}

let parseTorrentModulePromise = null;

async function getParseTorrent() {
  if (!parseTorrentModulePromise) {
    parseTorrentModulePromise = import("parse-torrent").then((mod) => mod.default || mod);
  }
  return parseTorrentModulePromise;
}

function parseBencodeStringBounds(fileBuffer, start) {
  let cursor = start;
  let length = 0;

  while (cursor < fileBuffer.length && fileBuffer[cursor] !== 0x3a) {
    const byte = fileBuffer[cursor];
    if (byte < 0x30 || byte > 0x39) {
      throw new Error(`유효하지 않은 bencode 문자열 길이 (index: ${cursor})`);
    }
    length = length * 10 + (byte - 0x30);
    cursor += 1;
  }

  if (cursor >= fileBuffer.length) {
    throw new Error("bencode 문자열 구분자(:)를 찾지 못했습니다.");
  }

  cursor += 1;
  const end = cursor + length;
  if (end > fileBuffer.length) {
    throw new Error("bencode 문자열 길이가 버퍼 범위를 초과합니다.");
  }

  return {
    valueStart: cursor,
    valueEnd: end,
    next: end,
  };
}

function skipBencodeValue(fileBuffer, start) {
  if (start >= fileBuffer.length) {
    throw new Error("bencode value 시작 위치가 잘못되었습니다.");
  }

  const token = fileBuffer[start];

  if (token === 0x69) {
    let cursor = start + 1;
    if (cursor >= fileBuffer.length) {
      throw new Error("정수 bencode가 비어 있습니다.");
    }

    if (fileBuffer[cursor] === 0x2d) {
      cursor += 1;
    }

    let hasDigit = false;
    while (cursor < fileBuffer.length && fileBuffer[cursor] !== 0x65) {
      const byte = fileBuffer[cursor];
      if (byte < 0x30 || byte > 0x39) {
        throw new Error(`유효하지 않은 정수 bencode (index: ${cursor})`);
      }
      hasDigit = true;
      cursor += 1;
    }

    if (!hasDigit || cursor >= fileBuffer.length) {
      throw new Error("정수 bencode 종료(e)를 찾지 못했습니다.");
    }

    return cursor + 1;
  }

  if (token === 0x6c) {
    let cursor = start + 1;
    while (cursor < fileBuffer.length && fileBuffer[cursor] !== 0x65) {
      cursor = skipBencodeValue(fileBuffer, cursor);
    }
    if (cursor >= fileBuffer.length) {
      throw new Error("리스트 bencode 종료(e)를 찾지 못했습니다.");
    }
    return cursor + 1;
  }

  if (token === 0x64) {
    let cursor = start + 1;
    while (cursor < fileBuffer.length && fileBuffer[cursor] !== 0x65) {
      const keyBounds = parseBencodeStringBounds(fileBuffer, cursor);
      cursor = keyBounds.next;
      cursor = skipBencodeValue(fileBuffer, cursor);
    }
    if (cursor >= fileBuffer.length) {
      throw new Error("딕셔너리 bencode 종료(e)를 찾지 못했습니다.");
    }
    return cursor + 1;
  }

  if (token >= 0x30 && token <= 0x39) {
    return parseBencodeStringBounds(fileBuffer, start).next;
  }

  throw new Error(`알 수 없는 bencode 토큰: ${String.fromCharCode(token)} (index: ${start})`);
}

function findTorrentInfoSection(fileBuffer) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    return null;
  }

  let cursor = 0;
  if (fileBuffer[cursor] !== 0x64) {
    throw new Error("torrent 루트가 딕셔너리 형식이 아닙니다.");
  }
  cursor += 1;

  while (cursor < fileBuffer.length && fileBuffer[cursor] !== 0x65) {
    const keyBounds = parseBencodeStringBounds(fileBuffer, cursor);
    const key = fileBuffer.slice(keyBounds.valueStart, keyBounds.valueEnd).toString("utf8");
    cursor = keyBounds.next;

    const valueStart = cursor;
    const valueEnd = skipBencodeValue(fileBuffer, valueStart);
    if (key === "info") {
      return fileBuffer.slice(valueStart, valueEnd);
    }

    cursor = valueEnd;
  }

  return null;
}

function decodeBencodeValue(fileBuffer, start) {
  if (start >= fileBuffer.length) {
    throw new Error("bencode value 시작 위치가 잘못되었습니다.");
  }

  const token = fileBuffer[start];

  if (token === 0x69) {
    const end = fileBuffer.indexOf(0x65, start + 1);
    if (end === -1) {
      throw new Error("정수 bencode 종료(e)를 찾지 못했습니다.");
    }

    const raw = fileBuffer.slice(start + 1, end).toString("ascii");
    if (!/^[-]?\d+$/.test(raw)) {
      throw new Error(`유효하지 않은 정수 bencode 값: ${raw}`);
    }

    return {
      value: Number(raw),
      next: end + 1,
    };
  }

  if (token === 0x6c) {
    const list = [];
    let cursor = start + 1;
    while (cursor < fileBuffer.length && fileBuffer[cursor] !== 0x65) {
      const item = decodeBencodeValue(fileBuffer, cursor);
      list.push(item.value);
      cursor = item.next;
    }
    if (cursor >= fileBuffer.length) {
      throw new Error("리스트 bencode 종료(e)를 찾지 못했습니다.");
    }
    return {
      value: list,
      next: cursor + 1,
    };
  }

  if (token === 0x64) {
    const dict = {};
    let cursor = start + 1;
    while (cursor < fileBuffer.length && fileBuffer[cursor] !== 0x65) {
      const keyBounds = parseBencodeStringBounds(fileBuffer, cursor);
      const key = fileBuffer.slice(keyBounds.valueStart, keyBounds.valueEnd).toString("utf8");
      cursor = keyBounds.next;
      const item = decodeBencodeValue(fileBuffer, cursor);
      dict[key] = item.value;
      cursor = item.next;
    }
    if (cursor >= fileBuffer.length) {
      throw new Error("딕셔너리 bencode 종료(e)를 찾지 못했습니다.");
    }
    return {
      value: dict,
      next: cursor + 1,
    };
  }

  if (token >= 0x30 && token <= 0x39) {
    const bounds = parseBencodeStringBounds(fileBuffer, start);
    return {
      value: fileBuffer.slice(bounds.valueStart, bounds.valueEnd),
      next: bounds.next,
    };
  }

  throw new Error(`알 수 없는 bencode 토큰: ${String.fromCharCode(token)} (index: ${start})`);
}

function toUtf8String(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function collectTrackers(value, out) {
  if (!value) return;
  if (Buffer.isBuffer(value)) {
    const tracker = value.toString("utf8").trim();
    if (tracker) out.push(tracker);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTrackers(item, out);
    }
  }
}

function extractTorrentMetadata(fileBuffer) {
  const infoSection = findTorrentInfoSection(fileBuffer);
  if (!infoSection) {
    return null;
  }

  const rootDecoded = decodeBencodeValue(fileBuffer, 0);
  const root = rootDecoded?.value;
  if (!root || typeof root !== "object" || Array.isArray(root) || Buffer.isBuffer(root)) {
    return {
      infoSection,
      displayName: "",
      trackers: [],
    };
  }

  const infoDict =
    root.info && typeof root.info === "object" && !Array.isArray(root.info) && !Buffer.isBuffer(root.info)
      ? root.info
      : null;

  const displayName = toUtf8String(infoDict?.["name.utf-8"] || infoDict?.name).trim();
  const trackers = [];
  const announce = toUtf8String(root.announce).trim();
  if (announce) {
    trackers.push(announce);
  }
  collectTrackers(root["announce-list"], trackers);

  return {
    infoSection,
    displayName,
    trackers: [...new Set(trackers.filter(Boolean))],
  };
}

function buildMagnetFromInfoSection(infoSection, metadata = {}) {
  if (!Buffer.isBuffer(infoSection) || infoSection.length === 0) {
    return null;
  }

  const infoHashHex = crypto.createHash("sha1").update(infoSection).digest("hex");
  const parts = [`xt=urn:btih:${infoHashHex}`];

  const displayName = typeof metadata.displayName === "string" ? metadata.displayName.trim() : "";
  if (displayName) {
    parts.push(`dn=${encodeURIComponent(displayName)}`);
  }

  const trackers = Array.isArray(metadata.trackers) ? metadata.trackers : [];
  for (const tracker of trackers) {
    const cleanTracker = typeof tracker === "string" ? tracker.trim() : "";
    if (cleanTracker) {
      parts.push(`tr=${encodeURIComponent(cleanTracker)}`);
    }
  }

  return `magnet:?${parts.join("&")}`;
}

async function buildMagnetFromTorrentBuffer(fileBuffer, debugLog) {
  const errors = [];

  try {
    const parseTorrent = await getParseTorrent();
    const parsed = parseTorrent(fileBuffer);
    if (parsed?.magnetURI) {
      return parsed.magnetURI;
    }
    errors.push("parse-torrent 결과에 magnetURI가 없습니다.");
  } catch (error) {
    errors.push(`parse-torrent 실패: ${error.message}`);
  }

  try {
    const metadata = extractTorrentMetadata(fileBuffer);
    if (!metadata?.infoSection) {
      errors.push("torrent info 섹션을 찾지 못했습니다.");
    } else {
      const magnet = buildMagnetFromInfoSection(metadata.infoSection, metadata);
      if (magnet) {
        if (typeof debugLog === "function") {
          debugLog("torrent->magnet 내장 파서 fallback", {
            hasName: Boolean(metadata.displayName),
            trackerCount: Array.isArray(metadata.trackers) ? metadata.trackers.length : 0,
          });
        }
        return magnet;
      }
      errors.push("info hash로 magnet URI를 생성하지 못했습니다.");
    }
  } catch (error) {
    errors.push(`내장 bencode 파서 실패: ${error.message}`);
  }

  if (typeof debugLog === "function" && errors.length > 0) {
    debugLog("torrent->magnet 변환 실패", { errors });
  }

  return null;
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
    this.torrentWatchDir = options.torrentWatchDir || "";
    this.allowSelfSigned = options.allowSelfSigned;
    this.sid = null;
    this.apiInfo = null;
    this.debug = Boolean(options.debug);

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

  debugLog(...args) {
    if (!this.debug) return;
    console.log("[synology-auto-bot]", ...args);
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
      const postUriTask = async (destination, reason) => {
        const payload = {
          api: "SYNO.DownloadStation.Task",
          version: String(task.maxVersion),
          method: "create",
          uri,
          _sid: this.sid,
        };
        if (destination) {
          payload.destination = destination;
        }

        this.debugLog("createTaskFromUri attempt", {
          reason,
          destination: destination || "(default)",
          uriPreview: String(uri).slice(0, 120),
        });

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
        this.debugLog("createTaskFromUri response", response.data);
        return response;
      };

      let response = await postUriTask(this.destination, "primary");
      if (!response.data?.success && this.destination && response.data?.error?.code === 101) {
        response = await postUriTask("", "retry_without_destination");
      }

      this.assertSynologySuccess(response.data, "마그넷 등록 실패");
    });
  }

  async createTaskFromTorrentFile(filename, fileBuffer) {
    return this.runWithRetry(async () => {
      const { task } = await this.queryApiInfo();
      const safeFilename = sanitizeTorrentFilename(filename);

      if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
        throw new Error("다운로드한 파일 데이터가 비어 있습니다.");
      }

      this.debugLog("createTaskFromTorrentFile input", {
        originalFilename: filename,
        safeFilename,
        fileSize: fileBuffer.length,
        hasDestination: Boolean(this.destination),
      });

      const postTorrentWithQuery = async (destination, reason) => {
        // DSM compatibility: send control parameters in query and upload only file as POST body.
        const queryParams = new URLSearchParams({
          api: "SYNO.DownloadStation.Task",
          version: String(task.maxVersion),
          method: "create",
          _sid: this.sid,
        });
        if (destination) {
          queryParams.set("destination", destination);
        }

        const form = new FormData();
        form.append("file", fileBuffer, {
          filename: safeFilename,
          contentType: "application/x-bittorrent",
        });

        this.debugLog("torrent upload attempt", {
          reason,
          mode: "query_file",
          destination: destination || "(default)",
          filename: safeFilename,
        });

        const response = await this.http.post(
          `/webapi/${task.path}?${queryParams.toString()}`,
          form,
          {
            headers: form.getHeaders(),
            maxBodyLength: 20 * 1024 * 1024,
            maxContentLength: 20 * 1024 * 1024,
          },
        );
        this.assertHttpOk(response, "토렌트 파일 등록 실패");
        this.debugLog("torrent upload response", response.data);
        return response;
      };

      const postTorrentWithMultipart = async (destination, reason) => {
        const form = new FormData();
        form.append("api", "SYNO.DownloadStation.Task");
        form.append("version", String(task.maxVersion));
        form.append("method", "create");
        form.append("_sid", this.sid);
        if (destination) {
          form.append("destination", destination);
        }
        form.append("file", fileBuffer, {
          filename: safeFilename,
          contentType: "application/x-bittorrent",
        });

        this.debugLog("torrent upload attempt", {
          reason,
          mode: "multipart",
          destination: destination || "(default)",
          filename: safeFilename,
        });

        const response = await this.http.post(`/webapi/${task.path}`, form, {
          headers: form.getHeaders(),
          maxBodyLength: 20 * 1024 * 1024,
          maxContentLength: 20 * 1024 * 1024,
        });
        this.assertHttpOk(response, "토렌트 파일 등록 실패");
        this.debugLog("torrent upload response", response.data);
        return response;
      };

      const isParamError = (response) => response?.data?.error?.code === 101;

      let response = await postTorrentWithQuery(this.destination, "primary");
      if (response.data?.success) return;

      if (this.destination && isParamError(response)) {
        response = await postTorrentWithQuery("", "retry_without_destination");
        if (response.data?.success) return;
      }

      if (isParamError(response)) {
        response = await postTorrentWithMultipart(this.destination, "fallback_multipart");
        if (response.data?.success) return;

        if (this.destination && isParamError(response)) {
          response = await postTorrentWithMultipart("", "fallback_multipart_without_destination");
          if (response.data?.success) return;
        }
      }

      if (this.torrentWatchDir) {
        this.debugLog("torrent upload failed, retry by watch folder", {
          watchDir: this.torrentWatchDir,
          filename: safeFilename,
        });
        try {
          const savedPath = await this.enqueueTorrentFileToWatchFolder(safeFilename, fileBuffer);
          this.debugLog("watch folder enqueue success", {
            watchDir: this.torrentWatchDir,
            savedPath,
          });
          return;
        } catch (watchError) {
          this.debugLog("watch folder enqueue failed", {
            watchDir: this.torrentWatchDir,
            message: watchError.message,
          });
        }
      }

      const magnetFallback = await buildMagnetFromTorrentBuffer(fileBuffer, (...args) => this.debugLog(...args));
      if (magnetFallback) {
        this.debugLog("torrent upload failed, retry by parsed magnet", {
          magnetPreview: magnetFallback.slice(0, 160),
        });
        try {
          await this.createTaskFromUri(magnetFallback);
          return;
        } catch (magnetError) {
          this.debugLog("parsed magnet fallback failed", { message: magnetError.message });
        }
      }

      this.assertSynologySuccess(response.data, "토렌트 파일 등록 실패");
    });
  }

  async enqueueTorrentFileToWatchFolder(filename, fileBuffer) {
    const watchDir = String(this.torrentWatchDir || "").trim();
    if (!watchDir) {
      throw new Error("워치 폴더 경로가 비어 있습니다.");
    }
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
      throw new Error("워치 폴더에 저장할 토렌트 데이터가 비어 있습니다.");
    }

    const safeFilename = sanitizeTorrentFilename(filename);
    const uniquePrefix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const targetFilename = `${uniquePrefix}_${safeFilename}`;
    const targetPath = path.join(watchDir, targetFilename);
    const tempPath = `${targetPath}.part`;

    await fs.mkdir(watchDir, { recursive: true });
    await fs.writeFile(tempPath, fileBuffer);
    await fs.rename(tempPath, targetPath);

    return targetPath;
  }

  async pauseTasks(taskIds) {
    const ids = (Array.isArray(taskIds) ? taskIds : [taskIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return;
    }

    return this.runWithRetry(async () => {
      const { task } = await this.queryApiInfo();
      const payload = {
        api: "SYNO.DownloadStation.Task",
        version: String(task.maxVersion),
        method: "pause",
        id: ids.join(","),
        _sid: this.sid,
      };

      const response = await this.http.post(
        `/webapi/${task.path}`,
        new URLSearchParams(payload).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      this.assertHttpOk(response, "작업 일시정지 실패");
      this.assertSynologySuccess(response.data, "작업 일시정지 실패");
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
  const torrentWatchDir =
    process.env.SYNOLOGY_TORRENT_WATCH_DIR === undefined
      ? "/watch"
      : String(process.env.SYNOLOGY_TORRENT_WATCH_DIR || "").trim();

  const synology = new SynologyDownloadStation({
    baseUrl: getEnv("SYNOLOGY_BASE_URL"),
    username: getEnv("SYNOLOGY_USERNAME"),
    password: getEnv("SYNOLOGY_PASSWORD"),
    destination: process.env.SYNOLOGY_DOWNLOAD_DIR || "",
    torrentWatchDir,
    allowSelfSigned: parseBoolean(process.env.SYNOLOGY_ALLOW_SELF_SIGNED, false),
    debug: parseBoolean(process.env.BOT_DEBUG, false),
  });

  const autoStopSeeding = parseBoolean(process.env.AUTO_STOP_SEEDING, true);
  const autoStopSeedingIntervalSec = Math.max(
    5,
    toNumber(process.env.AUTO_STOP_SEEDING_INTERVAL_SEC, 30),
  );

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
    "",
    `워치 폴더 fallback: ${torrentWatchDir ? `ON (${torrentWatchDir})` : "OFF"}`,
    `자동 시딩 중지: ${autoStopSeeding ? "ON" : "OFF"} (주기 ${autoStopSeedingIntervalSec}초)`,
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

  async function stopSeedingTasksNow(trigger = "manual") {
    const snapshot = await synology.getTaskSnapshot(300);
    const seedingTasks = (snapshot.tasks || []).filter((task) => task.status === "seeding");

    if (seedingTasks.length === 0) {
      return { checked: snapshot.total, paused: 0, seeding: 0 };
    }

    let paused = 0;
    for (const task of seedingTasks) {
      const taskId = String(task.id || "").trim();
      if (!taskId) continue;

      try {
        await synology.pauseTasks(taskId);
        paused += 1;
        synology.debugLog("auto-stop seeding paused", {
          trigger,
          taskId,
          title: task.title,
        });
      } catch (error) {
        synology.debugLog("auto-stop seeding pause failed", {
          trigger,
          taskId,
          message: error.message,
        });
      }
    }

    return { checked: snapshot.total, paused, seeding: seedingTasks.length };
  }

  let autoStopSeedingRunning = false;
  async function runAutoStopSeeding(trigger = "interval") {
    if (!autoStopSeeding) return;
    if (autoStopSeedingRunning) return;

    autoStopSeedingRunning = true;
    try {
      const result = await stopSeedingTasksNow(trigger);
      if (result.paused > 0) {
        console.log(
          `[synology-auto-bot] auto-stop-seeding paused ${result.paused} task(s) out of ${result.seeding} seeding task(s).`,
        );
      }
    } catch (error) {
      console.error("[synology-auto-bot] auto-stop-seeding failed:", error.message);
    } finally {
      autoStopSeedingRunning = false;
    }
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

          const fileBuffer = Buffer.from(fileResponse.data);
          await synology.createTaskFromTorrentFile(fileName, fileBuffer);
          added.push(`토렌트 파일 1건 (${fileName})`);
        } catch (error) {
          failed.push(`토렌트 파일 가져오기 실패: ${error.message}`);
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

  if (autoStopSeeding) {
    await runAutoStopSeeding("startup");
    const intervalMs = autoStopSeedingIntervalSec * 1000;
    const timer = setInterval(() => {
      runAutoStopSeeding("interval");
    }, intervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    console.log(`[synology-auto-bot] auto-stop-seeding enabled (interval: ${autoStopSeedingIntervalSec}s)`);
  } else {
    console.log("[synology-auto-bot] auto-stop-seeding disabled");
  }

  if (torrentWatchDir) {
    console.log(`[synology-auto-bot] torrent watch-folder fallback enabled: ${torrentWatchDir}`);
  } else {
    console.log("[synology-auto-bot] torrent watch-folder fallback disabled");
  }

  console.log("Synology Telegram torrent bridge is running.");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
