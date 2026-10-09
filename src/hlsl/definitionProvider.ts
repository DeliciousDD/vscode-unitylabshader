import { DefinitionProvider, ImplementationProvider, TypeDefinitionProvider, SymbolInformation, TextDocument, Position, Location, CancellationToken, Definition, workspace, commands, Uri, Range, window } from 'vscode';
import { CachedSymbolKind } from '../cache/symbolCacheTypes';
import { join } from 'path';
import * as fs from 'fs';
import { getRgPath } from '../common';
import { EngineContextManager, EngineType } from '../common/engineContext';
import { SymbolCacheManager, CachedSymbol } from '../cache';
import { RipgrepUtils, SymbolLookupUtils } from '../utils/CommonUtils';
import { isInCommentOrString } from '../utils/documentRegions';
import { maskCommentsPreserveLayout } from '../utils/commentMask';
import { WorkspaceIgnore } from '../utils/WorkspaceIgnore';

// 缓存条目接口
interface CacheEntry {
    results: Location[];
    timestamp: number;
}

// 调用点参数信息
interface CallArgument {
    text: string;
    type: string | null;
}

// 函数参数信息
interface FunctionParam {
    type: string;
    name: string;
    modifiers: string[];
}

export default class HLSLDefinitionProvider implements DefinitionProvider, ImplementationProvider, TypeDefinitionProvider {

	// 符号定义缓存（30秒有效期）
	private definitionCache: Map<string, CacheEntry> = new Map();
	private readonly CACHE_TTL = 30000; // 30秒
	
	// 文件变更监听
	private fileWatcher: any = null;
	
	// 符号缓存管理器
	private symbolCacheManager: SymbolCacheManager | null = null;
	
	constructor(symbolCacheManager?: SymbolCacheManager | null) {
		this.symbolCacheManager = symbolCacheManager || null;
	}

    /**
     * 判断是否为开发环境
     * 开发环境：通过 "Run Extension" 或 "Debug Extension" 启动
     * 生产环境：通过 VSIX 安装后运行
     */
    private isDevelopment(): boolean {
        return process.env.VSCODE_DEBUG_MODE === 'true' || 
               process.env.NODE_ENV === 'development';
    }
    
    /**
     * 初始化文件监听器（增量索引）
     */
    private initFileWatcher(): void {
        if (this.fileWatcher) {return;}
        
        const pattern = '**/*.{hlsl,hlsli,fx,fxh,vsh,psh,cginc,compute,shader,cg,usf,ush}';
        this.fileWatcher = workspace.createFileSystemWatcher(pattern);
        
        // 文件变更时清除相关缓存
        this.fileWatcher.onDidChange((uri: Uri) => {
            this.devLog(`[Cache] File changed: ${uri.fsPath}, clearing cache`);
            this.clearCache();
        });
        
        this.fileWatcher.onDidCreate((uri: Uri) => {
            this.devLog(`[Cache] File created: ${uri.fsPath}, clearing cache`);
            this.clearCache();
        });
        
        this.fileWatcher.onDidDelete((uri: Uri) => {
            this.devLog(`[Cache] File deleted: ${uri.fsPath}, clearing cache`);
            this.clearCache();
        });
        
        this.devLog(`[Cache] File watcher initialized`);
    }
    
    /**
     * 清除缓存
     */
    private clearCache(): void {
        this.definitionCache.clear();
        this.devLog(`[Cache] All cache cleared`);
    }
    


    /**
     * 开发环境日志输出
     */
    private devLog(message: string): void {
        if (this.isDevelopment()) {
            console.log(message);
        }
    }

    // 支持的文件扩展名
    private _hlslPattern = ['.hlsl', '.hlsli', '.fx', '.fxh', '.vsh', '.psh', '.cginc', '.compute', '.shader', '.cg', '.usf', '.ush'];

    /**
     * 搜索宏定义
     */
    private async searchMacroDefinitions(name: string, rootPath: string): Promise<Location[]> {
        this.devLog(`[Macro] Searching: "${name}"`);
        
        try {
            // 使用RipgrepUtils统一接口
            const matches = RipgrepUtils.searchMacroDefinitions(name, rootPath, this._hlslPattern);
            
            // 转换为Location并精确定位符号位置
            const results: Location[] = [];
            for (const match of matches) {
                const lineText = match.text;
                const macroNameMatch = new RegExp(`#define\\s+(${name})\\b`).exec(lineText);
                if (macroNameMatch) {
                    const startCol = lineText.indexOf(macroNameMatch[1]);
                    const endCol = startCol + name.length;
                    const range = new Range(
                        new Position(match.line, startCol),
                        new Position(match.line, endCol)
                    );
                    results.push(new Location(Uri.file(match.filePath), range));
                    this.devLog(`[Macro] ✓ Found: ${match.filePath}:${match.line + 1}`);
                }
            }
            
            if (results.length === 0) {
                this.devLog(`[Macro] ✗ Not found`);
            }
            
            return results;
        } catch (error: any) {
            this.devLog(`[Macro] Error: ${error.message}`);
            return [];
        }
    }

    /**
     * 搜索函数定义
     */
    private async searchFunctionDefinitions(name: string, rootPath: string): Promise<Location[]> {
        this.devLog(`[Function] Searching: "${name}"`);

        try {
            // 使用RipgrepUtils统一接口
            const matches = RipgrepUtils.searchFunctionDefinitions(name, rootPath, this._hlslPattern);
            
            // 转换为Location并精确定位符号位置
            const results: Location[] = [];
            for (const match of matches) {
                const lineText = match.text;
                const funcNameMatch = new RegExp(`\\b(${name})\\s*\\(`).exec(lineText);
                if (funcNameMatch) {
                    const startCol = lineText.indexOf(funcNameMatch[1]);
                    const endCol = startCol + name.length;
                    const range = new Range(
                        new Position(match.line, startCol),
                        new Position(match.line, endCol)
                    );
                    results.push(new Location(Uri.file(match.filePath), range));
                    this.devLog(`[Function] ✓ Found: ${match.filePath}:${match.line + 1}`);
                }
            }
            
            if (results.length === 0) {
                this.devLog(`[Function] ✗ Not found`);
            }
            
            return results;
        } catch (error: any) {
            this.devLog(`[Function] Error: ${error.message}`);
            return [];
        }
    }

    /**
     * 从调用点解析括号内的参数列表（处理嵌套括号和字符串）
     */
    private parseCallArgumentList(document: TextDocument, position: Position, funcName: string): CallArgument[] | null {
        const lineText = document.lineAt(position.line).text;
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {return null;}

        // 查找函数名后的左括号
        let searchStart = wordRange.end.character;
        while (searchStart < lineText.length && /\s/.test(lineText[searchStart])) {
            searchStart++;
        }
        if (searchStart >= lineText.length || lineText[searchStart] !== '(') {
            return null;
        }

        // 从左括号开始，找到匹配的右括号（跨行）
        const startOffset = document.offsetAt(new Position(position.line, searchStart));
        const fullText = document.getText();
        let depth = 0;
        let endOffset = -1;
        let inString = false;
        let stringChar = '';
        let inLineComment = false;
        let inBlockComment = false;

        for (let i = startOffset; i < fullText.length; i++) {
            const ch = fullText[i];
            const next = i + 1 < fullText.length ? fullText[i + 1] : '';

            if (inLineComment) {
                if (ch === '\n') {inLineComment = false;}
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && next === '/') {inBlockComment = false; i++;}
                continue;
            }
            if (inString) {
                if (ch === '\\') {i++; continue;}
                if (ch === stringChar) {inString = false;}
                continue;
            }
            if (ch === '/' && next === '/') {inLineComment = true; i++; continue;}
            if (ch === '/' && next === '*') {inBlockComment = true; i++; continue;}
            if (ch === '"' || ch === "'") {inString = true; stringChar = ch; continue;}
            if (ch === '(') {depth++; continue;}
            if (ch === ')') {
                depth--;
                if (depth === 0) {endOffset = i; break;}
            }
        }

        if (endOffset === -1) {return null;}

        // 提取括号内的文本
        const innerText = fullText.substring(startOffset + 1, endOffset);
        const args = this.splitArgumentList(innerText);

