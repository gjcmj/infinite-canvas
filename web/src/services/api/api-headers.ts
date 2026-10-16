import { getAuthToken } from "@/stores/use-auth-store";
import type { AiConfig } from "@/stores/use-config-store";

/**
 * 构建 API 请求头。
 * - gateway 渠道（apiKey 为空）使用 auth store 的 token
 * - 普通渠道使用 config.apiKey
 */
export function aiHeaders(config: Pick<AiConfig, "baseUrl" | "apiKey">, contentType?: string): Record<string, string> {
    if (config.baseUrl && !config.apiKey) {
        const token = getAuthToken();
        if (token) {
            return {
                Authorization: `Bearer ${token}`,
                ...(contentType ? { "Content-Type": contentType } : {}),
            };
        }
    }
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}