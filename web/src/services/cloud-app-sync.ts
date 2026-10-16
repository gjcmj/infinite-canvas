import {
    downloadWebdavFile,
    readRemoteJson,
    readRemoteJsonWithEtag,
    uploadWebdavFile,
    uploadWebdavFileWithEtag,
} from "./cloud-storage";

import { collectStorageKeys, isStorageKey } from "@/lib/storage-keys";
import { getStoredBlob, setStoredBlob } from "@/services/media-blobs";
import type { WebdavSyncConfig } from "@/stores/use-config-store";
import type { CanvasDeletedProject, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { syncAppDataToWebdav, type AppSyncProgressEvent } from "@/services/app-sync";

import type { CanvasIndex } from "@/types/api";

// ============================================================
// cloud-app-sync.ts — canvas 域逐画布同步
// 非 canvas 域(assets/workbench) 直接复用 app-sync.ts
// ============================================================

const FILE_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const CANVAS_DOMAIN = "canvas";

/** 画布域媒体清单(canvas/files.json):记录远端已有媒体的路径与大小,用于跳过重传与补下载 */
type CanvasFileRecord = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

type CanvasFilesManifest = {
    app: "infinite-canvas";
    domain: "canvas";
    version: 1;
    exportedAt: string;
    files: CanvasFileRecord[];
};


export type CloudSyncResult = {
    syncedAt: string;
    mergedRemote: boolean;
    /** canvas 域同步结果 */
    canvas: {
        projects: number;
        deletedProjects: number;
        files: number;
        uploadedFiles: number;
        uploadedBytes: number;
    };
};

export type CloudSyncProgress = (event: AppSyncProgressEvent) => void;

function emitProgress(onProgress: CloudSyncProgress | undefined, event: AppSyncProgressEvent) {
    onProgress?.(event);
}

// ─── 主入口 ──────────────────────────────────────────────────

export async function syncCanvasDomain(
    config: WebdavSyncConfig,
    onProgress?: CloudSyncProgress,
): Promise<CloudSyncResult> {
    emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "等待本地数据加载", status: "active" });
    await waitForHydration(useCanvasStore);

    const { projects, deletedProjects } = useCanvasStore.getState();

    emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "读取远端索引", status: "active" });
    const [remoteIndex, remoteFiles] = await Promise.all([readRemoteJson<CanvasIndex>(config, indexFilePath()), readFilesManifest(config)]);

    // ── 合并索引（墓碑无条件赢） ──
    const mergedIndex = mergeIndex(projects, deletedProjects, remoteIndex);
    const tombstoneIds = new Set(mergedIndex.deleted.map((item) => item.id));

    // ── 拉取远端较新或本地缺失的画布 ──
    const localById = new Map(projects.map((project) => [project.id, project]));
    const remoteProjectsToFetch = mergedIndex.projects.filter((item) => {
        const local = localById.get(item.id);
        return Boolean(item.id) && (!local || local.updatedAt < item.updatedAt);
    });
    let mergedRemote = false;
    const fetchedProjects: CanvasProject[] = [];

    for (const remoteRef of remoteProjectsToFetch) {
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: `下载画布: ${remoteRef.title}`, status: "active" });
        const projectJson = await downloadWebdavFile(config, projectFilePath(remoteRef.id));
        if (!projectJson) continue;
        try {
            fetchedProjects.push(JSON.parse(await projectJson.text()) as CanvasProject);
            mergedRemote = true;
        } catch {
            // 跳过损坏的远端文件
        }
    }

    // ── 合并画布数据（墓碑优先：其他设备删掉的画布不再写回本地） ──
    const mergedProjects = mergeProjects(projects, fetchedProjects).filter((project) => Boolean(project.id) && !tombstoneIds.has(project.id));
    if (fetchedProjects.length > 0 || projects.some((project) => tombstoneIds.has(project.id))) {
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "写入本地合并结果", status: "active" });
        useCanvasStore.getState().replaceProjects(
            mergedProjects,
            mergedIndex.deleted.map((item) => ({ id: item.id, deletedAt: item.deletedAt })),
        );
    }

    // ── 补齐本地缺失媒体 + 上传新增/变更媒体 ──
    const referencedKeys = [...collectStorageKeys(mergedProjects)];
    const downloadedFiles = await downloadMissingMedia(config, referencedKeys, remoteFiles, onProgress);
    const uploaded = await uploadChangedMedia(config, referencedKeys, remoteFiles, onProgress);
    if (!hasSameFiles(uploaded.records, remoteFiles)) {
        const manifest: CanvasFilesManifest = { app: "infinite-canvas", domain: "canvas", version: 1, exportedAt: new Date().toISOString(), files: uploaded.records };
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "上传媒体清单", status: "active" });
        await uploadWebdavFile(config, filesFilePath(), new Blob([JSON.stringify(manifest)], { type: "application/json" }), "application/json");
    }

    // ── 上传本地更新的画布 ──
    const remoteUpdatedAtById = new Map((remoteIndex?.projects || []).map((item) => [item.id, item.updatedAt]));
    const dirtyProjects = mergedProjects.filter((project) => {
        if (!project.id || tombstoneIds.has(project.id)) return false;
        const remoteUpdatedAt = remoteUpdatedAtById.get(project.id);
        return !remoteUpdatedAt || remoteUpdatedAt < project.updatedAt;
    });
    for (const project of dirtyProjects) {
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: `上传画布: ${project.title}`, status: "active" });
        const file = new Blob([JSON.stringify(toRemoteProject(project), null, 2)], { type: "application/json" });
        await uploadWebdavFile(config, projectFilePath(project.id), file, "application/json");
    }

    // ── 写回 index.json（带乐观锁重试，内容无变化时跳过） ──
    if (!hasSameIndexContent(mergedIndex, remoteIndex)) {
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "上传索引", status: "active" });
        await writeIndexWithRetry(config, mergedIndex, remoteIndex);
    }

    emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "完成", current: 1, total: 1, status: "success" });

    return {
        syncedAt: new Date().toISOString(),
        mergedRemote: mergedRemote || downloadedFiles > 0,
        canvas: {
            projects: mergedIndex.projects.length,
            deletedProjects: mergedIndex.deleted.length,
            files: uploaded.records.length,
            uploadedFiles: uploaded.uploadedFiles,
            uploadedBytes: uploaded.uploadedBytes,
        },
    };
}

