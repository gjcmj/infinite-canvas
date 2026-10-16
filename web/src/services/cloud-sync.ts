import i18n from "@/i18n";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useConfigStore, type WebdavSyncConfig } from "@/stores/use-config-store";
import { ensureGatewayChannel, refreshGatewayModels } from "@/services/api/model-gateway";
import { syncCanvasDomain, syncNonCanvasDomains } from "./cloud-app-sync";
import type { CloudSyncResult } from "./cloud-app-sync";

// ============================================================
// cloud-sync.ts — 自动同步调度器
// 监听 store 变化，防抖触发逐画布 + 非 canvas 域同步
// ============================================================

const DEFAULT_DEBOUNCE_MS = 30000;
const FLUSH_DEBOUNCE_MS = 5000;
const MIN_INTERVAL_MS = 10000;

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let isSyncing = false;
let isDirty = false;
let lastSyncAt = 0;
/** 用于引用比较的上一轮 projects/Assets snapshot */
let lastProjectsJson = "";
let lastAssetsJson = "";
let unsubscribeList: Array<() => void> = [];

/** 初始化自动同步（在 app 启动时调用一次） */
export function initCloudSync(): void {
    // 确保 gateway 虚拟渠道存在，并在已配置网关地址时后台刷新模型列表
    ensureGatewayChannel();
    void refreshGatewayModels().catch(() => undefined);

    const trySubscribe = () => {
        const canvasHydrated = useCanvasStore.getState().hydrated;
        const assetHydrated = useAssetStore.getState().hydrated;
        if (!canvasHydrated || !assetHydrated) {
            setTimeout(trySubscribe, 100);
            return;
        }
        subscribeStores();
        registerLifecycleHooks();
        void syncOnStartup();
    };
    // setTimeout 延迟到 React render 之后，避免启动竞争
    setTimeout(trySubscribe, 0);
}

export function destroyCloudSync(): void {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    unsubscribeList.forEach((fn) => fn());
    unsubscribeList = [];
}

function subscribeStores(): void {
    const unsub1 = useCanvasStore.subscribe((state) => {
        if (!state.hydrated) return;
        const json = JSON.stringify(state.projects);
        if (json === lastProjectsJson) return; // 无实际变化
        lastProjectsJson = json;
        markDirty();
    });
    unsubscribeList.push(unsub1);

    const unsub2 = useAssetStore.subscribe((state) => {
        if (!state.hydrated) return;
        const json = JSON.stringify(state.assets);
        if (json === lastAssetsJson) return;
        lastAssetsJson = json;
        markDirty();
    });
    unsubscribeList.push(unsub2);
}

function markDirty(): void {
    if (isDirty) return;
    isDirty = true;
    scheduleSync();
}

function registerLifecycleHooks(): void {
    const onVisibilityChange = () => {
        if (document.visibilityState === "visible" && isDirty) {
            debouncedFlush(FLUSH_DEBOUNCE_MS);
        }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    unsubscribeList.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

    const onBeforeUnload = () => {
        if (isDirty) {
            try {
                const config = getSyncConfig();
                if (config) {
                    const base = config.url.trim().replace(/\/+$/, "");
                    navigator.sendBeacon(`${base}/api/storage/flush`, JSON.stringify({ dirty: true }));
                }
            } catch {
                // 数据已在 IndexedDB 中，静默失败
            }
        }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    unsubscribeList.push(() => window.removeEventListener("beforeunload", onBeforeUnload));
}

function scheduleSync(): void {
    if (syncTimer) clearTimeout(syncTimer);
    const config = getSyncConfig();
    const delay = computeDelay(config);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        void doSync();
    }, delay);
}

function debouncedFlush(delay: number): void {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        void doSync();
    }, delay);
}

async function syncOnStartup(): Promise<void> {
    const config = getSyncConfig();
    if (!config) return;

    // 启动即同步一次：本地为空时拉取全部，本地非空时按 updatedAt 拉取远端较新的画布、补齐缺失媒体
    await doSync();
}

async function doSync(): Promise<void> {
    if (isSyncing) {
        // 正在同步过程中又有新变更，标记在同步完成后重试
        isDirty = true;
        return;
    }
    isSyncing = true;
    isDirty = false;

    try {
        const config = getSyncConfig();
        if (!config) return;

        await syncCanvasDomain(config);
        await syncNonCanvasDomains(config);

        useConfigStore.getState().updateWebdavConfig("lastSyncedAt", new Date().toISOString());
        lastSyncAt = Date.now();
    } catch (error) {
        isDirty = true;
        console.warn("[cloud-sync] 同步失败:", error);
    } finally {
        isSyncing = false;
        // 如果在同步期间又有新变更被标记，立即重试
        if (isDirty) {
            scheduleSync();
        }
    }
}

function getSyncConfig(): WebdavSyncConfig | null {
    const { webdav } = useConfigStore.getState();
    if (!webdav.url.trim()) return null;
    return webdav;
}

function computeDelay(config: WebdavSyncConfig | null): number {
    if (!config || !config.autoSync) return DEFAULT_DEBOUNCE_MS;
    const interval = Math.max(config.syncInterval || DEFAULT_DEBOUNCE_MS, MIN_INTERVAL_MS);
    const elapsed = Date.now() - lastSyncAt;
    if (elapsed >= interval) return 0;
    return Math.max(interval - elapsed, 5000);
}