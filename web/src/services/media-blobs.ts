import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { isImageStorageKey } from "@/lib/storage-keys";

// 图片与视频/音频分属两个 IndexedDB store，同步链路按 storageKey 前缀统一读写，避免各处重复判断。

export function getStoredBlob(storageKey: string) {
    return isImageStorageKey(storageKey) ? getImageBlob(storageKey) : getMediaBlob(storageKey);
}

export function setStoredBlob(storageKey: string, blob: Blob) {
    return isImageStorageKey(storageKey) ? setImageBlob(storageKey, blob) : setMediaBlob(storageKey, blob);
}
