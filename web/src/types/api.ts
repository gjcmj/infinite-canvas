// ============================================================
// 云端存储 API 类型（前端驱动契约）
// 后端 /api/storage/* + /api/models + /v1/* 代理
// ============================================================

// ─── 通用 ─────────────────────────────────────────────────────

export type ApiError = {
    error: { code: string; message: string };
};

// ─── 2.1 连接测试 ────────────────────────────────────────────

/**
 * GET /api/storage/health 响应
 * 前端仅用于「测试连接」按钮，显示连接成功/失败消息
 *
 * 消费文件: cloud-storage.ts (line 110-111, body?.ok)
 */
export type StorageHealthResponse = {
    /** true → 服务正常 */
    ok: boolean;
    /** 当前用户标识，前端不处理，仅调试用 */
    user: string;
    usage: {
        /** 已用字节数 */
        used: number;
        /** 配额上限，-1 表示无限制 */
        quota: number;
    };
};

// ─── 2.2 下载文件 ────────────────────────────────────────────

export type StorageDownloadParams = {
    /** 相对用户存储根的路径，`/` 分隔，如 `canvas/files/image:V1StGXR8.png` */
    path: string;
};

/**
 * GET /api/storage/file?path= 响应
 *   200 → 二进制 body，Content-Type 为上传时保存的 MIME
 *   404 → 前端约定 404 ＝ null，不算错误
 *   须支持 Range 请求头（206 + Content-Range，视频播放依赖）
 *
 * 前端还用 HEAD 请求获取 ETag/Last-Modified 作缓存判断
 */

// ─── 2.3 上传文件 ────────────────────────────────────────────

export type StorageUploadParams = {
    path: string;
};

/**
 * PUT /api/storage/file?path= 响应
 *
 * 消费文件: cloud-storage.ts (line 93, mock 返回对象)
 */
export type StorageUploadResponse = {
    /** 上传的路径 */
    path: string;
    /** 文件字节数 */
    bytes: number;
    /** 文件版本标识，用于乐观锁 If-Match/ETag */
    etag: string;
};

// ─── 2.4 删除文件 ────────────────────────────────────────────

export type StorageDeleteParams = {
    path: string;
};

/** 响应: 200（已删除或不存在均返回 200） */

// ─── 2.5 批量上传 ────────────────────────────────────────────

/**
 * POST /api/storage/batch (multipart/form-data)
 * meta 字段中的每一项
 */
export type StorageBatchMetaItem = {
    /** 目标路径 */
    path: string;
    /** 对应 multipart part 名 */
    part: string;
};

export type StorageBatchResult = {
    path: string;
    bytes: number;
    status: "ok";
};

export type StorageBatchResponse = {
    results: StorageBatchResult[];
};

// ─── 2.6 列表/统计 ───────────────────────────────────────────

export type StorageListParams = {
    /** 前缀过滤，如 canvas/files/ */
    prefix?: string;
};

export type StorageFileItem = {
    path: string;
    bytes: number;
    etag?: string;
};

export type StorageListResponse = {
    files: StorageFileItem[];
};

// ─── 2.7 远端目录结构（前端约定）─────────────────────────────

/**
 * 画布索引文件 (`canvas/index.json`)
 *
 * 这是云端画布同步的核心文件，前端 sync 引擎按此索引决定：
 *   - 哪些本地画布需要上传（合并后写入）
 *   - 哪些远端画布需要下载（本地没有的）
 *   - 哪些项目已被删除（墓碑列表）
 *
 * 消费文件: cloud-app-sync.ts
 *   - 读取: readRemoteJson<CanvasIndex>(config, indexFilePath()) — line 72
 *   - 合并: mergeIndex(projects, deletedProjects, remoteIndex) — line 75
 *   - 写回: writeIndexWithRetry() 以乐观锁写入
 *   - 访问字段: .projects, .deleted, .app, .domain, .version
 *               .id, .title, .updatedAt, .deletedAt
 *
 * 注意: 修改此类型时务必同步修改 cloud-app-sync.ts 中的 mergeIndex() 写法
 */