        return args.map(argText => ({
            text: argText.trim(),
            type: this.inferExpressionType(argText.trim(), document, position)
        }));
    }

    /**
     * 按顶层逗号拆分参数列表（忽略嵌套括号内的逗号）
     */
    private splitArgumentList(text: string): string[] {
        const args: string[] = [];
        let depth = 0;
        let current = '';
        let inString = false;
        let stringChar = '';

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                current += ch;
                if (ch === '\\' && i + 1 < text.length) {
                    current += text[++i];
                    continue;
                }
                if (ch === stringChar) {inString = false;}
                continue;
            }
            if (ch === '"' || ch === "'") {
                inString = true; stringChar = ch; current += ch; continue;
            }
            if (ch === '(' || ch === '[' || ch === '{') {depth++; current += ch; continue;}
            if (ch === ')' || ch === ']' || ch === '}') {depth--; current += ch; continue;}
            if (ch === ',' && depth === 0) {
                args.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        if (current.trim()) {args.push(current);}
        return args;
    }

    /**
     * 简单推断表达式类型（基于字面量、构造函数、变量声明缓存）
     */
    private inferExpressionType(expr: string, document: TextDocument, position: Position): string | null {
        if (!expr) {return null;}
        const e = expr.trim();

        // 数字字面量
        if (/^-?\d+\.\d+f?$/.test(e)) {return 'float';}
        if (/^-?\d+f?$/.test(e)) {return 'int';}
        if (/^-?\d+(\.\d+)?[lf]$/.test(e)) {return 'double';}
        if (/^0x[0-9a-fA-F]+$/.test(e)) {return 'int';}

        // 向量/矩阵构造函数：float3(...), half4(...), float4x4(...)
        const ctorMatch = /^(float|half|double|fixed|int|uint|bool|min16float|min10float|min16int|min12int|min16uint)(\d+)?(x\d+)?\s*\(/.exec(e);
        if (ctorMatch) {
            const base = ctorMatch[1];
            const dim = ctorMatch[2] || '';
            const mat = ctorMatch[3] || '';
            return `${base}${dim}${mat}`;
        }

        // 宏常量（全大写）无法确定类型
        if (/^[A-Z_][A-Z0-9_]*$/.test(e) && e === e.toUpperCase() && e.length > 1) {
            return null;
        }

        // 尝试在当前文件中查找变量声明类型
        const varType = this.findVariableTypeInDocument(e, document, position);
        if (varType) {return varType;}

        return null;
    }

    /**
     * 在当前文档中查找变量的声明类型
     */
    private findVariableTypeInDocument(varName: string, document: TextDocument, position: Position): string | null {
        const text = maskCommentsPreserveLayout(document.getText());
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // 匹配类型 + 变量名 的声明：float3 pos; float4 col = ...;
        const declRegex = new RegExp(
            `\\b(?:inout|in|out|const|static|uniform|volatile|precise|row_major|column_major\\s+)*` +
            `((?:bool|int|uint|half|float|double|fixed|min16float|min10float|min16int|min12int|min16uint|sampler|samplerstate|samplercomparisonstate|texture\\d*d|rwtexture\\d*d|structuredbuffer|rwstructuredbuffer|byteaddressbuffer|rwbyteaddressbuffer)` +
            `(?:\\d+)?(?:x\\d+)?|[A-Z][A-Za-z0-9_]*)\\s+` +
            `(?:${escaped})\\b\\s*(?:\\[[^\\]]*\\]\\s*)*[=;,)\\[]`,
            'g'
        );

        const cursorOffset = document.offsetAt(position);
        let bestType: string | null = null;
        let bestOffset = -1;
        let m: RegExpExecArray | null;
        while ((m = declRegex.exec(text)) !== null) {
            if (m.index < cursorOffset && m.index > bestOffset) {
                bestOffset = m.index;
                bestType = m[1];
            }
        }
        return bestType;
    }

    /**
     * 从函数签名字符串中解析参数列表
     */
    private parseFunctionSignatureParams(signature: string): FunctionParam[] {
        const params: FunctionParam[] = [];
        const m = /\(([\s\S]*)\)/.exec(signature);
        if (!m) {return params;}

        const inner = m[1].trim();
        if (!inner || inner === 'void') {return params;}

        const argTexts = this.splitArgumentList(inner);
        for (const arg of argTexts) {
            let trimmed = arg.trim();
            if (!trimmed || trimmed === 'void') {continue;}

            // 去掉 HLSL 语义注解：float4 pos : POSITION
            const colonIdx = this.findTopLevelChar(trimmed, ':');
            if (colonIdx !== -1) {
                trimmed = trimmed.substring(0, colonIdx).trim();
            }

            const modifiers: string[] = [];
            let remaining = trimmed;
            const modPattern = /^(inout|in|out|const|static|uniform|volatile|precise|row_major|column_major)\s+/i;
            let modMatch: RegExpExecArray | null;
            while ((modMatch = modPattern.exec(remaining)) !== null) {
                modifiers.push(modMatch[1].toLowerCase());
                remaining = remaining.substring(modMatch[0].length).trim();
            }

            // 去掉默认值
            const eqIdx = this.findTopLevelChar(remaining, '=');
            if (eqIdx !== -1) {
                remaining = remaining.substring(0, eqIdx).trim();
            }

            // 匹配类型 + 名称 + 可选数组
            // 先提取数组后缀
            let arraySuffix = '';
            const arrMatch = /((?:\s*\[[^\]]*\])+)\s*$/.exec(remaining);
            if (arrMatch) {
                arraySuffix = arrMatch[1];
                remaining = remaining.substring(0, remaining.length - arrMatch[0].length).trim();
            }

            const paramMatch = /^(.+?)(?:\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(remaining);
            if (paramMatch) {
                let type = (paramMatch[1] || '').trim();
                const name = (paramMatch[2] || '').trim();
                if (arraySuffix) {type += arraySuffix.replace(/\s+/g, '');}
                if (type) {
                    params.push({ type: this.normalizeTypeName(type), name, modifiers });
                }
            }
        }
        return params;
    }

    /**
     * 查找字符串中顶层（不在括号/字符串内）的指定字符位置
     */
    private findTopLevelChar(text: string, ch: string): number {
        let depth = 0;
        let inString = false;
        let stringChar = '';
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inString) {
                if (c === '\\') {i++; continue;}
                if (c === stringChar) {inString = false;}
                continue;
            }
            if (c === '"' || c === "'") {inString = true; stringChar = c; continue;}
            if (c === '(' || c === '[' || c === '{') {depth++; continue;}
            if (c === ')' || c === ']' || c === '}') {depth--; continue;}
            if (depth === 0 && c === ch) {return i;}
        }
        return -1;
    }

    /**
     * 规范化类型名称（小写、去空格）
     */
    private normalizeTypeName(type: string): string {
        return type.replace(/\s+/g, '').toLowerCase();
    }

    /**
     * 检查源类型是否可隐式转换到目标类型（HLSL 简化规则）
     */
    private isTypeConvertible(source: string, target: string): boolean {
        if (source === target) {return true;}

        // 数值类型提升
        const numericHierarchy: Record<string, number> = {
            'bool': 0, 'int': 1, 'uint': 2, 'half': 3, 'float': 4, 'double': 5,
            'min10float': 3, 'min16float': 3, 'min12int': 1, 'min16int': 1, 'min16uint': 2
        };

        // 精确维度匹配的向量/矩阵
        const vectorMatch = /^(float|half|double|fixed|int|uint|bool|min16float|min10float|min16int|min12int|min16uint)(\d+)$/.exec(source);
        const targetVectorMatch = /^(float|half|double|fixed|int|uint|bool|min16float|min10float|min16int|min12int|min16uint)(\d+)$/.exec(target);

        if (vectorMatch && targetVectorMatch) {
            if (vectorMatch[2] === targetVectorMatch[2]) {
                const sRank = numericHierarchy[vectorMatch[1]] ?? -1;
                const tRank = numericHierarchy[targetVectorMatch[1]] ?? -1;
                if (sRank >= 0 && tRank >= 0 && sRank <= tRank) {return true;}
            }
            // 同基数不同维度：float4 -> float3 通常不允许，但构造函数可以
            // 这里保守处理，不允许隐式截断
            return false;
        }

        // 标量提升
        if (numericHierarchy[source] !== undefined && numericHierarchy[target] !== undefined) {
            return numericHierarchy[source] <= numericHierarchy[target];
        }

        // 标量到向量广播（float -> float3）
        if (targetVectorMatch && numericHierarchy[source] !== undefined) {
            const tRank = numericHierarchy[targetVectorMatch[1]] ?? -1;
            if (tRank >= 0 && numericHierarchy[source] <= tRank) {return true;}
        }

        return false;
    }

    /**
     * 对单个重载进行评分
     * 返回 { countMatch: boolean, typeScore: number }
     * typeScore: -1 类型不匹配, 0 无法判断, >0 类型匹配程度
     */
    private scoreOverloadMatch(callArgs: CallArgument[], defParams: FunctionParam[]): { countMatch: boolean; typeScore: number } {
        // 参数数量不匹配
        if (callArgs.length !== defParams.length) {
            return { countMatch: false, typeScore: -1 };
        }

        let typeScore = 0;
        let hasKnownType = false;
        for (let i = 0; i < callArgs.length; i++) {
            const arg = callArgs[i];
            const param = defParams[i];

            if (!arg.type) {
                continue;
            }
            hasKnownType = true;

            const argType = this.normalizeTypeName(arg.type);
            const paramType = this.normalizeTypeName(param.type);

            if (argType === paramType) {
                typeScore += 100;
            } else if (this.isTypeConvertible(argType, paramType)) {
                typeScore += 60;
            } else {
                return { countMatch: true, typeScore: -1 };
            }
        }

        // 无参数或类型全部未知时，数量匹配即可
        if (!hasKnownType) {
            return { countMatch: true, typeScore: 1 };
        }
        return { countMatch: true, typeScore };
    }

    /**
     * 从指定位置开始，在文本中查找函数名后匹配的括号对，返回括号内的文本
     */
    private extractFunctionParamsAtLine(content: string, lineIndex: number, funcName: string): string | null {
        const lines = content.split(/\r?\n/);
        if (lineIndex >= lines.length) {return null;}

        // 找到函数名在行中的位置
        const lineText = lines[lineIndex];
        const nameRegex = new RegExp(`\\b${funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const nameMatch = nameRegex.exec(lineText);
        if (!nameMatch) {return null;}

        // 将光标移到函数名之后，跨行查找左括号
        let charIdx = nameMatch.index + nameMatch[0].length;
        let currentLine = lineIndex;
        let foundOpenParen = false;

        while (currentLine < lines.length) {
            const text = lines[currentLine];
            while (charIdx < text.length) {
                const c = text[charIdx];
                if (c === '(') {
                    foundOpenParen = true;
                    break;
                }
                if (!/\s/.test(c)) {
                    // 函数名后不是空白也不是左括号，说明不是函数定义
                    return null;
                }
                charIdx++;
            }
            if (foundOpenParen) {break;}
            currentLine++;
            charIdx = 0;
        }

        if (!foundOpenParen) {return null;}

        // 从左括号开始，跨行找到匹配的右括号
        let depth = 0;
        let inString = false;
        let stringChar = '';
        let inLineComment = false;
        let inBlockComment = false;
        let paramStartLine = currentLine;
        let paramStartChar = charIdx + 1;
        let paramEndLine = -1;
        let paramEndChar = -1;

        for (let li = currentLine; li < lines.length; li++) {
            const text = lines[li];
            const startCh = (li === currentLine) ? charIdx : 0;
            for (let ci = startCh; ci < text.length; ci++) {
                const c = text[ci];
                const next = ci + 1 < text.length ? text[ci + 1] : '';

                if (inLineComment) {
                    continue;
                }
                if (inBlockComment) {
                    if (c === '*' && next === '/') {inBlockComment = false; ci++;}
                    continue;
                }
                if (inString) {
                    if (c === '\\') {ci++; continue;}
                    if (c === stringChar) {inString = false;}
                    continue;
                }
                if (c === '/' && next === '/') {inLineComment = true; continue;}
                if (c === '/' && next === '*') {inBlockComment = true; ci++; continue;}
                if (c === '"' || c === "'") {inString = true; stringChar = c; continue;}
                if (c === '(') {
                    depth++;
                    continue;
                }
                if (c === ')') {
                    depth--;
                    if (depth === 0) {
                        paramEndLine = li;
                        paramEndChar = ci;
                        break;
                    }
                }
            }
            if (paramEndLine !== -1) {break;}
            inLineComment = false;
        }

        if (paramEndLine === -1) {return null;}

        // 拼接参数文本
        const paramLines: string[] = [];
        for (let li = paramStartLine; li <= paramEndLine; li++) {
            const text = lines[li];
            if (li === paramStartLine && li === paramEndLine) {
                paramLines.push(text.substring(paramStartChar, paramEndChar));
            } else if (li === paramStartLine) {
                paramLines.push(text.substring(paramStartChar));
            } else if (li === paramEndLine) {
                paramLines.push(text.substring(0, paramEndChar));
            } else {
                paramLines.push(text);
            }
        }
        return paramLines.join('\n');
    }

    /**
     * 直接从定义文件读取并解析函数参数列表（支持跨行参数）
     * 返回按文件路径缓存的文件内容 Map
     */
    private resolveOverloadParams(
        locations: Location[],
        funcName: string
    ): Map<string, FunctionParam[] | null> {
        const result = new Map<string, FunctionParam[] | null>();
        const fileContentCache = new Map<string, string | null>();

        for (const loc of locations) {
            const filePath = loc.uri.fsPath;
            const line = loc.range.start.line;
            const key = `${filePath}:${line}`;

            if (result.has(key)) {continue;}

            let content = fileContentCache.get(filePath);
            if (content === undefined) {
                try {
                    content = fs.readFileSync(filePath, 'utf-8');
                } catch {
                    content = null;
                }
                fileContentCache.set(filePath, content);
            }

            if (content === null) {
                result.set(key, null);
                continue;
            }

            const paramsText = this.extractFunctionParamsAtLine(content, line, funcName);
            if (paramsText === null) {
                result.set(key, null);
                continue;
            }

            // 构造一个虚拟签名来复用 parseFunctionSignatureParams
            const virtualSignature = `void ${funcName}(${paramsText})`;
            const params = this.parseFunctionSignatureParams(virtualSignature);
            result.set(key, params);
        }

        return result;
    }

    /**
     * 根据调用点参数过滤和排序函数重载
     * 直接读取定义文件解析完整签名，不依赖符号缓存（支持跨行参数和工作区外的文件）
     */
    private filterFunctionOverloadsByCallSite(
        locations: Location[],
        callArgs: CallArgument[],
        funcName: string
    ): Location[] {
        if (!callArgs || locations.length <= 1) {return locations;}

        // 解析每个候选位置的函数参数列表
        const paramsByLocation = this.resolveOverloadParams(locations, funcName);

        interface ScoredOverload {
            location: Location;
            key: string;
            params: FunctionParam[] | null;
        }

        const scored: ScoredOverload[] = [];
        let resolvedCount = 0;

        for (const loc of locations) {
            const key = `${loc.uri.fsPath}:${loc.range.start.line}`;
            const params = paramsByLocation.get(key) ?? null;
            if (params !== null) {resolvedCount++;}
            scored.push({ location: loc, key, params });
        }

        // 如果没有任何一个位置能解析出参数，无法过滤，返回全部
        if (resolvedCount === 0) {
            this.devLog(`[Overload] Could not resolve any signature for ${funcName}, returning all ${locations.length} results`);
            return locations;
        }

        let bestTyped: Location[] = [];
        let bestTypeScore = -1;
        const countMatched: Location[] = [];
        const countMismatched: Location[] = [];
        const unresolved: Location[] = [];

        for (const s of scored) {
            if (s.params === null) {
                unresolved.push(s.location);
                continue;
            }

            const result = this.scoreOverloadMatch(callArgs, s.params);
            this.devLog(`[Overload] ${funcName} at ${s.location.uri.fsPath}:${s.location.range.start.line + 1}: params=[${s.params.map(p => p.type).join(', ')}], countMatch=${result.countMatch}, typeScore=${result.typeScore}`);

            if (!result.countMatch) {
                countMismatched.push(s.location);
                continue;
            }

            countMatched.push(s.location);
            if (result.typeScore > bestTypeScore) {
                bestTypeScore = result.typeScore;
                bestTyped = [s.location];
            } else if (result.typeScore === bestTypeScore && result.typeScore > 0) {
                bestTyped.push(s.location);
            }
        }

        // 有类型最佳匹配
        if (bestTyped.length > 0 && bestTypeScore > 0) {
            this.devLog(`[Overload] ✓ Found ${bestTyped.length} best type match(es) + ${unresolved.length} unresolved for ${funcName}(${(callArgs.map(a => a.type || '?')).join(', ')})`);
            return [...bestTyped, ...unresolved];
        }

        // 至少有一个参数数量匹配，过滤掉明确不匹配的
        if (countMatched.length > 0 && countMismatched.length > 0) {
            this.devLog(`[Overload] ✓ Filtered out ${countMismatched.length} mismatched overload(s), keeping ${countMatched.length + unresolved.length} for ${funcName} (${callArgs.length} args)`);
            return [...countMatched, ...unresolved];
        }

        // 没有明确的数量匹配（全部不匹配或全部未解析），保守返回全部
        this.devLog(`[Overload] No confident count match for ${funcName} (${callArgs.length} args), returning all ${locations.length} results`);
        return locations;
    }

    /**
     * 如果是函数调用，对结果应用重载过滤
     */
    private applyOverloadFiltering(locations: Location[], callArgs: CallArgument[] | null, name: string): Location[] {
        if (!callArgs || locations.length <= 1) {return locations;}
        return this.filterFunctionOverloadsByCallSite(locations, callArgs, name);
    }

    /**
     * 搜索结构体定义
     */
    private async searchStructDefinitions(name: string, rootPath: string): Promise<Location[]> {
        this.devLog(`[Struct] Searching: "${name}"`);
        
        try {
            // 使用RipgrepUtils统一接口
            const matches = RipgrepUtils.searchStructDefinitions(name, rootPath, this._hlslPattern);
            
            // 转换为Location并精确定位符号位置
            const results: Location[] = [];
            for (const match of matches) {
                const lineText = match.text;
                const structNameMatch = new RegExp(`(?:struct|cbuffer|tbuffer)\\s+(${name})\\b`).exec(lineText);
                if (structNameMatch) {
                    const startCol = lineText.indexOf(structNameMatch[1]);
                    const endCol = startCol + name.length;
                    const range = new Range(
                        new Position(match.line, startCol),
                        new Position(match.line, endCol)
                    );
                    results.push(new Location(Uri.file(match.filePath), range));
                    this.devLog(`[Struct] ✓ Found: ${match.filePath}:${match.line + 1}`);
                }
            }
            
            if (results.length === 0) {
                this.devLog(`[Struct] ✗ Not found`);
            }
            
            return results;
        } catch (error: any) {
            this.devLog(`[Struct] Error: ${error.message}`);
            return [];
        }
    }

    /**
     * 按优先级排序结果：已打开的文件优先，然后按文件名排序
     */
    private sortLocationsByPriority(locations: Location[]): Location[] {
        const openedFiles = new Set(workspace.textDocuments.map(doc => doc.uri.fsPath));
        
        return locations.sort((a, b) => {
            const aIsOpen = openedFiles.has(a.uri.fsPath);
            const bIsOpen = openedFiles.has(b.uri.fsPath);
            
            // 已打开的文件优先
            if (aIsOpen && !bIsOpen) {return -1;}
            if (!aIsOpen && bIsOpen) {return 1;}
            
            // 都打开或都未打开，按文件名排序
            return a.uri.fsPath.localeCompare(b.uri.fsPath);
        });
    }

    /**
     * 在定义跳转结果出口统一过滤 .gitignore 命中的文件。
     * 兜底覆盖 VS Code WorkspaceSymbolProvider、旧缓存和后续新增搜索路径。
     */
    private filterIgnoredLocations(locations: Location[]): Location[] {
        return locations.filter(location => !this.isIgnoredLocation(location));
    }

    private isIgnoredLocation(location: Location): boolean {
        const workspaceFolder = workspace.getWorkspaceFolder(location.uri);
        const rootPath = workspaceFolder?.uri.fsPath || workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) {
            return false;
        }

        return WorkspaceIgnore.isIgnored(rootPath, location.uri.fsPath);
    }

    /**
     * 根据上下文推测符号类型
     */
    private guessSymbolType(document: TextDocument, position: Position): 'function' | 'macro' | 'both' | 'type' | 'unknown' {
        try {
            const line = document.lineAt(position.line).text;
            const wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) {return 'unknown';}
            
            const word = document.getText(wordRange);
            const charAfter = line.charAt(wordRange.end.character);
            
            // 函数调用：后面有括号
            if (charAfter === '(' || line.substring(wordRange.end.character).trim().startsWith('(')) {
                // 检查是否是全大写（可能是宏函数）
                if (word === word.toUpperCase() && word.length > 2) {
                    this.devLog(`[Guess] Macro-function detected: ${word}`);
                    return 'both'; // 既可能是宏，也可能是函数
                }
                return 'function';
            }
            
            // 判断是否在宏定义行上
            if (line.includes('#define')) {
                // 获取宏定义行的完整单词序列
                const lineTokens = line.trim().split(/\s+/);
                const defineIndex = lineTokens.findIndex(token => token === '#define');
                
                if (defineIndex !== -1) {
                    // 宏名是#define后面的第一个单词
                    const macroNameIndex = defineIndex + 1;
                    
                    // 判断当前单词是否是宏名
                    const wordStartInLine = wordRange.start.character;
                    const lineBeforeWord = line.substring(0, wordStartInLine);
                    const tokensBeforeWord = lineBeforeWord.trim().split(/\s+/);
                    
                    // 如果当前单词前面有一个#define，并且当前单词是#define后面的第一个单词，那么它是宏名
                    if (tokensBeforeWord.includes('#define') && tokensBeforeWord.filter(t => t !== '#define').length === 0) {
                        // 当前单词是宏名
                        return 'macro';
                    } else {
                        // 当前单词是宏值，可能是函数名、常量、数字等
                        // 为了更准确，返回'unknown'让系统搜索所有可能类型
                        return 'unknown';
                    }
                }
            }
            
            // 非宏定义行，检查是否是全大写（可能是单独的宏）
            if (word === word.toUpperCase()) {
                return 'macro';
            }
            
            // 类型声明：前面有类型关键字
            const beforeWord = line.substring(0, wordRange.start.character).trim();
            if (/\b(struct|class|typedef|uniform|varying|attribute|cbuffer|tbuffer)\s*$/.test(beforeWord)) {
                return 'type';
            }
            
            // 变量声明：前面是类型名（首字母大写）
            const tokens = beforeWord.split(/\s+/);
            const lastToken = tokens[tokens.length - 1];
            if (lastToken && /^[A-Z]/.test(lastToken)) {
                return 'type';
            }
            
            // 默认推测为函数（最常见）
            return 'function';
        } catch (error) {
            return 'unknown';
        }
    }
    
	/**
	 * 搜索符号（不使用缓存）
	 */
	private async searchSymbolWithoutCache(name: string): Promise<Location[]> {
		const results: Location[] = [];
		
		if (workspace.workspaceFolders) {
			for (const folder of workspace.workspaceFolders) {
				const rootPath = folder.uri.fsPath;
				
				// 并行搜索所有类型
				const [macroResults, funcResults, structResults] = await Promise.all([
					this.searchMacroDefinitions(name, rootPath),
					this.searchFunctionDefinitions(name, rootPath),
					this.searchStructDefinitions(name, rootPath)
				]);
				
				results.push(...macroResults, ...funcResults, ...structResults);
				
				if (results.length > 0) {
					break;
				}
			}
		}
		
		return results;
	}
	
	/**
	 * 从持久化缓存中查找符号
	 */
	private searchSymbolFromPersistentCache(name: string): Location[] {
		if (!this.symbolCacheManager) {
			return [];
		}
		
		const symbols = this.symbolCacheManager.findSymbol(name);
		if (symbols.length === 0) {
			return [];
		}
		
		this.devLog(`[PersistentCache] Found ${symbols.length} symbols for "${name}"`);
		
		// 转换为 Location 对象
		const results: Location[] = [];
		for (const symbol of symbols) {
			try {
				const uri = Uri.file(this.getAbsolutePath(symbol.filePath));
				const range = new Range(
					new Position(symbol.line, symbol.column),
					new Position(symbol.line, symbol.column + symbol.name.length)
				);
				results.push(new Location(uri, range));
			} catch (error) {
				this.devLog(`[PersistentCache] Error converting symbol: ${error}`);
			}
		}
		
		return results;
	}
	
	/**
	 * 获取绝对路径
	 */
	private getAbsolutePath(relativePath: string): string {
		if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
			const path = require('path');
			return path.join(workspace.workspaceFolders[0].uri.fsPath, relativePath);
		}
		return relativePath;
	}

    public getDefinitionLocations(document: TextDocument, position: Position): Thenable<Location[]> {

        return new Promise<Location[]>(async (resolve, reject) => {
            const startTime = Date.now();
            this.devLog(`[Performance] ========== Definition Search Started ==========`);

            let enable = workspace.getConfiguration('unityshader').get<boolean>('suggest.basic', true);
            if (!enable) {
                reject();
                return;
            }

            // 注释/字符串中不提供跳转定义
            if (isInCommentOrString(document, position)) {
                reject();
                return;
            }

            let wordRange = document.getWordRangeAtPosition(position);
            if (!wordRange) {
                reject();
                return;
            }

            let results: Location[] = [];
            let name = document.getText(wordRange);
            this.devLog(`[Search] Looking for: "${name}"`);

            // 解析函数调用点的参数列表（用于重载精确匹配）
            const callArgs = this.parseCallArgumentList(document, position, name);
            if (callArgs) {
                this.devLog(`[Overload] Call site has ${callArgs.length} argument(s): [${callArgs.map(a => a.type || a.text.substring(0, 20)).join(', ')}]`);
            }

            // 初始化文件监听器（首次调用时）
            if (!this.fileWatcher) {
                this.initFileWatcher();
            }
            
            // 策略0: 检查缓存
            const cacheKey = `${name}:${document.uri.fsPath}:${position.line}:${position.character}:${WorkspaceIgnore.isEnabled()}`;
            const cached = this.definitionCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
                const cachedResults = this.filterIgnoredLocations(cached.results);
                this.devLog(`[Cache] ✓ Hit! Returning ${cachedResults.length} cached results (age: ${Date.now() - cached.timestamp}ms)`);
                this.devLog(`[Performance] ========== Total time: ${Date.now() - startTime}ms (cached), Found: ${cachedResults.length} ==========`);
                resolve(cachedResults);
                return;
            }

            // 优先：当前文件内的局部变量定义（避免同名变量导致返回大量跨文件结果）
            const localVarLocation = this.tryFindLocalVariableDefinition(document, position, wordRange, name);
            if (localVarLocation) {
                const localResults = [localVarLocation];
                this.definitionCache.set(cacheKey, {
                    results: localResults,
                    timestamp: Date.now()
                });
                this.devLog(`[Local] ✓ Found local definition (param/var) for "${name}"`);
                this.devLog(`[Performance] ========== Total time: ${Date.now() - startTime}ms (local), Found: ${localResults.length} ==========`);
                resolve(localResults);
                return;
            }

            // 优先：结构体成员访问时，跳转到结构体类型定义（例如 IN.basecolor -> UnityMetaInput）
            const memberTypeLocations = await this.tryFindStructMemberTypeDefinitions(document, position, wordRange);
            if (memberTypeLocations && memberTypeLocations.length > 0) {
                const filteredMemberTypeLocations = this.filterIgnoredLocations(memberTypeLocations);
                if (filteredMemberTypeLocations.length > 0) {
                    this.definitionCache.set(cacheKey, {
                        results: filteredMemberTypeLocations,
                        timestamp: Date.now()
                    });
                    this.devLog(`[Type] ✓ Found member base type definition for "${name}"`);
                    this.devLog(`[Performance] ========== Total time: ${Date.now() - startTime}ms (type), Found: ${filteredMemberTypeLocations.length} ==========`);
                    resolve(filteredMemberTypeLocations);
                    return;
                }
            }
              
 			// 策略0.5: 检查持久化缓存
 			if (this.symbolCacheManager) {
 				const persistentStartTime = Date.now();
 				const persistentResults = this.searchSymbolFromPersistentCache(name);
				
				if (persistentResults.length > 0) {
					const filteredPersistentResults = this.filterIgnoredLocations(persistentResults);
					if (filteredPersistentResults.length === 0) {
						this.devLog(`[PersistentCache] Ignored all ${persistentResults.length} results by .gitignore`);
					} else {
				this.devLog(`[PersistentCache] ✓ Hit! Returning ${filteredPersistentResults.length} results (time: ${Date.now() - persistentStartTime}ms)`);

				// 对函数调用应用重载过滤
				const overloadFiltered = this.applyOverloadFiltering(filteredPersistentResults, callArgs, name);

				this.devLog(`[Performance] ========== Total time: ${Date.now() - startTime}ms (persistent), Found: ${overloadFiltered.length} ==========`);

				// 存入定义缓存
				this.definitionCache.set(cacheKey, {
					results: overloadFiltered,
					timestamp: Date.now()
				});

				resolve(overloadFiltered);
				return;
				}
				}
				
			this.devLog(`[PersistentCache] ✗ Miss (time: ${Date.now() - persistentStartTime}ms)`);
			}

            // 智能类型判断：根据上下文推测符号类型（提前计算，后续存储缓存时使用）
            const symbolType = this.guessSymbolType(document, position);

            // 策略1: 优先使用 ripgrep 直接搜索（最快最准确）
            if (workspace.workspaceFolders) {
                const rgStartTime = Date.now();
                this.devLog(`[Performance] Starting ripgrep search...`);
                
                this.devLog(`[Search] Guessed type: ${symbolType}`);
                
                for (const folder of workspace.workspaceFolders) {
                    const rootPath = folder.uri.fsPath;

                    // 优化：根据推测的类型调整搜索顺序和策略
                    if (symbolType === 'function') {
                        // 只搜索函数（最常见的情况）
                        const funcStart = Date.now();
                        const funcResults = await this.searchFunctionDefinitions(name, rootPath);
                        this.devLog(`[Performance] Function search: ${Date.now() - funcStart}ms`);
                        results.push(...funcResults);
                        
                        // 提前终止：找到结果就返回
                        if (results.length > 0) {
                            this.devLog(`[Search] Found ${results.length} results, early termination`);
                            break;
                        }
                    } else if (symbolType === 'both') {
                        // 宏函数：同时搜索宏和函数
                        const bothStart = Date.now();
                        const [macroResults, funcResults] = await Promise.all([
                            this.searchMacroDefinitions(name, rootPath),
                            this.searchFunctionDefinitions(name, rootPath)
                        ]);
                        this.devLog(`[Performance] Macro+Function search: ${Date.now() - bothStart}ms`);
                        results.push(...macroResults, ...funcResults);
                        
                        if (results.length > 0) {
                            this.devLog(`[Search] Found ${results.length} results (macro: ${macroResults.length}, function: ${funcResults.length}), early termination`);
                            break;
                        }
                    } else if (symbolType === 'type') {
                        // 只搜索结构体
                        const structStart = Date.now();
                        const structResults = await this.searchStructDefinitions(name, rootPath);
                        this.devLog(`[Performance] Struct search: ${Date.now() - structStart}ms`);
                        results.push(...structResults);
                        
                        if (results.length > 0) {
                            this.devLog(`[Search] Found ${results.length} results, early termination`);
                            break;
                        }
                    } else if (symbolType === 'macro') {
                        // 只搜索宏
                        const macroStart = Date.now();
                        const macroResults = await this.searchMacroDefinitions(name, rootPath);
                        this.devLog(`[Performance] Macro search: ${Date.now() - macroStart}ms`);
                        results.push(...macroResults);
                        
                        if (results.length > 0) {
                            this.devLog(`[Search] Found ${results.length} results, early termination`);
                            break;
                        }
                    } else {
                        // 未知类型：并行搜索所有类型（但找到后立即终止）
                        const searchStart = Date.now();
                        const [macroResults, funcResults, structResults] = await Promise.all([
                            this.searchMacroDefinitions(name, rootPath),
                            this.searchFunctionDefinitions(name, rootPath),
                            this.searchStructDefinitions(name, rootPath)
                        ]);
                        this.devLog(`[Performance] Parallel search: ${Date.now() - searchStart}ms`);
                        
                        results.push(...macroResults, ...funcResults, ...structResults);
                        
                        if (results.length > 0) {
                            this.devLog(`[Search] Found ${results.length} results, early termination`);
                            break;
                        }
                    }
                }
                
                this.devLog(`[Performance] Total ripgrep time: ${Date.now() - rgStartTime}ms`);
            }

            // 策略2: 只有在 ripgrep 未找到结果时，才使用 workspace symbol provider 作为后备
            if (results.length === 0) {
                this.devLog(`[Search] Ripgrep found nothing, trying workspace symbol provider...`);
                const symbolStartTime = Date.now();
                
                try {
                    let symbols = await commands.executeCommand<SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name);
                    this.devLog(`[Performance] Symbol provider time: ${Date.now() - symbolStartTime}ms`);
                    
                    if (symbols && symbols.length > 0) {
                        this.devLog(`[Symbol] Provider returned ${symbols.length} symbols`);
                        // 精确匹配符号名称（符号名可能是 "funcName" 或 "funcName (vertex)" 等格式）
                        const exactMatches = symbols.filter(s => {
                            const symbolName = s.name.split(' ')[0].split('(')[0].trim();
                            return symbolName === name;
                        });
                        this.devLog(`[Symbol] Exact matches: ${exactMatches.length}`);
                        exactMatches.forEach(symbol => {
                            results.push(symbol.location);
                        });
                    }
                } catch (error) {
                    this.devLog(`[Symbol] Error: ${error}`);
                }
            } else {
                this.devLog(`[Search] Ripgrep found ${results.length} results, skipping symbol provider`);
            }

            // 去重（同一位置可能被多次找到）
            const uniqueResults = new Map<string, Location>();
            for (const loc of results) {
                const key = `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character}`;
                if (!uniqueResults.has(key)) {
                    uniqueResults.set(key, loc);
                }
            }

            // 按优先级排序
            const sortedResults = this.sortLocationsByPriority(
                this.filterIgnoredLocations(Array.from(uniqueResults.values()))
            );

            // 对函数调用应用重载精确匹配过滤
            const finalResults = this.applyOverloadFiltering(sortedResults, callArgs, name);

            // 存入缓存
            if (finalResults.length > 0) {
                this.definitionCache.set(cacheKey, {
                    results: finalResults,
                    timestamp: Date.now()
                });
                this.devLog(`[Cache] Stored ${finalResults.length} results for "${name}"`);
                // 同时存入持久化缓存（如果存在）
                if (this.symbolCacheManager) {
                    this.storeResultsToPersistentCache(name, finalResults, symbolType);
                }

                // 限制缓存大小（最多100个条目）
                if (this.definitionCache.size > 100) {
                    const oldestKey = this.definitionCache.keys().next().value;
                    if (oldestKey) {
                        this.definitionCache.delete(oldestKey);
                        this.devLog(`[Cache] Evicted oldest entry`);
                    }
                }
            }

            const totalTime = Date.now() - startTime;
            this.devLog(`[Performance] ========== Total time: ${totalTime}ms, Found: ${finalResults.length} ==========`);

            resolve(finalResults);
        });
    }

    private tryFindLocalVariableDefinition(
        document: TextDocument,
        position: Position,
        wordRange: Range,
        name: string
    ): Location | null {
        const lineText = document.lineAt(position.line).text;
        const afterWord = lineText.substring(wordRange.end.character);

        // 函数调用不走局部变量逻辑
        if (afterWord.trimStart().startsWith('(')) {
            return null;
        }

        // 预处理宏（常见为全大写）不走局部变量逻辑
        if (name.length > 2 && name === name.toUpperCase()) {
            return null;
        }

        // 成员访问（foo.bar）优先走结构体类型跳转，不走“同名变量声明”回退逻辑
        if (this.isMemberAccessName(document, wordRange)) {
            return null;
        }

        // 0) 优先：函数参数（如 float4 vertex）
        const paramInfo = this.findParameterInfoInEnclosingFunction(document, position, name);
        if (paramInfo) {
            return paramInfo.location;
        }

        // 1) 优先使用符号缓存中的“当前文件符号”做局部判定（最快）
        const cached = this.findLocalVariableFromFileCache(document, position, name);
        if (cached) {
            return cached;
        }

        // 2) 回退：在当前文档内用轻量正则查找局部变量声明
        return this.findLocalVariableFromDocumentText(document, position, name);
    }

    private findLocalVariableFromFileCache(document: TextDocument, position: Position, name: string): Location | null {
        if (!this.symbolCacheManager) {
            return null;
        }

        const fileSymbols = this.symbolCacheManager.getFileSymbols(document.uri.fsPath);
        if (!fileSymbols || fileSymbols.length === 0) {
            return null;
        }

        const functionSymbols = fileSymbols.filter(s => s.kind === CachedSymbolKind.Function);
        const enclosingFunction = functionSymbols.find(f => f.line <= position.line && position.line <= f.endLine);

        const candidates = fileSymbols
            .filter(s => s.kind === CachedSymbolKind.Variable && s.name === name && s.line <= position.line)
            .filter(s => {
                if (enclosingFunction) {
                    return s.line >= enclosingFunction.line && s.line <= enclosingFunction.endLine;
                }
                // 不在函数内：尽量避免选到其他函数体内的同名局部变量
                return !functionSymbols.some(f => s.line >= f.line && s.line <= f.endLine);
            })
            .sort((a, b) => b.line - a.line || b.column - a.column);

        if (candidates.length === 0) {
            return null;
        }

        const best = candidates[0];
        const declLineText = document.lineAt(best.line).text;
        const nameColumn = declLineText.indexOf(name);
        const col = nameColumn >= 0 ? nameColumn : best.column;

        return new Location(
            document.uri,
            new Range(new Position(best.line, col), new Position(best.line, col + name.length))
        );
    }

    private findLocalVariableFromDocumentText(document: TextDocument, position: Position, name: string): Location | null {
        const text = maskCommentsPreserveLayout(document.getText());
        const cursorOffset = document.offsetAt(position);

        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declRegex = new RegExp(
            `^[ \\t]*(?:\\w+[ \\t]+)+(${escapedName})\\b\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=|;|,)`,
            'gm'
        );

        const skipFirstTokens = new Set([
            'if', 'for', 'while', 'switch', 'case', 'default', 'return',
            'break', 'continue', 'discard', 'else'
        ]);

        let bestNameOffset = -1;
        let match: RegExpExecArray | null;
        while ((match = declRegex.exec(text)) !== null) {
            const matchText = match[0];
            const firstToken = matchText.trimStart().split(/\s+/)[0]?.toLowerCase() || '';
            if (skipFirstTokens.has(firstToken)) {
                continue;
            }

            const nameOffset = match.index + matchText.indexOf(match[1]);
            if (nameOffset < 0 || nameOffset > cursorOffset) {
                continue;
            }

            if (nameOffset > bestNameOffset) {
                bestNameOffset = nameOffset;
            }
        }

        if (bestNameOffset === -1) {
            return null;
        }

        const startPos = document.positionAt(bestNameOffset);
        const endPos = new Position(startPos.line, startPos.character + name.length);
        return new Location(document.uri, new Range(startPos, endPos));
    }

    private isMemberAccessName(document: TextDocument, wordRange: Range): boolean {
        const lineText = document.lineAt(wordRange.start.line).text;
        let i = wordRange.start.character - 1;
        while (i >= 0 && /\s/.test(lineText[i])) {
            i--;
        }
        if (i < 0) {
            return false;
        }
        if (lineText[i] === '.') {
            return true;
        }
        if (lineText[i] === '>' && i - 1 >= 0 && lineText[i - 1] === '-') {
            return true;
        }
        return false;
    }

    private async tryFindStructMemberTypeDefinitions(document: TextDocument, position: Position, wordRange: Range): Promise<Location[] | null> {
        const baseIdentifier = this.getMemberAccessBaseIdentifier(document, wordRange);
        if (!baseIdentifier) {
            return null;
        }

        const baseType = this.resolveIdentifierType(document, position, baseIdentifier);
        if (!baseType || this.isBuiltInType(baseType)) {
            return null;
        }

        this.devLog(`[Type] Member access: base="${baseIdentifier}", type="${baseType}"`);

        // 优先走持久化缓存（类型定义）
        const cachedType = this.searchTypeDefinitionFromPersistentCache(baseType);
        if (cachedType.length > 0) {
            return cachedType;
        }

        // 回退：用 ripgrep 搜索结构体定义
        if (workspace.workspaceFolders) {
            // 只要一个工作区命中就返回，避免全局扫一遍
            // 结构体定义较少，查找代价可控
            for (const folder of workspace.workspaceFolders) {
                const rootPath = folder.uri.fsPath;
                const results = await this.searchStructDefinitions(baseType, rootPath);
                if (results.length > 0) {
                    return results;
                }
            }
        }

        return null;
    }

    private getMemberAccessBaseIdentifier(document: TextDocument, wordRange: Range): string | null {
        const lineText = document.lineAt(wordRange.start.line).text;

        let i = wordRange.start.character - 1;
        while (i >= 0 && /\s/.test(lineText[i])) {
            i--;
        }
        if (i < 0) {
            return null;
        }

        // foo.bar 或 foo -> bar
        if (lineText[i] === '.') {
            i--;
        } else if (lineText[i] === '>' && i - 1 >= 0 && lineText[i - 1] === '-') {
            i -= 2;
        } else {
            return null;
        }

        while (i >= 0 && /\s/.test(lineText[i])) {
            i--;
        }
        if (i < 0) {
            return null;
        }

        let end = i + 1;
        while (i >= 0 && /[A-Za-z0-9_]/.test(lineText[i])) {
            i--;
        }
        const start = i + 1;
        const base = lineText.substring(start, end).trim();
        return base.length > 0 ? base : null;
    }

    private resolveIdentifierType(document: TextDocument, position: Position, identifier: string): string | null {
        // 1) 参数类型
        const paramInfo = this.findParameterInfoInEnclosingFunction(document, position, identifier);
        if (paramInfo && paramInfo.type) {
            return paramInfo.type;
        }

        // 2) 当前文件变量声明（缓存）
        if (this.symbolCacheManager) {
            const fileSymbols = this.symbolCacheManager.getFileSymbols(document.uri.fsPath);
            if (fileSymbols && fileSymbols.length > 0) {
                const functionSymbols = fileSymbols.filter(s => s.kind === CachedSymbolKind.Function);
                const enclosingFunction = this.findEnclosingFunctionSymbol(functionSymbols, position.line);

                const candidates = fileSymbols
                    .filter(s => s.kind === CachedSymbolKind.Variable && s.name === identifier && s.line <= position.line)
                    .filter(s => {
                        if (enclosingFunction) {
                            return s.line >= enclosingFunction.line && s.line <= enclosingFunction.endLine;
                        }
                        return !functionSymbols.some(f => s.line >= f.line && s.line <= f.endLine);
                    })
                    .sort((a, b) => b.line - a.line || b.column - a.column);

                if (candidates.length > 0) {
                    const best = candidates[0];
                    if (best.signature) {
                        const parts = best.signature.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            return parts[0];
                        }
                    }
                }
            }
        }

        return null;
    }

    private isBuiltInType(typeName: string): boolean {
        const t = typeName.trim();
        if (t === '') {
            return true;
        }

        const lowered = t.toLowerCase();
        if (['void', 'bool', 'int', 'uint', 'half', 'float', 'double', 'fixed'].includes(lowered)) {
            return true;
        }

        // float2/half4/float4x4 等
        if (/^(bool|int|uint|half|float|double|fixed)\d+(x\d+)?$/i.test(t)) {
            return true;
        }

        // 常见资源类型
        if (/^(sampler|samplerstate|samplercomparisonstate)/i.test(t)) {
            return true;
        }
        if (/^(texture|rwtexture|buffer|rwbuffer|structuredbuffer|rwstructuredbuffer|byteaddressbuffer|rwbyteaddressbuffer)/i.test(t)) {
            return true;
        }

        return false;
    }

    private searchTypeDefinitionFromPersistentCache(typeName: string): Location[] {
        if (!this.symbolCacheManager) {
            return [];
        }

        const symbols = this.symbolCacheManager.findSymbol(typeName);
        if (symbols.length === 0) {
            return [];
        }

        const typeSymbols = symbols.filter(s =>
            s.kind === CachedSymbolKind.Struct ||
            s.kind === CachedSymbolKind.Class ||
            s.kind === CachedSymbolKind.Typedef ||
            s.kind === CachedSymbolKind.Interface
        );

        const results: Location[] = [];
        for (const symbol of typeSymbols) {
            try {
                const uri = Uri.file(this.getAbsolutePath(symbol.filePath));
                const range = new Range(
                    new Position(symbol.line, symbol.column),
                    new Position(symbol.line, symbol.column + symbol.name.length)
                );
                results.push(new Location(uri, range));
            } catch (error) {
                this.devLog(`[PersistentCache] Error converting type symbol: ${error}`);
            }
        }

        return results;
    }

    private findEnclosingFunctionSymbol(functionSymbols: CachedSymbol[], line: number): CachedSymbol | null {
        const candidates = functionSymbols
            .filter(f => f.line <= line && line <= f.endLine)
            .sort((a, b) => b.line - a.line);
        return candidates.length > 0 ? candidates[0] : null;
    }

    private findParameterInfoInEnclosingFunction(
        document: TextDocument,
        position: Position,
        paramName: string
    ): { type: string | null; location: Location } | null {
        const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // 1) 优先从缓存定位“包裹当前行”的函数
        let functionStartLine: number | null = null;
        let functionName: string | null = null;

        if (this.symbolCacheManager) {
            const fileSymbols = this.symbolCacheManager.getFileSymbols(document.uri.fsPath);
            if (fileSymbols && fileSymbols.length > 0) {
                const functionSymbols = fileSymbols.filter(s => s.kind === CachedSymbolKind.Function);
                const enclosingFunction = this.findEnclosingFunctionSymbol(functionSymbols, position.line);
                if (enclosingFunction) {
                    functionStartLine = enclosingFunction.line;
                    functionName = enclosingFunction.name;
                }
            }
        }

        // 2) 回退：向上找一个看起来像函数签名的行
        if (functionStartLine === null) {
            functionStartLine = this.findLikelyFunctionStartLine(document, position.line);
        }

        if (functionStartLine === null) {
            return null;
        }

        const maxEndLine = Math.min(document.lineCount - 1, functionStartLine + 50);
        const headerRange = new Range(
            new Position(functionStartLine, 0),
            new Position(maxEndLine, document.lineAt(maxEndLine).text.length)
        );

        const headerText = maskCommentsPreserveLayout(document.getText(headerRange));

        const nameIndex = functionName ? headerText.search(new RegExp(`\\b${functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)) : -1;
        const openIndex = headerText.indexOf('(', nameIndex >= 0 ? nameIndex : 0);
        if (openIndex === -1) {
            return null;
        }

        // 找到匹配的 ')'
        let depth = 0;
        let closeIndex = -1;
        for (let i = openIndex; i < headerText.length; i++) {
            const ch = headerText[i];
            if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth--;
                if (depth === 0) {
                    closeIndex = i;
                    break;
                }
            }
        }
        if (closeIndex === -1) {
            return null;
        }

        const paramList = headerText.slice(openIndex + 1, closeIndex);
        const paramMatch = new RegExp(`\\b${escaped}\\b`).exec(paramList);
        if (!paramMatch || paramMatch.index === undefined) {
            return null;
        }

        const headerStartOffset = document.offsetAt(new Position(functionStartLine, 0));
        const absoluteNameOffset = headerStartOffset + (openIndex + 1 + paramMatch.index);

        const startPos = document.positionAt(absoluteNameOffset);
        const endPos = new Position(startPos.line, startPos.character + paramName.length);
        const location = new Location(document.uri, new Range(startPos, endPos));

        // 尝试解析参数类型（用于结构体成员类型跳转）
        const segmentStart = Math.max(0, paramList.lastIndexOf(',', paramMatch.index) + 1);
        const segmentEnd = (() => {
            const nextComma = paramList.indexOf(',', paramMatch.index);
            return nextComma === -1 ? paramList.length : nextComma;
        })();
        const paramSegment = paramList.slice(segmentStart, segmentEnd).replace(/\s+/g, ' ').trim();

        const qualifierRegex = /^(?:inout|in|out|const|static|uniform|volatile|precise|row_major|column_major)\s+/i;
        let cleaned = paramSegment;
        while (qualifierRegex.test(cleaned)) {
            cleaned = cleaned.replace(qualifierRegex, '').trim();
        }

        const typeMatch = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>]+>)?)\\s+${escaped}\\b`).exec(cleaned);
        const type = typeMatch ? typeMatch[1].trim() : null;

        return { type, location };
    }

    private findLikelyFunctionStartLine(document: TextDocument, fromLine: number): number | null {
        const maxLookback = 200;
        const stopLine = Math.max(0, fromLine - maxLookback);
        const skip = new Set(['if', 'for', 'while', 'switch', 'return', 'else']);

        for (let line = fromLine; line >= stopLine; line--) {
            const text = document.lineAt(line).text.trim();
            if (!text) {
                continue;
            }
            const first = text.split(/\s+/)[0]?.toLowerCase() || '';
            if (skip.has(first)) {
                continue;
            }
            if (/\b\w+\b\s*\(/.test(text) && !/;\s*$/.test(text)) {
                // 简单启发：像 "retType funcName(" 或 "funcName(" 的行
                return line;
            }
        }

        return null;
    }

    /**
     * 将搜索结果存入持久化缓存
     */
    private storeResultsToPersistentCache(
        name: string,
        results: Location[],
        symbolType: 'function' | 'macro' | 'both' | 'type' | 'unknown'
    ): void {
        if (!this.symbolCacheManager || results.length === 0) {
            return;
        }

        // 将符号类型映射到 CachedSymbolKind
        let kind: CachedSymbolKind;
        switch (symbolType) {
            case 'function':
                kind = CachedSymbolKind.Function;
                break;
            case 'macro':
                kind = CachedSymbolKind.Macro;
                break;
            case 'type':
                kind = CachedSymbolKind.Struct;
                break;
            default:
                kind = CachedSymbolKind.Function; // 默认为函数
        }

        for (const location of results) {
            try {
                const relativePath = this.getRelativePath(location.uri.fsPath);
                
                const symbol = {
                    name: name,
                    kind: kind,
                    filePath: relativePath,
                    line: location.range.start.line,
                    column: location.range.start.character,
                    endLine: location.range.end.line,
                    endColumn: location.range.end.character,
                    signature: name, // 简单签名
                    documentation: '',
                };

                this.symbolCacheManager.storeSymbol(symbol);
            } catch (error) {
                this.devLog(`[PersistentCache] Error storing symbol: ${error}`);
            }
        }
    }

    /**
     * 获取相对路径
     */
    private getRelativePath(absolutePath: string): string {
        if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
            const path = require('path');
            const workspacePath = workspace.workspaceFolders[0].uri.fsPath;
            return path.relative(workspacePath, absolutePath).replace(/\\/g, '/');
        }
        return absolutePath;
    }

    /**
     * 搜索 #include 文件
     */
    private async searchIncludeFile(includePath: string, currentFilePath: string, rootPath: string): Promise<Location | null> {
        try {
            const path = require('path');
            const fs = require('fs');
            
            // 移除引号
            includePath = includePath.replace(/["<>]/g, '').trim();
            
            this.devLog(`[Include] Searching: "${includePath}"`);
            this.devLog(`[Include] Current file: ${currentFilePath}`);
            this.devLog(`[Include] Root path: ${rootPath}`);
            
            // 1. 处理 Unreal 的虚拟路径（以 /Engine/ 开头）
            // 例如：/Engine/Public/Platform.ush -> {ShaderRoot}/Public/Platform.ush
            if (includePath.startsWith('/Engine/')) {
                // 移除 /Engine/ 前缀
                const relativePath = includePath.substring('/Engine/'.length);
                
                // 尝试在 Shaders 目录下查找
                // 可能的路径：
                // 1. {workspace}/Engine/Shaders/{relativePath}
                // 2. {workspace}/Shaders/{relativePath}
                const possiblePaths = [
                    path.join(rootPath, 'Engine', 'Shaders', relativePath),
                    path.join(rootPath, 'Shaders', relativePath),
                    path.join(rootPath, relativePath)
                ];
                
                for (const fullPath of possiblePaths) {
                    this.devLog(`[Include] Trying: ${fullPath}`);
                    if (fs.existsSync(fullPath) && !WorkspaceIgnore.isIgnored(rootPath, fullPath)) {
                        this.devLog(`[Include] ✓ Found: ${fullPath}`);
                        return new Location(Uri.file(fullPath), new Position(0, 0));
                    }
                }
            }
            
            // 2. 尝试相对于当前文件的路径
            const currentDir = path.dirname(currentFilePath);
            let fullPath = path.join(currentDir, includePath);
            
            this.devLog(`[Include] Trying relative: ${fullPath}`);
            if (fs.existsSync(fullPath) && !WorkspaceIgnore.isIgnored(rootPath, fullPath)) {
                this.devLog(`[Include] ✓ Found: ${fullPath}`);
                return new Location(Uri.file(fullPath), new Position(0, 0));
            }
            
            // 3. 尝试相对于工作区根目录
            fullPath = path.join(rootPath, includePath);
            this.devLog(`[Include] Trying root: ${fullPath}`);
            if (fs.existsSync(fullPath) && !WorkspaceIgnore.isIgnored(rootPath, fullPath)) {
                this.devLog(`[Include] ✓ Found: ${fullPath}`);
                return new Location(Uri.file(fullPath), new Position(0, 0));
            }
            
            // 4. 使用 ripgrep 直接搜索文件名（方案5：更简单高效）
            const fileName = path.basename(includePath);
            try {
                this.devLog(`[Include] Searching by filename: ${fileName}`);
                
                // 使用RipgrepUtils统一接口搜索文件
                const matchingFiles = RipgrepUtils.searchFiles(fileName, rootPath);
                this.devLog(`[Include] Found ${matchingFiles.length} matching files`);
                
                if (matchingFiles.length > 0) {
                    // 优先选择路径最匹配的文件
                    let bestMatch = matchingFiles[0];
                    const includeDir = path.dirname(includePath);
                    
                    // 如果 include 路径包含目录，尝试找到最匹配的文件
                    if (includeDir && includeDir !== '.') {
                        for (const file of matchingFiles) {
                            if (file.includes(includeDir)) {
                                bestMatch = file;
                                break;
                            }
                        }
                    }
                    
                    const foundPath = path.join(rootPath, bestMatch);
                    if (WorkspaceIgnore.isIgnored(rootPath, foundPath)) {
                        return null;
                    }
                    this.devLog(`[Include] ✓ Found by search: ${foundPath}`);
                    return new Location(Uri.file(foundPath), new Position(0, 0));
                }                
            } catch (error: any) {
                // 没有找到文件
                this.devLog(`[Include] Search failed: ${error.message}`);
            }
            
            this.devLog(`[Include] ✗ Not found`);
        } catch (error) {
            this.devLog(`[Include] Error: ${error}`);
        }
        
        return null;
    }

    /**
     * 搜索 FallBack Shader
     * 支持搜索 Shader "ShaderName" 定义，例如：
     * - FallBack "Diffuse" -> 搜索 Shader "Diffuse"
     * - FallBack "Mobile/VertexLit" -> 搜索 Shader "Mobile/VertexLit"
     */
    private async searchFallBackShader(shaderName: string, rootPath: string): Promise<Location[]> {
        this.devLog(`[FallBack] Searching: "${shaderName}"`);
        
        // 首先尝试从缓存中查找 shader 定义
        const cachedResults = await this.searchShaderFromCache(shaderName, rootPath);
        if (cachedResults.length > 0) {
            this.devLog(`[FallBack] ✓ Found in cache: ${cachedResults.length} result(s)`);
            return cachedResults;
        }
        
        // 缓存未命中，使用 ripgrep 搜索
        return this.searchShaderWithRipgrep(shaderName, rootPath);
    }
    
    /**
     * 从缓存中查找 Shader 定义
     */
    private async searchShaderFromCache(shaderName: string, rootPath: string): Promise<Location[]> {
        const results: Location[] = [];
        
        if (!this.symbolCacheManager) {
            return results;
        }
        
        try {
            // 在缓存中查找符号
            const cachedSymbols = this.symbolCacheManager.findSymbol(shaderName);
            
            // 只保留 shader 类型的符号
            const shaderSymbols = cachedSymbols.filter(s => s.kind === CachedSymbolKind.Shader);
            
            for (const symbol of shaderSymbols) {
                const absolutePath = join(rootPath, symbol.filePath);
                const range = new Range(
                    new Position(symbol.line, symbol.column),
                    new Position(symbol.line, symbol.column + symbol.name.length)
                );
                results.push(new Location(Uri.file(absolutePath), range));
            }
        } catch (error) {
            this.devLog(`[FallBack] Cache search error: ${error}`);
        }
        
        return results;
    }
    
    /**
     * 使用 ripgrep 搜索 Shader 定义
     */
    private async searchShaderWithRipgrep(shaderName: string, rootPath: string): Promise<Location[]> {
        const results: Location[] = [];
        const rgPath = getRgPath();
        const isWindows = process.platform === 'win32';
        
        try {
            // 注意：/ 字符在 ripgrep 正则表达式中不是特殊字符，不需要转义
            // 只需要转义正则表达式的特殊字符：. * + ? ^ $ { } ( ) | [ ] \
            const escapedShaderName = shaderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // FallBack 是 Unity 独有的功能，只需要搜索 .shader 和 .cginc 文件
            const fileTypes = ['*.shader', '*.cginc'];
            const globPattern = fileTypes.map(t => `-g "${t}"`).join(' ');
            
            // 构建搜索模式：匹配 Shader "ShaderName" 行
            // 跨平台处理：
            // - Windows: 使用 \" 转义双引号，外层用双引号包裹
            // - macOS/Linux: 使用单引号包裹整个模式，内部双引号不需要转义
            // 使用RipgrepUtils统一接口搜索Shader定义
            this.devLog(`[FallBack] Searching Shader definition: ${shaderName}`);
            
            // FallBack 是 Unity 独有的功能，只需要搜索 .shader 和 .cginc 文件
            const searchExtensions = ['shader', 'cginc'];
            const matches = RipgrepUtils.searchShaderDefinition(shaderName, rootPath, searchExtensions);
            
            for (const match of matches) {
                const filepath = match.filePath;
                const lineNum = match.line;
                const lineText = match.text;
                
                // 在行文本中查找 Shader 名称的精确位置
                const nameMatch = new RegExp(`Shader\\s+"([^"]+)"`, 'i').exec(lineText);
                if (nameMatch && nameMatch[1] === shaderName) {
                    // 计算Shader名称在行中的起始位置
                    const startCol = lineText.indexOf(`"${shaderName}"`) + 1; // +1 跳过开头的引号
                    const endCol = startCol + shaderName.length;
                    const range = new Range(
                        new Position(lineNum, startCol),
                        new Position(lineNum, endCol)
                    );
                    
                    // 获取相对路径用于日志
                    const relativePath = filepath.replace(rootPath, '').replace(/^[\\\/]/, '');
                    
                    results.push(new Location(Uri.file(filepath), range));
                    this.devLog(`[FallBack] ✓ Found: ${relativePath}:${lineNum + 1}`);
                }
            }
            
            if (results.length === 0) {
                this.devLog(`[FallBack] ✗ Not found`);
            } else {
                this.devLog(`[FallBack] ✓ Jump to: ${results[0].uri.fsPath}`);
            }
        } catch (error: any) {
            // ripgrep 返回 status 1 表示没有找到匹配
            if (error.status === 1) {
                this.devLog(`[FallBack] ✗ Not found`);
            } else {
                this.devLog(`[FallBack] Error: ${error.message}`);
            }
        }
        
        return results;
    }

    public provideDefinition(document: TextDocument, position: Position, token: CancellationToken | boolean): Thenable<Definition> {
        return new Promise<Definition>(async (resolve, reject) => {
            let enable = workspace.getConfiguration('unityshader').get<boolean>('suggest.basic', true);
            if (!enable) {
                reject();
                return;
            }
            
            const line = document.lineAt(position.line);
            const lineText = line.text;
            
            // 1. 检查是否在 #include 行上
            const includeMatch = /#include\s+["<]([^">]+)[">]/.exec(lineText);
            if (includeMatch) {
                // 兼容：include 路径在字符串中，但仍应允许跳转；仅在被注释掉的 #include 中跳过
                const includeTokenPos = new Position(position.line, includeMatch.index ?? 0);
                if (isInCommentOrString(document, includeTokenPos)) {
                    // 被注释掉的 include，不处理
                } else {
                const includePath = includeMatch[1];
                const includeStart = lineText.indexOf(includePath);
                const includeEnd = includeStart + includePath.length;
                
                // 检查光标是否在 include 路径上
                if (position.character >= includeStart && position.character <= includeEnd) {
                    if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
                        const rootPath = workspace.workspaceFolders[0].uri.fsPath;
                        const location = await this.searchIncludeFile(includePath, document.uri.fsPath, rootPath);
                        if (location) {
                            resolve(location);
                            return;
                        }
                    }
                }
                }
            }
            
            // 2. 检查是否在 FallBack 行上（不区分大小写）
            // 注意：FallBack 是 Unity ShaderLab 特有的功能，只在 Unity 模式下启用
            const engineContext = EngineContextManager.getInstance();
            const isUnityMode = engineContext.isUnityMode();
            
            if (isUnityMode) {
                const fallbackMatch = /FallBack\s+"([^"]+)"/i.exec(lineText);
                if (fallbackMatch) {
                    // FallBack 的 Shader 名称在字符串中，但仍应允许跳转；仅在被注释掉的 FallBack 中跳过
                    const fallbackTokenPos = new Position(position.line, fallbackMatch.index ?? 0);
                    if (isInCommentOrString(document, fallbackTokenPos)) {
                        // 被注释掉的 FallBack，不处理
                    } else {
                    const shaderName = fallbackMatch[1];
                    const shaderStart = lineText.indexOf(shaderName);
                    const shaderEnd = shaderStart + shaderName.length;
                    
                    // 检查光标是否在 Shader 名称上
                    if (position.character >= shaderStart && position.character <= shaderEnd) {
                        if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
                            const rootPath = workspace.workspaceFolders[0].uri.fsPath;
                            const locations = await this.searchFallBackShader(shaderName, rootPath);
                            if (locations.length > 0) {
                                resolve(locations);
                                return;
                            }
                        }
                        // FallBack 未找到时直接返回，不继续搜索符号
                        reject();
                        return;
                    }
                    }
                }
            }

            // VS Code 在注释/字符串中也会触发 DefinitionProvider；这里主动短路，避免注释里也能跳转定义
            // 注意：#include/FallBack 属于字符串路径跳转，已在上方单独处理
            if (isInCommentOrString(document, position)) {
                reject();
                return;
            }
             
            // 3. 默认行为：查找符号定义
            const result = await this.getDefinitionLocations(document, position);
            const filteredResult = this.filterIgnoredLocations(Array.isArray(result) ? result : [result]);
            resolve(filteredResult);
        });
    }

    public provideImplementation(document: TextDocument, position: Position, token: CancellationToken): Thenable<Definition> {
        return this.getDefinitionLocations(document, position);
    }

    public provideTypeDefinition(document: TextDocument, position: Position, token: CancellationToken): Thenable<Definition> {
        return this.getDefinitionLocations(document, position);
    }
}
