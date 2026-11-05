import fs from 'fs';
import { parse, parseExpression } from "@babel/parser";
import traverse from '@babel/traverse';
import { generate } from "@babel/generator";
import * as t from '@babel/types';
import { PluginTranslationV1Ast } from '~/types';
import { I18nSettings } from '../../settings/data';

// ====================================================================================================
//                                      Configuration (白名单配置)
// ====================================================================================================

/**
 * 严格白名单配置
 * 只有在以下上下文中出现的字符串才会被考虑提取
 */
import { AST_DEFAULT_CONFIG, AST_DEFAULT_RULES } from './config';
import { findLocalizationDictionaries } from './localization-dictionaries';

const LOCALIZATION_PROPERTY = 'LocalizationProperty';

export class AstTranslator {
    private settings: I18nSettings;
    private config: any;
    private contentRules: any;

    constructor(settings: I18nSettings) {
        this.settings = settings;
        this.initPatterns();
    }

    private initPatterns() {
        this.config = {
            assignments: this.settings?.astAssignments || AST_DEFAULT_CONFIG.assignments,
            functions: this.settings?.astFunctions || AST_DEFAULT_CONFIG.functions,
            keys: this.settings?.astKeys || AST_DEFAULT_CONFIG.keys,
        };

        this.contentRules = {
            REJECT_PATTERNS: (this.settings?.astRejectRe || []).length > 0
                ? this.settings!.astRejectRe.map((re: string) => new RegExp(re))
                : AST_DEFAULT_RULES.REJECT_PATTERNS,
            VALID_PATTERNS: (this.settings?.astValidRe || []).length > 0
                ? this.settings!.astValidRe.map((re: string) => new RegExp(re))
                : AST_DEFAULT_RULES.VALID_PATTERNS,
        };
    }

    // ====================================================================================================
    //                                      1. Public API
    // ====================================================================================================

    public loadFile(filePath: string, isModule: boolean = false) {
        try {
            return this.parseAst(fs.readFileSync(filePath, 'utf8'), isModule);
        } catch (e) {
            console.error(`Error loading file ${filePath}:`, e);
            return null;
        }
    }

    public loadCode(code: string, isModule: boolean = false) {
        return this.parseAst(code, isModule);
    }

    /**
     * 提取逻辑 (极度保守)
     * 1. 只从 settings 白名单上下文中提取
     * 2. 只提取通过 isValidText 校验的内容
     */
    public extract(ast: t.Node): PluginTranslationV1Ast[] {
        const results: PluginTranslationV1Ast[] = [];

        this.traverseWhitelist(ast, (type, name, valueNode) => {
            const source = this.extractSource(valueNode);
            // 双重校验：上下文白名单 (implicit) + 内容有效性 (explicit)
            if (source && this.isValidText(source)) {
                results.push({ type, name, source, target: source });
            }
        });

        return this.deduplicateResults(results);
    }

    /**
     * 翻译逻辑 (宽松匹配)
     * 支持严格匹配 (type:name:source) 和宽松匹配 (source only)
     */
    public translate(ast: t.Node, translations: PluginTranslationV1Ast[]): string {
        // 1. 构建查找表
        const strictMap = new Map<string, string>(); // type:name:source -> target
        const looseMap = new Map<string, string>();  // source -> target (fallback)
        const localization = translations.some((item) => item.type === LOCALIZATION_PROPERTY)
            ? this.getLocalizationProperties(ast) : new Map<t.StringLiteral | t.TemplateLiteral, string>();

        translations.forEach(item => {
            if (item.type && item.name) {
                strictMap.set(this.getFingerprint(item), item.target);
            }
            // 本地化查找键可能与英文值相同，字典译文不能参与源码范围的宽松替换。
            if (item.type !== LOCALIZATION_PROPERTY) looseMap.set(item.source, item.target);
        });

        // 2. 遍历所有字符串节点 (不限于白名单，以支持手动添加的条目)
        const replace = (type: string, name: string, valueNode: t.StringLiteral | t.TemplateLiteral) => {
            const source = this.extractSource(valueNode);
            if (!source) return;

            // 尝试匹配
            const localName = localization.get(valueNode);
            const localTarget = localName ? strictMap.get(this.getFingerprint({ type: LOCALIZATION_PROPERTY, name: localName, source })) : undefined;
            // 增量提取会与旧类型条目共存，未翻译的新条目不能盖过已有译文。
            let target = localTarget && localTarget !== source ? localTarget : undefined;
            if (target === undefined) target = strictMap.get(this.getFingerprint({ type, name, source }));
            if (!target) {
                target = looseMap.get(source);
            }

            if (target && target !== source) {
                this.replaceSource(valueNode, target);
            }
        };
        this.traverseAllStrings(ast, replace);

        // 3. 生成代码
        return generate(ast, {
            minified: true,
            comments: false,
            jsescOption: { minimal: true }
        }).code;
    }

