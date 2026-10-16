import { getAuthToken } from "@/stores/use-auth-store";
import { useConfigStore, type AiConfig, type ModelChannel, type ChannelModel } from "@/stores/use-config-store";
import type { ModelsResponse, ModelItem } from "@/types/api";

// ============================================================
// model-gateway.ts — 云端模型网关虚拟渠道
// ============================================================

const GATEWAY_CHANNEL_ID = "gateway";
const CACHE_KEY = "infinite-canvas:gateway_models";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

type CachedModels = {
    timestamp: number;
    models: ModelItem[];
};

/** 从网关拉取模型列表（GET /api/models） */
export async function fetchGatewayModels(): Promise<ModelItem[]> {
    const { config } = useConfigStore.getState();
    const baseUrl = gatewayBaseUrl();
    if (!baseUrl) throw new Error("网关地址未配置");

    const token = getAuthToken();
    const response = await fetch(`${baseUrl}/api/models`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!response.ok) {
        if (response.status === 401) throw new Error("认证失败，请检查 Token");
        throw new Error(`获取模型列表失败 (${response.status})`);
    }

    const data = (await response.json()) as ModelsResponse;
    const models = data.models || [];

    // 写入缓存
    try {
        localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ timestamp: Date.now(), models } satisfies CachedModels),
        );
    } catch {
        // 缓存失败不影响主流程
    }

    return models;
}

/** 从缓存读取模型列表（离线可用） */
export function getCachedGatewayModels(): ModelItem[] {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return [];
        const cached = JSON.parse(raw) as CachedModels;
        if (Date.now() - cached.timestamp > CACHE_TTL_MS) return [];
        return cached.models;
    } catch {
        return [];
    }
}

/** 确保 gateway 虚拟渠道存在于 channels 中 */
export function ensureGatewayChannel(): ModelChannel {
    const { config, updateConfig } = useConfigStore.getState();
    const existing = config.channels.find((c) => c.id === GATEWAY_CHANNEL_ID);
    if (existing) return existing;

    const cachedModels = getCachedGatewayModels();
    const gatewayChannel: ModelChannel = {
        id: GATEWAY_CHANNEL_ID,
        name: "云端模型",
        baseUrl: gatewayBaseUrl(),
        apiKey: "", // token 由 use-auth-store 管理，不存于此
        apiFormat: "openai",
        models: cachedModels.map((m) => ({ name: m.id, capability: m.capability })),
    };

    const newChannels = [gatewayChannel, ...config.channels];
    updateConfig("channels", newChannels);
    updateConfig("models", modelOptionsFromChannels(newChannels));

    return gatewayChannel;
}

/** 刷新网关渠道的模型列表 */
export async function refreshGatewayModels(): Promise<void> {
    const models = await fetchGatewayModels();
    const { config, updateConfig } = useConfigStore.getState();
    const channelModels: ChannelModel[] = models.map((m) => ({
        name: m.id,
        capability: m.capability,
    }));

    const channels = config.channels.map((c) =>
        c.id === GATEWAY_CHANNEL_ID ? { ...c, models: channelModels } : c,
    );

    updateConfig("channels", channels);
    updateConfig("models", modelOptionsFromChannels(channels));
}

/** 判断模型是否走网关渠道 */
export function isGatewayModel(modelValue: string): boolean {
    return modelValue.startsWith(`${GATEWAY_CHANNEL_ID}::`);
}

/** 获取网关基础 URL */
function gatewayBaseUrl(): string {
    const injected = (window as Record<string, unknown>).__APP_CONFIG__ as Record<string, string> | undefined;
    if (injected?.gatewayUrl) return injected.gatewayUrl;
    const envUrl = import.meta.env.VITE_GATEWAY_URL;
    if (envUrl) return envUrl;
    // fallback: 从用户配置的 webdav.url（Cloud Tab）读取
    const { webdav } = useConfigStore.getState();
    return webdav.url.trim() || "";
}

function modelOptionsFromChannels(channels: ModelChannel[]): string[] {
    const separator = "::";
    return Array.from(
        new Set(
            channels.flatMap((channel) =>
                channel.models.map((model) => `${channel.id}${separator}${model.name}`),
            ),
        ),
    );
}