import { pageRule } from '../utils';
import { DEFAULT_AST_PROMPT_TEMPLATE, DEFAULT_REGEX_PROMPT_TEMPLATE, DEFAULT_THEME_PROMPT_TEMPLATE } from '../ai/prompts';
import { LLM_PROVIDERS } from '../ai/constants';
import { AST_DEFAULT_CONFIG, REGEX_DEFAULT_CONFIG } from '../utils/translator/config';

export interface LLMProfile {
    id: string;
    name: string;
    url: string;
    key: string;
    model: string;
    useCustomPrice: boolean;
    priceInput: number;     // 人民币 / 每百万 Token
    priceOutput: number;    // 人民币 / 每百万 Token
}

export interface OpenAIProfile extends LLMProfile { }
export interface GeminiProfile extends LLMProfile { }

export interface GitHubProfile {
    id: string;
    name: string;
    token: string;
    repo: string;
}

export interface I18nSettings {
    // ==============================
    // 基础设置
    // ==============================
    agreement: boolean;        // 用户是否已同意协议
    language: string;          // 目标翻译语言类型
    checkUpdates: boolean;    // 是否自动检查插件更新
    searchText: string;       // 网络文件配置：搜索文本
    sort: string;              // 列表排序方式 (0: 正序, 1: 倒序)
    author: string;            // 默认作者署名
    mode: number;              // 插件运行模式 (待定/保留字段)

    // ==============================
    // 本地模式 (LDT)
    // ==============================
    automaticUpdate: boolean; // 是否在插件更新后自动应用旧版译文

    // ==============================
    // 语言模型翻译配置 (LLM)
    // ==============================
    llmApi: string;                 // 当前选中的 LLM 服务商 ('openai', 'gemini', 等)
    llmResponseFormat: string;      // LLM 返回格式 (text, json_object, json_schema)
    llmReasoningEffort: string;     // 推理强度 ('auto' | 'none' | 'low' | 'medium' | 'high')
    llmLanguage: string;            // LLM 翻译的目标语言
    llmStyle: string;               // LLM 翻译的风格类型
    llmBatchSize: number;           // LLM 批量翻译并行的文本条数
    llmConcurrencyLimit: number;    // LLM 并发请求限制数
    llmTimeout: number;             // LLM 请求超时时间 (毫秒)

    llmRegexPrompt?: string;        // LLM Regex 自定义提示词模板
    llmAstPrompt?: string;          // LLM AST 自定义提示词模板
    llmThemePrompt?: string;        // LLM Theme 自定义提示词模板

    // ==========================================
    // 方案管理与计费配置 (所有服务商)
    // ==========================================

    // OpenAI (ID: 1)
    llmOpenaiProfiles: OpenAIProfile[];
    llmOpenaiActiveProfileId: string;

    // Gemini (ID: 2)
    llmGeminiProfiles: GeminiProfile[];
    llmGeminiActiveProfileId: string;

    // Ollama (ID: 3)
    llmOllamaProfiles: LLMProfile[];
    llmOllamaActiveProfileId: string;

    // DeepSeek (ID: 4)
    llmDeepseekProfiles: LLMProfile[];
    llmDeepseekActiveProfileId: string;

    // 智谱 AI (ID: 5)
    llmZhipuProfiles: LLMProfile[];
    llmZhipuActiveProfileId: string;

    // 月之暗面 (ID: 6)
    llmMoonshotProfiles: LLMProfile[];
    llmMoonshotActiveProfileId: string;

    // 通义千问 (ID: 7)
    llmAliyunProfiles: LLMProfile[];
    llmAliyunActiveProfileId: string;

    // 百度千帆 (ID: 8)
    llmBaiduProfiles: LLMProfile[];
    llmBaiduActiveProfileId: string;

    // 字节跳动 (ID: 9)
    llmBytedanceProfiles: LLMProfile[];
    llmBytedanceActiveProfileId: string;

    // Groq (ID: 10)
    llmGroqProfiles: LLMProfile[];
    llmGroqActiveProfileId: string;

    // SiliconFlow (ID: 11)
    llmSiliconflowProfiles: LLMProfile[];
    llmSiliconflowActiveProfileId: string;

    // OpenRouter (ID: 12)
    llmOpenrouterProfiles: LLMProfile[];
    llmOpenrouterActiveProfileId: string;

    // DeepInfra (ID: 13)
    llmDeepinfraProfiles: LLMProfile[];
    llmDeepinfraActiveProfileId: string;

    // Mistral AI (ID: 14)
    llmMistralProfiles: LLMProfile[];
    llmMistralActiveProfileId: string;

    // MiniMax (ID: 15)
    llmMinimaxProfiles: LLMProfile[];
    llmMinimaxActiveProfileId: string;

