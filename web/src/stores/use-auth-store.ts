import { create } from "zustand";

export type AuthStore = {
    token: string;
    setToken: (token: string) => void;
};

/** 从运行期注入或 localStorage 读取 token */
function readInitialToken(): string {
    const injected = (window as Record<string, unknown>).__APP_CONFIG__ as Record<string, string> | undefined;
    if (injected?.authToken) return injected.authToken;
    const envToken = import.meta.env.VITE_AUTH_TOKEN as string | undefined;
    if (envToken) return envToken;
    return localStorage.getItem("infinite-canvas:auth_token") || "";
}

export const useAuthStore = create<AuthStore>((set) => ({
    token: readInitialToken(),
    setToken: (token: string) => {
        localStorage.setItem("infinite-canvas:auth_token", token);
        set({ token });
    },
}));

/** 供 cloud-storage / api 层读取当前 token 的快捷函数 */
export function getAuthToken(): string {
    return useAuthStore.getState().token;
}