// ─── 索引合并 + 墓碑逻辑 ─────────────────────────────────────

function mergeIndex(
    localProjects: CanvasProject[],
    localDeleted: CanvasDeletedProject[],
    remoteIndex: CanvasIndex | null,
): CanvasIndex {
    const remoteProjects = remoteIndex?.projects || [];
    const remoteDeleted = remoteIndex?.deleted || [];

    // 合并墓碑：墓碑无条件赢，只要任意一端有删除记录即保留
    const tombstoneMap = new Map<string, string>(); // id → deletedAt
    for (const d of [...localDeleted, ...remoteDeleted]) {
        if (!d.id || !d.deletedAt) continue;
        const existing = tombstoneMap.get(d.id);
        if (!existing || d.deletedAt >= existing) tombstoneMap.set(d.id, d.deletedAt);
    }

    // 合并项目：按 updatedAt 新者胜，但墓碑优先
    const mergedProjectMap = new Map<string, CanvasIndex["projects"][0]>();
    for (const p of remoteProjects) {
        if (p.id && !tombstoneMap.has(p.id)) mergedProjectMap.set(p.id, p);
    }
    for (const p of localProjects) {
        if (!p.id) continue;
        if (tombstoneMap.has(p.id)) continue; // 墓碑无条件赢：跳过
        const existing = mergedProjectMap.get(p.id);
        if (!existing || p.updatedAt >= existing.updatedAt) {
            mergedProjectMap.set(p.id, { id: p.id, title: p.title, updatedAt: p.updatedAt });
        }
    }

    return {
        app: "infinite-canvas",
        domain: "canvas",
        version: 1,
        exportedAt: new Date().toISOString(),
        projects: Array.from(mergedProjectMap.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
        deleted: Array.from(tombstoneMap.entries()).map(([id, deletedAt]) => ({ id, deletedAt })),
    };
}

function mergeProjects(local: CanvasProject[], fetched: CanvasProject[]): CanvasProject[] {
    const map = new Map<string, CanvasProject>();
    for (const p of fetched) {
        if (p.id) map.set(p.id, p);
    }
    for (const p of local) {
        if (!p.id) continue;
        const existing = map.get(p.id);
        if (!existing || p.updatedAt >= existing.updatedAt) map.set(p.id, p);
    }
    return Array.from(map.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

// ─── index.json 乐观锁写入（重试循环） ───────────────────────

async function writeIndexWithRetry(
    config: WebdavSyncConfig,
    merged: CanvasIndex,
    previousRemote: CanvasIndex | null,
): Promise<void> {
    const file = new Blob([JSON.stringify(merged, null, 2)], { type: "application/json" });

    if (!previousRemote) {
        // 首次写入，不使用 If-Match
        await uploadWebdavFile(config, indexFilePath(), file, "application/json");
        return;
    }

    // 读取远端获取 etag
    const { etag } = await readRemoteJsonWithEtag<CanvasIndex>(config, indexFilePath());

    if (!etag) {
        // 远端不存在或没有 etag，直接写入
        await uploadWebdavFile(config, indexFilePath(), file, "application/json");
        return;
    }

    // 用 If-Match 写入，冲突时重试
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await uploadWebdavFileWithEtag(config, indexFilePath(), file, etag);
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message !== "CONFLICT" || attempt >= MAX_RETRIES) {
                throw new Error("索引写入失败，已达最大重试次数");
            }
            // 重读远端，重新合并，获取新 etag
            const { data: freshRemote, etag: newEtag } = await readRemoteJsonWithEtag<CanvasIndex>(config, indexFilePath());
            if (!freshRemote || !newEtag) {
                throw new Error("远端索引读取出错");
            }
            // 重新合并
            const remerged: CanvasIndex = {
                ...merged,
                projects: mergeIndexProjects(merged.projects, freshRemote.projects),
                deleted: mergeTombstones(merged.deleted, freshRemote.deleted),
            };
            const retryFile = new Blob([JSON.stringify(remerged, null, 2)], { type: "application/json" });
            await uploadWebdavFileWithEtag(config, indexFilePath(), retryFile, newEtag);
            return;
        }
    }
}