    /**
     * 跟踪翻译项的使用情况
     * 模拟翻译过程，记录哪些翻译项在源码中找到了匹配点
     */
    public traceUsage(ast: t.Node, translations: PluginTranslationV1Ast[]): Set<string> {
        const hitFingerprints = new Set<string>();

        // 1. 构建查找表
        const strictMap = new Map<string, string>(); // fingerprint -> target
        const looseMap = new Map<string, string>();  // source -> target
        const localization = translations.some((item) => item.type === LOCALIZATION_PROPERTY)
            ? this.getLocalizationProperties(ast) : new Map<t.StringLiteral | t.TemplateLiteral, string>();

        translations.forEach(item => {
            if (item.type && item.name) {
                strictMap.set(this.getFingerprint(item), item.target);
            }
            if (item.type !== LOCALIZATION_PROPERTY) looseMap.set(item.source, item.target);
        });

        // 2. 遍历所有匹配项
        const record = (type: string, name: string, valueNode: t.StringLiteral | t.TemplateLiteral) => {
            const source = this.extractSource(valueNode);
            if (!source) return;

            const localName = localization.get(valueNode);
            const localFingerprint = localName ? this.getFingerprint({ type: LOCALIZATION_PROPERTY, name: localName, source }) : '';
            const localTarget = strictMap.get(localFingerprint);
            const fingerprint = this.getFingerprint({ type, name, source });
            if (localTarget && localTarget !== source) {
                hitFingerprints.add(localFingerprint);
            } else if (strictMap.has(fingerprint)) {
                hitFingerprints.add(fingerprint);
            } else if (looseMap.has(source)) {
                // 如果严格匹配失败但宽松匹配成功，记录下宽松匹配的标示
                hitFingerprints.add(source);
            } else if (localFingerprint && strictMap.has(localFingerprint)) {
                hitFingerprints.add(localFingerprint);
            }
        };
        this.traverseAllStrings(ast, record);

        return hitFingerprints;
    }


