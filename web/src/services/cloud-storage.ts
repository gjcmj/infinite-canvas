import { getAuthToken, promptCloudAuth } from "@/stores/use-auth-store";
import type { WebdavSyncConfig } from "@/stores/use-config-store";
import type { StorageHealthResponse, StorageUploadResponse } from "@/types/api";

// ============================================================
// cloud-storage.ts — HTTP 云存储传输层
// 导出函数签名与 webdav-sync.ts 完全一致
// ============================================================

export const WEBDAV_MANIFEST_FILE_NAME = "manifest.json";
const REQUEST_TIMEOUT_MS = 120000;

// ─── Mock 开关 ──────────────────────────────────────────────
// 默认直连真实后端；仅在显式设置 VITE_CLOUD_MOCK=true 时走内存模拟数据
const MOCK = import.meta.env.VITE_CLOUD_MOCK === "true";
// ─── 工具函数 ───────────────────────────────────────────────

function buildUrl(config: WebdavSyncConfig, path: string): string {
    const base = config.url.trim().replace(/\/+$/, "");
    const remotePath = [config.directory, path].filter(Boolean).join("/");
    if (!remotePath) return base;
    return `${base}/api/storage/file?path=${encodeURIComponent(remotePath)}`;
}

function healthUrl(config: WebdavSyncConfig): string {
    const base = config.url.trim().replace(/\/+$/, "");
    return `${base}/api/storage/health`;
}

function authHeaders(): Record<string, string> {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

async function cloudFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const auth = authHeaders();
    for (const [key, value] of Object.entries(auth)) headers.set(key, value);
    if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/octet-stream");

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...init, headers, signal: controller.signal });
        // token 失效时引导用户回到云存储配置重新填写
        if (response.status === 401) promptCloudAuth();
        return response;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("请求超时");
        if (error instanceof TypeError) throw new Error("连接失败");
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

// ─── Mock 实现 ──────────────────────────────────────────────

const mockFiles = new Map<string, Blob>();
let mockEtagCounter = 0;

function mockEtag(): string {
    mockEtagCounter += 1;
    return `"mock-etag-${mockEtagCounter}"`;
}

async function mockTestConnection(_config: WebdavSyncConfig): Promise<void> {
    // 总是通过
}

async function mockDownloadFile(_config: WebdavSyncConfig, path: string): Promise<Blob | null> {
    // 返回 mock 数据或 null
    if (path.endsWith("index.json")) {
        const content = JSON.stringify({
            app: "infinite-canvas",
            domain: "canvas",
            version: 1,
            exportedAt: new Date().toISOString(),
            projects: [],
            deleted: [],
        });
        return new Blob([content], { type: "application/json" });
    }
    // 其他文件从 mock map 中读取
    return mockFiles.get(path) || null;
}

async function mockUploadFile(
    _config: WebdavSyncConfig,
    path: string,
    file: Blob,
    _contentType: string,
): Promise<StorageUploadResponse> {
    mockFiles.set(path, file);
    return { path, bytes: file.size, etag: mockEtag() };
}

async function mockDeleteFile(_config: WebdavSyncConfig, _path: string): Promise<void> {
    // 无操作
}

// ─── 公共导出函数 ────────────────────────────────────────────

/** 测试云端连接（GET /api/storage/health） */
export async function testWebdavConnection(config: WebdavSyncConfig): Promise<void> {
    if (MOCK) return mockTestConnection(config);

    const response = await cloudFetch(healthUrl(config));
    if (response.ok) return;

    if (response.status === 401) throw new Error("认证失败，请检查 Token");
    const body: StorageHealthResponse | null = await response.json().catch(() => null);
    throw new Error(body?.ok === false ? "云端服务不可用" : `连接测试失败 (${response.status})`);
}

/** 下载文件（GET /api/storage/file?path=） */
export async function downloadWebdavFile(config: WebdavSyncConfig, path: string): Promise<Blob | null> {
    if (MOCK) return mockDownloadFile(config, path);

    const response = await cloudFetch(buildUrl(config, path));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`下载失败 (${response.status})`);
    const blob = await response.blob();
    return blob.size ? blob : null;
}