function mergeIndexProjects(
    local: CanvasIndex["projects"],
    remote: CanvasIndex["projects"],
): CanvasIndex["projects"] {
    const map = new Map<string, CanvasIndex["projects"][0]>();
    for (const p of remote) if (p.id) map.set(p.id, p);
    for (const p of local) {
        if (!p.id) continue;
        const existing = map.get(p.id);
        if (!existing || p.updatedAt >= existing.updatedAt) map.set(p.id, p);
    }
    return Array.from(map.values());
}

function mergeTombstones(
    local: CanvasIndex["deleted"],
    remote: CanvasIndex["deleted"],
): CanvasIndex["deleted"] {
    const map = new Map<string, string>();
    for (const d of [...remote, ...local]) {
        if (!d.id || !d.deletedAt) continue;
        const existing = map.get(d.id);
        if (!existing || d.deletedAt >= existing) map.set(d.id, d.deletedAt);
    }
    return Array.from(map.entries()).map(([id, deletedAt]) => ({ id, deletedAt }));
}

// ─── 路径辅助 ────────────────────────────────────────────────

function indexFilePath(): string {
    return `${CANVAS_DOMAIN}/index.json`;
}

function projectFilePath(id: string): string {
    return `${CANVAS_DOMAIN}/projects/${id}.json`;
}

// ─── 媒体清单 + 传输 ──────────────────────────────────────────

function filesFilePath(): string {
    return `${CANVAS_DOMAIN}/files.json`;
}

function mediaFilePath(storageKey: string, mimeType: string): string {
    return `${CANVAS_DOMAIN}/files/${safeFileName(storageKey)}.${fileExtension(mimeType, storageKey)}`;
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    return storageKey.startsWith("image:") ? "png" : "bin";
}

/** 读远端媒体清单，缺失或格式不符时按空清单处理 */
async function readFilesManifest(config: WebdavSyncConfig): Promise<CanvasFileRecord[]> {
    const manifest = await readRemoteJson<CanvasFilesManifest>(config, filesFilePath());
    if (!manifest || !Array.isArray(manifest.files)) return [];
    return manifest.files.filter((item) => item && typeof item.storageKey === "string" && isStorageKey(item.storageKey) && typeof item.path === "string");
}

/** 本地缺失的媒体从远端补齐 */
async function downloadMissingMedia(config: WebdavSyncConfig, storageKeys: string[], remoteFiles: CanvasFileRecord[], onProgress?: CloudSyncProgress) {
    const remoteByKey = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const tasks: CanvasFileRecord[] = [];
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const blob = await getStoredBlob(storageKey);
        scanned += 1;
        if (!blob) {
            const remote = remoteByKey.get(storageKey);
            if (remote) tasks.push(remote);
        }
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "检查缺失媒体", current: scanned, total: storageKeys.length, status: "active" });
    }
    if (!tasks.length) return 0;

    let downloaded = 0;
    await runWithConcurrency(tasks, FILE_CONCURRENCY, async (remote) => {
        const blob = await downloadWebdavFile(config, remote.path);
        if (!blob) return;
        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, remote.mimeType || "application/octet-stream");
        await setStoredBlob(remote.storageKey, typedBlob);
        downloaded += 1;
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "下载媒体", current: downloaded, total: tasks.length, status: "active" });
    });
    return downloaded;
}