    /**
     * 验证目标内容的安全性 (精准版)
     * @param target 目标翻译字符串
     * @returns { severity: string, message: string }[]
     */
    public validateSecurity(target: string): { severity: 'critical' | 'warning', message: string }[] {
        const issues: { severity: 'critical' | 'warning', message: string }[] = [];
        if (!target) return issues;

        // 1. 致命威胁检测 (注入 & 执行)
        // 使用 \b 确保是完整的单词，避免误报 "Fetch data"
        const criticalPatterns = [
            { regex: /\beval\s*\(/i, name: 'eval()' },
            { regex: /\bFunction\s*\(/i, name: 'new Function()' },
            { regex: /\bsetTimeout\s*\(\s*['"`]/i, name: 'setTimeout(string)' },
            { regex: /\bsetInterval\s*\(\s*['"`]/i, name: 'setInterval(string)' },
            { regex: /<script/i, name: '<script>' },
            { regex: /\bjavascript:/i, name: 'javascript:' },
        ];

        for (const pattern of criticalPatterns) {
            if (pattern.regex.test(target)) {
                issues.push({
                    severity: 'critical',
                    message: `发现危险的执行指令: ${pattern.name}`
                });
            }
        }

        // 2. 可疑行为检测 (网络 & 敏感环境)
        const warningPatterns = [
            { regex: /\bfetch\s*\(/i, name: 'fetch()' },
            { regex: /\bXMLHttpRequest\b/i, name: 'XMLHttpRequest' },
            { regex: /\bWebSocket\b/i, name: 'WebSocket' },
            { regex: /\brequire\s*\(/i, name: 'require()' },
            { regex: /\bprocess\./i, name: 'Node.js process' },
            { regex: /\belectron\./i, name: 'Electron API' },
            { regex: /\blocalStorage\b/i, name: 'localStorage' },
            { regex: /\bdocument\.cookie\b/i, name: 'document.cookie' },
        ];

        for (const pattern of warningPatterns) {
            if (pattern.regex.test(target)) {
                issues.push({
                    severity: 'warning',
                    message: `发现可疑的代码模式: ${pattern.name}`
                });
            }
        }

        // 3. 模板字面量深度审计 (检查 ${...} 中是否包含代码逻辑)
        if (target.includes('${')) {
            try {
                const safeTarget = target.replace(/`/g, '\\`');
                const expr = parseExpression('`' + safeTarget + '`');
                if (t.isTemplateLiteral(expr)) {
                    for (const expression of expr.expressions) {
                        // 如果表达式不是简单的 Identifier 或 MemberExpression，则视为风险
                        if (!t.isIdentifier(expression) && !t.isMemberExpression(expression)) {
                            issues.push({
                                severity: 'warning',
                                message: `模板字符串包含复杂的执行逻辑: ${generate(expression).code}`
                            });
                        }
                    }
                }
            } catch (e) {
                // 如果解析失败，说明可能是畸形的语法，这通常在 validateTargetSyntax 中处理
            }
        }

        return issues;
    }

    /**
     * 验证目标翻译内容的语法合法性
     * @param target 目标翻译字符串
     * @returns boolean 是否合法
     */
    public validateTargetSyntax(target: string): boolean {
        try {
            // 1. 基础字符串验证 (简单字符串直接通过)
            if (!target.includes('${') && !target.includes('`')) {
                return true;
            }

            // 2. 尝试作为模板字面量解析
            // 处理转义字符
            const safeTarget = target.replace(/`/g, '\\`');
            parseExpression('`' + safeTarget + '`', {
                plugins: ["typescript", "jsx", "classProperties", "objectRestSpread", "optionalChaining", "nullishCoalescingOperator", "decorators-legacy"]
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 克隆 AST 节点 (深拷贝)
     */
    public cloneAst(ast: t.Node): t.Node {
        return t.cloneNode(ast, true);
    }

    // ====================================================================================================
    //                                      2. Content Validation
    // ====================================================================================================

    /**
     * 判断文本内容是否是有效的 UI 文本
     * 策略：必须通过 REJECT 检查，且必须满足至少一个 VALID 特征
     */
    private isValidText(text: string): boolean {
        // 0. 基础长度
        if (text.length < 2) return false;

        // 1. 拒绝匹配任何 REJECT 模式
        if (this.contentRules.REJECT_PATTERNS.some((regex: RegExp) => regex.test(text))) {
            return false;
        }

        // 2. 如果满足 VALID 特征 (空格/中文/标点/首字母大写等)，直接允许
        if (this.contentRules.VALID_PATTERNS.some((regex: RegExp) => regex.test(text))) {
            return true;
        }

        // 3. 兜底策略：如果是纯英文单词 (不含特殊符号) 且超过一定长度，通常也是合法的 UI 文本
        if (/^[A-Za-z]{2,}$/.test(text)) {
            return true;
        }

        // 4. 默认拒绝 (对无特征且非纯单词的内容保持谨慎)
        return false;
    }

    // ====================================================================================================
    //                                      3. AST Traversal
    // ====================================================================================================

    private getLocalizationProperties(ast: t.Node): Map<t.StringLiteral | t.TemplateLiteral, string> {
        const properties = new Map<t.StringLiteral | t.TemplateLiteral, string>();
        for (const dictionary of findLocalizationDictionaries(ast, this.config.functions)) {
            for (const property of dictionary.properties) {
                if (!t.isObjectProperty(property) || !this.isStrNode(property.value)) continue;
                const name = this.getObjKeyName(property.key);
                if (name) properties.set(property.value, name);
            }
        }
        return properties;
    }

    /**
     * 白名单遍历器 (用于提取)
     * 只访问 settings 中明确列出的上下文
     */
    private traverseWhitelist(ast: t.Node, callback: (type: string, name: string, valueNode: t.StringLiteral | t.TemplateLiteral) => void) {
        const dictionaries = findLocalizationDictionaries(ast, this.config.functions);
        traverse(ast, {
            // 1. 变量声明 (const title = "...")
            VariableDeclarator: (path) => {
                const node = path.node;
                const name = t.isIdentifier(node.id) ? node.id.name : null;
                if (name && this.config.assignments.includes(name) && this.isStrNode(node.init)) {
                    callback('VariableDeclarator', name, node.init);
                }
            },
            // 2. 赋值表达式 (obj.title = "...")
            AssignmentExpression: (path) => {
                const node = path.node;
                const name = this.getAssignName(node.left);
                if (name && this.config.assignments.includes(name) && this.isStrNode(node.right)) {
                    callback('AssignmentExpression', name, node.right);
                }
            },
            // 3. 对象属性 ({ name: "..." })
            ObjectProperty: (path) => {
                const node = path.node;
                const name = this.getObjKeyName(node.key);
                if (name && this.isStrNode(node.value)) {
                    if (t.isObjectExpression(path.parent) && dictionaries.has(path.parent)) callback(LOCALIZATION_PROPERTY, name, node.value);
                    else if (this.config.keys.includes(name)) callback('ObjectProperty', name, node.value);
                }
            },
            // 4. 函数调用 (Notice("..."))
            CallExpression: (path) => {
                const node = path.node;
                const name = this.getCallName(node.callee);
                if (name && this.config.functions.includes(name)) {
                    node.arguments.forEach((arg, index) => {
                        // createEl 的首参是 HTML 标签名，只有后续内容选项才属于文案。
                        if (name === 'createEl' && index === 0) return;
                        if (this.isStrNode(arg)) {
                            callback('CallExpression', name, arg);
                        } else if (t.isObjectExpression(arg)) {
                            // 深度提取：提取白名单函数参数对象中的所有字符串值
                            arg.properties.forEach(prop => {
                                if (t.isObjectProperty(prop)) {
                                    const propName = this.getObjKeyName(prop.key) || 'prop';
                                    if (this.isStrNode(prop.value)) {
                                        callback('ObjectProperty', propName, prop.value);
                                    }
                                }
                            });
                        }
                    });
                }
            },
            // 5. 构造函数 (new Notice("..."))
            NewExpression: (path) => {
                const node = path.node;
                const name = this.getCallName(node.callee);
                if (name && this.config.functions.includes(name)) {
                    node.arguments.forEach(arg => {
                        if (this.isStrNode(arg)) {
                            callback('NewExpression', name, arg);
                        } else if (t.isObjectExpression(arg)) {
                            // 深度提取
                            arg.properties.forEach(prop => {
                                if (t.isObjectProperty(prop)) {
                                    const propName = this.getObjKeyName(prop.key) || 'prop';
                                    if (this.isStrNode(prop.value)) {
                                        callback('ObjectProperty', propName, prop.value);
                                    }
                                }
                            });
                        }
                    });
                }
            }
        });
    }

    /**
     * 全字符串遍历器 (用于翻译)
     * 遍历所有字符串节点，不受白名单限制
     */
    private traverseAllStrings(ast: t.Node, callback: (type: string, name: string, valueNode: t.StringLiteral | t.TemplateLiteral) => void) {
        traverse(ast, {
            VariableDeclarator: (path) => {
                const node = path.node;
                const name = t.isIdentifier(node.id) ? node.id.name : 'var';
                if (this.isStrNode(node.init)) {
                    callback('VariableDeclarator', name, node.init);
                }
            },
            AssignmentExpression: (path) => {
                const node = path.node;
                const name = this.getAssignName(node.left) || 'assign';
                if (this.isStrNode(node.right)) {
                    callback('AssignmentExpression', name, node.right);
                }
            },
            ObjectProperty: (path) => {
                const node = path.node;
                const name = this.getObjKeyName(node.key) || 'prop';
                if (this.isStrNode(node.value)) {
                    callback('ObjectProperty', name, node.value);
                }
            },
            CallExpression: (path) => {
                const node = path.node;
                const name = this.getCallName(node.callee) || 'func';
                node.arguments.forEach(arg => {
                    if (this.isStrNode(arg)) {
                        callback('CallExpression', name, arg);
                    }
                });
            },
            NewExpression: (path) => {
                const node = path.node;
                const name = this.getCallName(node.callee) || 'new';
                node.arguments.forEach(arg => {
                    if (this.isStrNode(arg)) {
                        callback('NewExpression', name, arg);
                    }
                });
            }
        });
    }

    // ====================================================================================================
    //                                      4. Helpers
    // ====================================================================================================

    private parseAst(code: string, isModule: boolean) {
        try {
            return parse(code, {
                sourceType: isModule ? 'module' : 'script',
                attachComment: false,
                plugins: [
                    "typescript", "jsx", "classProperties", "objectRestSpread",
                    "optionalChaining", "nullishCoalescingOperator", "decorators-legacy"
                ],
                errorRecovery: true
            });
        } catch (e) {
            console.warn("AST Parse Error:", (e as Error).message?.split('\n')[0]);
            return null;
        }
    }

    private isStrNode(node: any): node is t.StringLiteral | t.TemplateLiteral {
        return t.isStringLiteral(node) || t.isTemplateLiteral(node);
    }

    private extractSource(node: t.StringLiteral | t.TemplateLiteral): string {
        if (t.isStringLiteral(node)) return node.value;
        if (t.isTemplateLiteral(node)) {
            // 无插值的纯模板
            if (node.quasis.length === 1) return node.quasis[0].value.raw;
            // 含 ${} 插值的模板：把各插值表达式还原成源码文本，
            // 例如 `Auto ${s} interval (minutes)`，作为可翻译的原文
            let out = '';
            node.quasis.forEach((quasi, i) => {
                out += quasi.value.raw;
                if (i < node.expressions.length) {
                    out += '${' + generate(node.expressions[i] as t.Node, { minified: true }).code + '}';
                }
            });
            // 只有整体像自然语言句子时才收，否则会连日志、错误消息、数据格式串一起捞进表格
            return this.isTranslatableTemplate(out) ? out : '';
        }
        return "";
    }

    /**
     * 判断含插值的模板是否值得翻译
     * 去掉 ${...} 之后仍然是通顺的自然语言 → 视为界面文案；
     * 否则视为日志、错误消息或数据格式串，丢弃。
     */
    private isTranslatableTemplate(text: string): boolean {
        const stripped = text.replace(/\$\{[^}]*\}/g, ' ');
        if (/[{}<>=;|&\\]|=>|\bthis\.|\bvar\b|\bfunction\b|0x|\/\//.test(stripped)) return false;
        const words = stripped.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return false;
        const natural = words.filter(w => /^[A-Za-z][a-z'-]*[.,:?!]?$/.test(w) || /^[A-Z]/.test(w)).length;
        return natural / words.length > 0.6;
    }

    /** 取出模板字符串里各插值表达式的源码文本，用于替换前后的一致性校验 */
    private templateExpressions(node: t.StringLiteral | t.TemplateLiteral): string[] {
        if (!t.isTemplateLiteral(node)) return [];
        return node.expressions.map(e =>
            generate(e as t.Node, { minified: true }).code.replace(/\s+/g, '')
        );
    }

    private replaceSource(node: t.StringLiteral | t.TemplateLiteral, target: string) {
        if (!target.includes('${')) {
            if (t.isStringLiteral(node)) node.value = target;
            else {
                node.quasis = [t.templateElement({ raw: target, cooked: target }, true)];
                node.expressions = [];
            }
            return;
        }
        try {
            const safeTarget = target.replace(/`/g, '\\`');
            const ast = parseExpression('`' + safeTarget + '`');
            if (t.isTemplateLiteral(ast)) {
                // 安全校验：译文里的插值表达式必须与原文逐一对应。
                // 翻译时若改动、增删了 ${...}，直接放弃替换（保留英文），
                // 避免生成引用不存在变量的代码。
                const srcExpr = this.templateExpressions(node);
                const tgtExpr = ast.expressions.map(e =>
                    generate(e as t.Node, { minified: true }).code.replace(/\s+/g, '')
                );
                if (tgtExpr.length !== srcExpr.length || tgtExpr.some((e, i) => e !== srcExpr[i])) return;
                Object.assign(node, { type: 'TemplateLiteral', quasis: ast.quasis, expressions: ast.expressions });
            }
        } catch (e) { /* ignore */ }
    }

    private getAssignName(node: t.Node): string | null {
        if (t.isIdentifier(node)) return node.name;
        if (t.isMemberExpression(node)) {
            if (t.isIdentifier(node.property)) return node.property.name;
            if (t.isStringLiteral(node.property)) return node.property.value;
        }
        return null;
    }

    private getObjKeyName(key: t.Node): string | null {
        if (t.isIdentifier(key)) return key.name;
        if (t.isStringLiteral(key)) return key.value;
        return null;
    }

    private getCallName(node: t.Node): string | null {
        if (t.isIdentifier(node)) return node.name;
        if (t.isMemberExpression(node)) return this.getCallName(node.property);
        return null;
    }

    /**
     * 在 AST 中查找目标文本的位置
     * @param targetText 目标文本
     * @param ast AST 节点
     * @returns 匹配项列表
     */
    public findString(targetText: string, ast: t.Node): { line: number, column: number, type: string, name: string, source: string }[] {
        const matches: { line: number, column: number, type: string, name: string, source: string }[] = [];

        this.traverseAllStrings(ast, (type, name, valueNode) => {
            const source = this.extractSource(valueNode);
            if (source && source.includes(targetText)) {
                const loc = valueNode.loc?.start;
                matches.push({
                    line: loc?.line || 0,
                    column: loc?.column || 0,
                    type,
                    name,
                    source
                });
            }
        });

        return matches;
    }

    private getFingerprint(item: { type: string, name: string, source: string }) {
        return `${item.type}:${item.name}:${item.source}`;
    }

    private deduplicateResults(results: PluginTranslationV1Ast[]) {
        const map = new Map();
        results.forEach(r => map.set(this.getFingerprint(r), r));
        return Array.from(map.values()).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    }
}