export type CanvasIndex = {
    /** 固定值 "infinite-canvas"，标识格式 */
    app: "infinite-canvas";
    /** 固定值 "canvas"，标识域 */
    domain: "canvas";
    /** 固定值 1，版本号，未来格式升级时递增 */
    version: 1;
    /** 索引文件最后导出时间，ISO 8601 字符串 */
    exportedAt: string;
    /** 活跃项目列表，每个项目只存摘要信息，详细内容在 projects/{id}.json */
    projects: CanvasIndexProject[];
    /** 已删除项目墓碑列表，同步引擎据此在其他设备删除对应项目 */
    deleted: CanvasIndexDeleted[];
};

/** 画布索引中的项目摘要 */
export type CanvasIndexProject = {
    /** 画布项目 ID，对应 projects/{id}.json */
    id: string;
    /** 画布标题，用于下载列表展示 */
    title: string;
    /** 最后更新时间，ISO 8601，用于合并冲突判断（可选则赢） */
    updatedAt: string;
};

/** 画布索引中已删除项目记录 */
export type CanvasIndexDeleted = {
    /** 被删除的项目 ID */
    id: string;
    /** 删除时间，ISO 8601，墓碑无条件赢过本地未删除状态 */
    deletedAt: string;
};

// ─── 3.1 模型列表 ────────────────────────────────────────────

/**
 * GET /api/models 响应
 *
 * 消费文件: model-gateway.ts
 *   - fetchGatewayModels(): Promise<ModelItem[]> — line 19
 *   - 缓存到 localStorage，离线可用
 */
export type ModelCapability = "image" | "video" | "text" | "audio";

export type ModelItem = {
    /** 模型唯一标识，用于 /v1/* 请求的 model 字段 */
    id: string;
    /** 展示名称，前端下拉列表显示 */
    name: string;
    /** 能力类型，前端按此过滤到对应功能区的模型选择器 */
    capability: ModelCapability;
};

export type ModelsResponse = {
    models: ModelItem[];
};

// ─── 3.2 OpenAI 兼容代理 ─────────────────────────────────────

export type VideoTaskStatus = "pending" | "processing" | "completed" | "failed";

/**
 * 视频任务轮询响应（含服务端直存信息）
 *
 * 注意:
 *   - 当前 video.ts 直接解析上游厂商的原始响应（url/video_url/result_url 多字段）
 *   - 此类型是「服务端直存」增强方案的预留类型
 *   - 待启用直存后，前端会检查 storageKey/path/bytes 跳过下载-上传中转
 *
 * 消费文件: (当前未启用，video.ts 使用本地 VideoResponse 类型)
 */
export type VideoTaskResponse = {
    status: VideoTaskStatus;
    /** 任务失败时 */
    error?: { message?: string };
    /** 服务端直存(3.3): 后端已直存的 storageKey */
    storageKey?: string;
    /** 服务端直存(3.3): 云存储中的完整路径 */
    path?: string;
    /** 服务端直存(3.3): 文件字节数 */
    bytes?: number;
    /** 兼容: 已有的 url/result_url */
    url?: string;
    result_url?: string;
    video_url?: string;
    content?: { video_url?: string; url?: string } | null;
};

/**
 * 图片生成响应中的单个图片数据项
 *
 * 消费文件: image.ts 中的 parseImagePayload() — 读取 .b64_json / .url
 */
export type ImageDataItem = {
    /** base64 编码的图片数据 */
    b64_json?: string;
    /** 图片下载 URL */
    url?: string;
    [key: string]: unknown;
};

/**
 * 通用图片生成接口响应 (OpenAI /v1/images/generations 兼容格式)
 *
 * 注意: image.ts 有自己的本地 ImageApiResponse 类型 (line 75-80)，
 *       结构与此一致但更宽松（data 为 Array<Record<string, unknown>>）
 */
export type ImageGenerationResponse = {
    data?: Array<ImageDataItem>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

/**
 * OpenAI Responses API SSE 事件中的单条消息
 *
 * 消费文件: image.ts 中的 parseSseEvent() — line 468-483
 */
export type TextResponseStreamEvent = {
    type?: string;
    delta?: string;
    text?: string;
};