import {
    downloadWebdavFile,
    readRemoteJson,
    readRemoteJsonWithEtag,
    uploadWebdavFile,
    uploadWebdavFileWithEtag,
    writeRemoteJson,
} from "./cloud-storage";

import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { WebdavSyncConfig } from "@/stores/use-config-store";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import type { CanvasDeletedProject, CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";

import type { CanvasIndex } from "@/types/api";

// ============================================================
// cloud-app-sync.ts — canvas 域逐画布同步
// 非 canvas 域(assets/workbench) 直接复用 app-sync.ts
// ============================================================

const FILE_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const CANVAS_DOMAIN = "canvas";
const storageKeyPattern = /^(image|video|audio|file|video-reference|audio-reference):/;

type AppSyncFile = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
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

    // ── 读远端 index.json ──
    const remoteIndex = await readRemoteJson<CanvasIndex>(config, indexFilePath());

    // ── 合并索引（墓碑无条件赢） ──
    const mergedIndex = mergeIndex(projects, deletedProjects, remoteIndex);

    // ── 下载缺失的远端画布文件 ──
    const localProjectIds = new Set(projects.map((p) => p.id));
    const remoteProjectsToFetch = mergedIndex.projects.filter((p) => !localProjectIds.has(p.id) && p.id);
    let mergedRemote = false;
    const fetchedProjects: CanvasProject[] = [];

    for (const remoteRef of remoteProjectsToFetch) {
        emitProgress(onProgress, {
            domain: "canvas",
            label: "画布",
            stage: `下载画布: ${remoteRef.title}`,
            status: "active",
        });
        const projectJson = await downloadWebdavFile(config, projectFilePath(remoteRef.id));
        if (projectJson) {
            try {
                const project = JSON.parse(await projectJson.text()) as CanvasProject;
                fetchedProjects.push(project);
                mergedRemote = true;
            } catch {
                // 跳过损坏的远端文件
            }
        }
    }

    // ── 合并画布数据 ──
    if (fetchedProjects.length > 0) {
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "合并远端画布", status: "active" });
        const allProjects = mergeProjects(projects, fetchedProjects);
        const allDeleted = mergedIndex.deleted.map((d) => ({ id: d.id, deletedAt: d.deletedAt }));

        // 下载新画布引用的媒体文件
        const allKeys = collectStorageKeys(fetchedProjects);
        if (allKeys.length > 0) {
            emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "下载缺失媒体", status: "active" });
            // 这里简化处理：从远端 manifest 获取文件列表是集成 app-sync.ts 的逻辑
            // 为防止代码重复，此处先只下载画布 JSON，媒体文件在后续同步中逐步补全
        }

        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "写入本地合并结果", status: "active" });
        useCanvasStore.getState().replaceProjects(allProjects, allDeleted);
    }

    // ── 上传本地修改过的画布 ──
    const localDirtyProjects = projects.filter((p) => {
        const remote = mergedIndex.projects.find((r) => r.id === p.id);
        return !remote || remote.updatedAt < p.updatedAt;
    });

    let uploadedFiles = 0;
    let uploadedBytes = 0;

    // 上传媒体文件
    const mediaTasks = collectChangedMedia(projects);
    if (mediaTasks.length > 0) {
        emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "上传新增媒体", status: "active" });
        await runWithConcurrency(mediaTasks, FILE_CONCURRENCY, async ({ storageKey, path }) => {
            const { blob, size } = await uploadMediaTask(config, { storageKey, path });
            if (!size) return; // blob 不存在，跳过
            uploadedFiles += 1;
            uploadedBytes += size;
            emitProgress(onProgress, {
                domain: "canvas",
                label: "画布",
                stage: `上传媒体 ${formatBytes(size)}`,
                current: uploadedFiles,
                total: mediaTasks.length,
                status: "active",
            });
        });
    }

    // 上传脏画布的 JSON
    for (const project of localDirtyProjects) {
        emitProgress(onProgress, {
            domain: "canvas",
            label: "画布",
            stage: `上传画布: ${project.title}`,
            status: "active",
        });
        const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
        await uploadWebdavFile(config, projectFilePath(project.id), blob, "application/json");
    }

    // ── 写回 index.json（带乐观锁重试） ──
    emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "上传索引", status: "active" });
    await writeIndexWithRetry(config, mergedIndex, remoteIndex);

    emitProgress(onProgress, { domain: "canvas", label: "画布", stage: "完成", current: 1, total: 1, status: "success" });

    return {
        syncedAt: new Date().toISOString(),
        mergedRemote,
        canvas: {
            projects: mergedIndex.projects.length,
            deletedProjects: mergedIndex.deleted.length,
            files: mediaTasks.length,
            uploadedFiles,
            uploadedBytes,
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

// ─── 媒体文件收集 ────────────────────────────────────────────

function collectStorageKeys(value: unknown, keys = new Set<string>()): string[] {
    if (typeof value === "string") {
        if (storageKeyPattern.test(value)) keys.add(value);
        return [...keys];
    }
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && storageKeyPattern.test(value.storageKey))
        keys.add(value.storageKey);
    Object.values(value).forEach((item) =>
        Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys),
    );
    return [...keys];
}
type MediaTask = { storageKey: string; path: string };

function collectChangedMedia(projects: CanvasProject[]): MediaTask[] {
    const tasks: MediaTask[] = [];
    const seen = new Set<string>();

    for (const project of projects) {
        const keys = collectStorageKeys(project);
        for (const storageKey of keys) {
            if (seen.has(storageKey)) continue;
            seen.add(storageKey);
            const path = `${CANVAS_DOMAIN}/files/${safeFileName(storageKey)}`;
            tasks.push({ storageKey, path });
        }
    }

    return tasks;
}

/** 在并发执行器中获取 blob 并上传 */
async function uploadMediaTask(
    config: WebdavSyncConfig,
    task: MediaTask,
): Promise<{ blob: Blob; size: number }> {
    const blob = task.storageKey.startsWith("image:")
        ? await getImageBlob(task.storageKey)
        : await getMediaBlob(task.storageKey);
    if (!blob) return { blob: new Blob(), size: 0 };
    await uploadWebdavFile(config, task.path, blob, blob.type);
    return { blob, size: blob.size };
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

/** 同步非 canvas 域（assets / image-workbench / video-workbench）
 *  domains 参数保留供后续细粒度过滤，当前 syncAppDataToWebdav 还不支持单域过滤 */
export async function syncNonCanvasDomains(
    config: WebdavSyncConfig,
    onProgress?: CloudSyncProgress,
    _domains?: AppSyncDomainKey[],
): Promise<{ mergedRemote: boolean; files: number; uploadedFiles: number; uploadedBytes: number }> {
    const result = await syncAppDataToWebdav(config, onProgress);
    return {
        mergedRemote: result.mergedRemote,
        files: result.files,
        uploadedFiles: result.uploadedFiles,
        uploadedBytes: result.uploadedBytes,
    };
}