    // StepFun (ID: 16)
    llmStepfunProfiles: LLMProfile[];
    llmStepfunActiveProfileId: string;

    llmUseCustomPrice: boolean;
    llmPriceInputCustom: number;
    llmPriceOutputCustom: number;

    // 为了向前兼容保留的单字段配置
    llmOpenaiUrl: string;
    llmOpenaiKey: string;
    llmOpenaiModel: string;
    llmGeminiKey: string;
    llmGeminiModel: string;
    llmOllamaUrl: string;
    llmOllamaModel: string;
    llmDeepseekKey: string;
    llmDeepseekModel: string;
    llmZhipuKey: string;
    llmZhipuModel: string;
    llmMoonshotKey: string;
    llmMoonshotModel: string;
    llmAliyunKey: string;
    llmAliyunModel: string;
    llmBaiduKey: string;
    llmBaiduModel: string;
    llmBytedanceKey: string;
    llmBytedanceModel: string;
    llmGroqKey: string;
    llmGroqModel: string;

    // SiliconFlow 专属配置
    llmSiliconflowKey: string;
    llmSiliconflowModel: string;

    // OpenRouter 专属配置
    llmOpenrouterKey: string;
    llmOpenrouterModel: string;

    // DeepInfra 专属配置
    llmDeepinfraKey: string;
    llmDeepinfraModel: string;

    // Mistral AI 专属配置
    llmMistralKey: string;
    llmMistralModel: string;

    // MiniMax 专属配置
    llmMinimaxKey: string;
    llmMinimaxModel: string;

    // StepFun 专属配置
    llmStepfunKey: string;
    llmStepfunModel: string;

    // ==============================
    // 沉浸式翻译配置 (IMT)
    // ==============================
    modeImt: boolean;         // 是否启用沉浸式翻译
    imtBallPosition: number | null; // 悬浮球在可移动高度中的相对位置，null 使用默认位置
    imtPagerule: pageRule;    // 沉浸式翻译页面的匹配规则

    // ==============================
    // 共建云端翻译 (Share)
    // ==============================
    shareToken: string;       // 用户提交翻译用的 Gitee Token
    shareRepo: string;        // 用户的个人翻译 Gitee 仓库名
    shareProfiles: GitHubProfile[]; // 多账号切换方案
    shareActiveProfileId: string;   // 当前激活的账号方案 ID

    // ==============================
    // 正则提取匹配规则
    // ==============================
    reFlags: string;          // 正则表达式的匹配修饰符 (默认: gs)
    reLength: number;         // 提取文本的最大长度限制
    reDatas: string[];        // 核心源码中用于捕获文本的正式正则表达式列表
    reRejectRe: string[];    // 正则提取排除正则
    reValidRe: string[];     // 正则提取有效正则

    // ==============================
    // AST 提取规则
    // ==============================
    astAssignments: string[]; // 赋值白名单
    astFunctions: string[];   // 函数白名单
    astKeys: string[];        // 键名白名单
    astRejectRe: string[];   // 排除正则 (字符串形式)
    astValidRe: string[];    // 有效正则 (字符串形式)

    // ==============================
    // 网络配置
    // ==============================
    githubProxyUrl: string;

    // ==============================
    // 资源仓库列表
    // ==============================
    cloudRepos: string[];     // 云端默认加载的插件资源列表仓库
    defaultCloudRepo: string; // 用户指定的默认云仓库地址

    // ==============================
    // 管理器状态持久化
    // ==============================
    managerTab: string;       // 管理器当前选中的 Tab (plugins/themes)
    pluginViewMode: 'list' | 'grid'; // 插件管理器视图模式
    themeViewMode: 'list' | 'grid'; // 主题管理器视图模式
    autoSave: boolean;        // 编辑器是否开启自动保存

    // ==============================
    // 自动化设置 (AutoManager)
    // ==============================
    autoDiscovery: boolean;     // [自动化] 是否启用后台探测与通知
    autoMatchStrategy: 'comprehensive' | 'version_first' | 'popularity' | 'latest_update'; // [自动化] 匹配策略
    autoApply: boolean;         // [自动化] 是否静默应用文件
    autoCheckInterval: number;  // [自动化] 自动检查间隔 (单位：小时, 0 为关闭)
    autoTrustedRepos: string[]; // 受信任的自动翻译仓库列表
    autoExcludeList: string[]; // 自动化排除名单 (插件 ID)
    autoScanMode: 'incremental' | 'full'; // [自动化] 探测范围模式
    lastAutoCheckTime: number; // 上次自动检查的时间戳
}