/** 只上传远端缺失或大小不一致的媒体，返回用于写回清单的完整记录 */
async function uploadChangedMedia(config: WebdavSyncConfig, storageKeys: string[], remoteFiles: CanvasFileRecord[], onProgress?: CloudSyncProgress) {
    const remoteByKey = new Map(remoteFiles.map((item) => [item.storageKey, item]));
    const tasks: Array<{ record: CanvasFileRecord; blob: Blob }> = [];
    const records: CanvasFileRecord[] = [];
    let scanned = 0;
    for (const storageKey of storageKeys) {
        const blob = await getStoredBlob(storageKey);
        const remote = remoteByKey.get(storageKey);
        scanned += 1;
        if (!blob) {
            // 本地没有 blob（尚未下载或已清理）时保留远端记录，避免清单丢条目
            if (remote) records.push(remote);
        } else {
            const record: CanvasFileRecord = {
                storageKey,
                path: remote?.path || mediaFilePath(storageKey, blob.type),
                mimeType: blob.type || remote?.mimeType || "application/octet-stream",
                bytes: blob.size,
            };
            records.push(record);
            if (!remote || remote.bytes !== blob.size) tasks.push({ record, blob });
        }
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "检查本地媒体", current: scanned, total: storageKeys.length, status: "active" });
    }
    // 本机未引用但远端已有的条目继续保留，避免其他设备重复上传
    const referenced = new Set(storageKeys);
    remoteFiles.forEach((item) => {
        if (!referenced.has(item.storageKey)) records.push(item);
    });

    let uploadedFiles = 0;
    let uploadedBytes = 0;
    await runWithConcurrency(tasks, FILE_CONCURRENCY, async ({ record, blob }) => {
        await uploadWebdavFile(config, record.path, blob, record.mimeType);
        uploadedFiles += 1;
        uploadedBytes += blob.size;
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: `上传媒体 ${formatBytes(blob.size)}`, current: uploadedFiles, total: tasks.length, status: "active" });
    });

    return { records, uploadedFiles, uploadedBytes };
}

function hasSameFiles(records: CanvasFileRecord[], remoteFiles: CanvasFileRecord[]) {
    if (records.length !== remoteFiles.length) return false;
    const remoteByKey = new Map(remoteFiles.map((item) => [item.storageKey, `${item.path}|${item.bytes}`]));
    return records.every((item) => remoteByKey.get(item.storageKey) === `${item.path}|${item.bytes}`);
}

/** 节点 content 里的 blob: URL 只对本机有效，上传前清空，本地加载时按 storageKey 重新补水 */
function toRemoteProject(project: CanvasProject): CanvasProject {
    return replaceBlobUrls(project) as CanvasProject;
}

function replaceBlobUrls(value: unknown): unknown {
    if (typeof value === "string") return value.startsWith("blob:") ? "" : value;
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(replaceBlobUrls);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceBlobUrls(item)]));
}

function hasSameIndexContent(index: CanvasIndex, remote: CanvasIndex | null) {
    if (!remote) return false;
    if (index.projects.length !== remote.projects.length || index.deleted.length !== remote.deleted.length) return false;
    const remoteProjects = new Map(remote.projects.map((item) => [item.id, item.updatedAt]));
    if (index.projects.some((item) => remoteProjects.get(item.id) !== item.updatedAt)) return false;
    const remoteDeleted = new Map(remote.deleted.map((item) => [item.id, item.deletedAt]));
    return index.deleted.every((item) => remoteDeleted.get(item.id) === item.deletedAt);
}

// ─── 工具函数 ────────────────────────────────────────────────

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function waitForHydration<T extends { hydrated: boolean }>(store: {
    getState: () => T;
    subscribe: (listener: (state: T) => void) => () => void;
}) {
    if (store.getState().hydrated) return;
    return new Promise<void>((resolve) => {
        const unsubscribe = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
    });
}

async function runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index], index);
            }
        }),
    );
    return results;
}

/** 同步非 canvas 域（assets / image-workbench / video-workbench）；canvas 域由 syncCanvasDomain 按画布独立同步 */
export async function syncNonCanvasDomains(
    config: WebdavSyncConfig,
    onProgress?: CloudSyncProgress,
): Promise<{ mergedRemote: boolean; files: number; uploadedFiles: number; uploadedBytes: number }> {
    const result = await syncAppDataToWebdav(config, onProgress, { skipCanvas: true });
    return {
        mergedRemote: result.mergedRemote,
        files: result.files,
        uploadedFiles: result.uploadedFiles,
        uploadedBytes: result.uploadedBytes,
    };
}