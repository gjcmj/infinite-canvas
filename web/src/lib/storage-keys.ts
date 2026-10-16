// 媒体在节点数据里以 `image:xxx` 这类 storageKey 出现（字符串字段或 storageKey 属性），
// 同步、导出、GC 需要同一套识别规则，统一收敛到本文件，避免多份实现判断不一致。

const STORAGE_KEY_PATTERN = /^(image|video|audio|file|video-reference|audio-reference):/;

export function isStorageKey(value: string) {
    return STORAGE_KEY_PATTERN.test(value);
}

export function isImageStorageKey(value: string) {
    return value.startsWith("image:");
}

/** 递归收集 value 中出现的 storageKey，结果累积到传入的 Set（GC 等需要跨多次调用累积的场景使用） */
export function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (isStorageKey(value)) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && isStorageKey(value.storageKey)) keys.add(value.storageKey);
    Object.values(value).forEach((item) => collectStorageKeys(item, keys));
    return keys;
}

/** 数组版本，等价于 [...collectStorageKeys(value)] */
export function collectStorageKeyList(value: unknown) {
    return [...collectStorageKeys(value)];
}

/** 按前缀过滤，image-storage / file-storage 的 GC 只关心自己那一类存储 */
export function collectStorageKeysByPrefix(value: unknown, prefixes: string[]) {
    const keys = new Set<string>();
    collectStorageKeys(value, keys);
    const kept = new Set<string>();
    keys.forEach((key) => {
        if (prefixes.some((prefix) => key.startsWith(`${prefix}:`))) kept.add(key);
    });
    return kept;
}