export const DEFAULT_SETTINGS: I18nSettings = {
    // ==============================
    // 基础设置
    // ==============================
    agreement: true,           // 默认同意协议
    language: 'zh-cn',         // 默认翻译语言为简体中文
    checkUpdates: true,       // 默认开启检查更新
    searchText: '',           // 默认无搜索文本
    sort: '0',                 // 默认按正序排列
    author: '',                // 默认作者署名为空
    mode: 0,                   // 默认模式: 0

    // ==============================
    // 本地模式 (LDT)
    // ==============================
    automaticUpdate: false,   // 默认关闭自动更新译文

    // ==============================
    // 语言模型翻译配置 (LLM)
    // ==============================
    llmApi: 'openai',               // 默认使用第一类 API 配置 (OpenAI)
    llmResponseFormat: 'text',      // 默认使用 text 的通用容错返回格式
    // 默认关闭推理链。新版模型（deepseek-v4 系列、o 系列等）默认会先输出一大段
    // 思维链，翻译任务并不需要它：实测 40 条批量，开启推理 9.1s / 2448 输出 token，
    // 关闭后 1.8s / 452 token，译文质量一致。且低 max_tokens 时思维链会把额度耗尽，
    // 导致 content 为空、解析失败。发送该参数若被服务商拒绝，插件会自动回退重试。
    llmReasoningEffort: 'none',
    llmLanguage: '简体中文',        // LLM 的默认生成语言
    llmStyle: '无',                 // LLM 的默认生成风格
    llmBatchSize: 10,               // 默认最大批量并发为 10 条
    llmConcurrencyLimit: 3,         // 默认并发限制为 3
    llmTimeout: 60000,              // 默认超时为 60 秒


    llmRegexPrompt: DEFAULT_REGEX_PROMPT_TEMPLATE,             // 默认加载内置的 Regex Prompt
    llmAstPrompt: DEFAULT_AST_PROMPT_TEMPLATE,               // 默认加载内置的 AST Prompt
    llmThemePrompt: DEFAULT_THEME_PROMPT_TEMPLATE,           // 默认加载内置的 Theme Prompt

    // OpenAI 专属配置
    llmOpenaiUrl: '',
    llmOpenaiKey: '',
    llmOpenaiModel: LLM_PROVIDERS['openai'].defaultModel,
    llmOpenaiProfiles: [{
        id: 'default',
        name: 'Default',
        url: '',
        key: '',
        model: LLM_PROVIDERS['openai'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmOpenaiActiveProfileId: 'default',
    llmUseCustomPrice: true,
    llmPriceInputCustom: 0,
    llmPriceOutputCustom: 0,

    // Gemini 专属配置
    llmGeminiKey: '',
    llmGeminiModel: LLM_PROVIDERS['gemini'].defaultModel,
    llmGeminiProfiles: [{
        id: 'default',
        name: 'Default',
        url: '',
        key: '',
        model: LLM_PROVIDERS['gemini'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmGeminiActiveProfileId: 'default',

    // Ollama 专属配置
    llmOllamaUrl: 'http://localhost:11434',
    llmOllamaModel: '',
    llmOllamaProfiles: [{
        id: 'default',
        name: 'Default',
        url: 'http://localhost:11434',
        key: '',
        model: '',
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmOllamaActiveProfileId: 'default',

    // DeepSeek 专属配置
    llmDeepseekKey: '',
    llmDeepseekModel: LLM_PROVIDERS['deepseek'].defaultModel,
    llmDeepseekProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['deepseek'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['deepseek'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmDeepseekActiveProfileId: 'default',

    // 智谱 AI 专属配置
    llmZhipuKey: '',
    llmZhipuModel: LLM_PROVIDERS['zhipu'].defaultModel,
    llmZhipuProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['zhipu'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['zhipu'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmZhipuActiveProfileId: 'default',

    // 月之暗面 (Moonshot/Kimi) 专属配置
    llmMoonshotKey: '',
    llmMoonshotModel: LLM_PROVIDERS['moonshot'].defaultModel,
    llmMoonshotProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['moonshot'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['moonshot'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmMoonshotActiveProfileId: 'default',

    // 通义千问 (Aliyun DashScope) 专属配置
    llmAliyunKey: '',
    llmAliyunModel: LLM_PROVIDERS['aliyun'].defaultModel,
    llmAliyunProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['aliyun'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['aliyun'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmAliyunActiveProfileId: 'default',

    // 百度千帆 (Baidu Qianfan) 专属配置
    llmBaiduKey: '',
    llmBaiduModel: LLM_PROVIDERS['baidu'].defaultModel,
    llmBaiduProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['baidu'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['baidu'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmBaiduActiveProfileId: 'default',

    // 字节跳动 (ByteDance Ark/Doubao) 专属配置
    llmBytedanceKey: '',
    llmBytedanceModel: LLM_PROVIDERS['bytedance'].defaultModel,
    llmBytedanceProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['bytedance'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['bytedance'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmBytedanceActiveProfileId: 'default',

    // Groq 专属配置
    llmGroqKey: '',
    llmGroqModel: LLM_PROVIDERS['groq'].defaultModel,
    llmGroqProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['groq'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['groq'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmGroqActiveProfileId: 'default',

    // SiliconFlow 专属配置
    llmSiliconflowKey: '',
    llmSiliconflowModel: LLM_PROVIDERS['siliconflow'].defaultModel,
    llmSiliconflowProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['siliconflow'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['siliconflow'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmSiliconflowActiveProfileId: 'default',

    // OpenRouter 专属配置
    llmOpenrouterKey: '',
    llmOpenrouterModel: LLM_PROVIDERS['openrouter'].defaultModel,
    llmOpenrouterProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['openrouter'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['openrouter'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmOpenrouterActiveProfileId: 'default',

    // DeepInfra 专属配置
    llmDeepinfraKey: '',
    llmDeepinfraModel: LLM_PROVIDERS['deepinfra'].defaultModel,
    llmDeepinfraProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['deepinfra'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['deepinfra'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmDeepinfraActiveProfileId: 'default',

    // Mistral AI 专属配置
    llmMistralKey: '',
    llmMistralModel: LLM_PROVIDERS['mistral'].defaultModel,
    llmMistralProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['mistral'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['mistral'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmMistralActiveProfileId: 'default',

    // MiniMax 专属配置
    llmMinimaxKey: '',
    llmMinimaxModel: LLM_PROVIDERS['minimax'].defaultModel,
    llmMinimaxProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['minimax'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['minimax'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmMinimaxActiveProfileId: 'default',

    // StepFun 专属配置
    llmStepfunKey: '',
    llmStepfunModel: LLM_PROVIDERS['stepfun'].defaultModel,
    llmStepfunProfiles: [{
        id: 'default',
        name: 'Default',
        url: LLM_PROVIDERS['stepfun'].baseUrl || '',
        key: '',
        model: LLM_PROVIDERS['stepfun'].defaultModel,
        useCustomPrice: false,
        priceInput: 0,
        priceOutput: 0
    }],
    llmStepfunActiveProfileId: 'default',

    // ==============================
    // 沉浸式翻译配置 (IMT)
    // ==============================
    modeImt: false,           // 默认关闭沉浸式
    imtBallPosition: null,
    imtPagerule: {
        selectors: [
            ".mod-settings",
            ".modal-container",
            ".menu",
            ".notice-container"
        ],
        excludeSelectors: [
            ".markdown-source-view",
            ".markdown-reading-view",
            ".cm-editor"
        ],
    },

    // ==============================
    // 共建云端翻译 (Share)
    // ==============================
    shareToken: '',           // 默认 Token 为空
    shareRepo: '',            // 默认 Repo 为空
    shareProfiles: [],
    shareActiveProfileId: '',

    // ==============================
    // 正则匹配
    // ==============================
    reFlags: 'gs',            // 默认全局搜索+忽略多行等限制
    reLength: 300,            // 默认限制文本最长 300 字符
    reDatas: REGEX_DEFAULT_CONFIG.patterns,
    reRejectRe: REGEX_DEFAULT_CONFIG.rejectPatterns,
    reValidRe: REGEX_DEFAULT_CONFIG.validPatterns,

    // ==============================
    // AST 提取规则
    // ==============================
    astAssignments: AST_DEFAULT_CONFIG.assignments,
    astFunctions: AST_DEFAULT_CONFIG.functions,
    astKeys: AST_DEFAULT_CONFIG.keys,
    astRejectRe: REGEX_DEFAULT_CONFIG.rejectPatterns, // Regex defaults are used as strings for UI
    astValidRe: REGEX_DEFAULT_CONFIG.validPatterns,

    // ==============================
    // 网络配置
    // ==============================
    // 默认直连。原默认值 https://ghp.ci/ 的公共实例已停止服务（连接直接失败），
    // 而直连 raw.githubusercontent.com 在多数网络下可用；需要加速时由用户在
    // 「综合设置 → 加速节点」中自行切换。
    githubProxyUrl: '',

    cloudRepos: [],
    defaultCloudRepo: '',

    // ==============================
    // 管理器状态持久化
    // ==============================
    managerTab: 'plugins',
    pluginViewMode: 'list',
    themeViewMode: 'grid',
    autoSave: true,

    // ==============================
    // 自动化设置 (AutoManager)
    // ==============================
    autoDiscovery: false,       // 默认开启后台自动探测与通知
    autoMatchStrategy: 'comprehensive',
    autoApply: false,          // 安全起见，默认关闭自动应用
    autoCheckInterval: 24,     // 默认 24 小时检查一次
    autoTrustedRepos: [],      // 默认受信任源为空列表
    autoExcludeList: [],       // 默认排除名单为空
    autoScanMode: 'incremental',
    lastAutoCheckTime: 0,
}