/** 便捷: 下载 manifest 文件 */
export async function downloadWebdavSyncFile(config: WebdavSyncConfig): Promise<Blob | null> {
    return downloadWebdavFile(config, WEBDAV_MANIFEST_FILE_NAME);
}

/** 上传文件（PUT /api/storage/file?path=） */
export async function uploadWebdavFile(
    config: WebdavSyncConfig,
    path: string,
    file: Blob,
    contentType = "application/octet-stream",
): Promise<void> {
    if (!file.size) throw new Error("不能上传空文件");
    if (MOCK) {
        await mockUploadFile(config, path, file, contentType);
        return;
    }

    const url = buildUrl(config, path);
    const response = await cloudFetch(url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
    });
    if (!response.ok) {
        if (response.status === 412) throw new Error("CONFLICT"); // 乐观锁冲突，上层重试
        if (response.status === 413) throw new Error("超出配额限制");
        throw new Error(`上传失败 (${response.status})`);
    }
}

/** 便捷: 上传 manifest 文件 */
export async function uploadWebdavSyncFile(config: WebdavSyncConfig, file: Blob): Promise<void> {
    return uploadWebdavFile(config, WEBDAV_MANIFEST_FILE_NAME, file, "application/json");
}

/** 删除文件（DELETE /api/storage/file?path=） */
export async function deleteWebdavFile(config: WebdavSyncConfig, path: string): Promise<void> {
    if (MOCK) return mockDeleteFile(config, path);

    const response = await cloudFetch(buildUrl(config, path), { method: "DELETE" });
    if (response.status === 404) return; // 不存在也视为成功
    if (!response.ok) throw new Error(`删除失败 (${response.status})`);
}

/** 带 If-Match 的上传（供 cloud-app-sync 乐观锁重试用） */
export async function uploadWebdavFileWithEtag(
    config: WebdavSyncConfig,
    path: string,
    file: Blob,
    etag: string,
    contentType = "application/json",
): Promise<void> {
    if (!file.size) throw new Error("不能上传空文件");
    if (MOCK) {
        await mockUploadFile(config, path, file, contentType);
        return;
    }

    const url = buildUrl(config, path);
    const response = await cloudFetch(url, {
        method: "PUT",
        headers: { "Content-Type": contentType, "If-Match": etag },
        body: file,
    });
    if (!response.ok) {
        if (response.status === 412) throw new Error("CONFLICT");
        if (response.status === 413) throw new Error("超出配额限制");
        throw new Error(`上传失败 (${response.status})`);
    }
}

/** 读取远端 JSON 文件的辅助函数 */
export async function readRemoteJson<T>(config: WebdavSyncConfig, path: string): Promise<T | null> {
    const blob = await downloadWebdavFile(config, path);
    if (!blob) return null;
    return JSON.parse(await blob.text()) as T;
}

/** 写入远端 JSON 文件的辅助函数（含重试） */
export async function writeRemoteJson<T>(
    config: WebdavSyncConfig,
    path: string,
    data: T,
): Promise<void> {
    const file = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    await uploadWebdavFile(config, path, file, "application/json");
}

/** 读取远端 JSON 文件并返回 etag（供乐观锁用） */
export async function readRemoteJsonWithEtag<T>(
    config: WebdavSyncConfig,
    path: string,
): Promise<{ data: T | null; etag: string | null }> {
    if (MOCK) {
        const data = await readRemoteJson<T>(config, path);
        return { data, etag: '"mock-etag"' };
    }
    const url = buildUrl(config, path);
    const response = await cloudFetch(url);
    if (response.status === 404) return { data: null, etag: null };
    if (!response.ok) throw new Error(`读取失败 (${response.status})`);
    const data = JSON.parse(await response.text()) as T;
    const etag = response.headers.get("ETag");
    return { data, etag };
}