import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';

const OLLAMA_BASE_URL = 'http://localhost:11434';

interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	fileContext?: {
		path: string;
		language: string;
		selection?: { start: number; end: number };
	};
	codeChanges?: Array<{
		file: string;
		originalCode: string;
		newCode: string;
		applied: boolean;
		replaceAll?: boolean;
		diff?: Array<{ type: 'add' | 'del' | 'ctx'; text: string }>;
	}>;
	thinking?: string;
}

interface ChatSession {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('CodeMate');
	context.subscriptions.push(output);
	output.appendLine('CodeMate activated');

	// Inline completion provider
	const provider = new PythonSidecarProvider(output);
	const selector: vscode.DocumentSelector = [
		{ scheme: 'file', pattern: '**' },
		{ scheme: 'untitled', pattern: '**' }
	];
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(selector, provider)
	);

	// Chat-based sidebar
	const sidebarProvider = new ModernAgentSidebarProvider(context, output);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ModernAgentSidebarProvider.viewType, sidebarProvider)
	);
}

// Inline completion provider (unchanged)
class PythonSidecarProvider implements vscode.InlineCompletionItemProvider {
	private debounceTimer: NodeJS.Timeout | undefined;
	private output: vscode.OutputChannel;
	private inlineModelCache: { value: string | null; fetchedAt: number } | undefined;
	private readonly inlineModelTtlMs = 60_000;

	constructor(output: vscode.OutputChannel) {
		this.output = output;
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | null> {
		return new Promise((resolve) => {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(async () => {
				if (token.isCancellationRequested) {
					resolve(null);
					return;
				}
				try {
					this.output.appendLine(`Requesting suggestion at ${document.uri.toString()}:${position.line + 1}:${position.character + 1}`);
					const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
					const lastLineIndex = Math.max(0, document.lineCount - 1);
					const lastLine = document.lineAt(lastLineIndex);
					const suffix = document.getText(new vscode.Range(position, lastLine.range.end));
					const model = await this.getInlineModel();
					if (!model) {
						this.output.appendLine('No Ollama models found for inline completions.');
						resolve(null);
						return;
					}
					const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							model,
							system: 'You are a code completion engine. Return ONLY valid JSON: {"code":"..."} with no extra text or markdown.',
							prompt: prefix,
							suffix,
							format: 'json',
							stream: false,
							options: { temperature: 0, num_predict: 128, stop: ['<|EOT|>', '\n\n\n', '```'] }
						})
					});
					if (!response.ok) {
						this.output.appendLine(`HTTP ${response.status} from Ollama`);
						resolve(null);
						return;
					}
					const data = await response.json() as { response?: string };
					const raw = (data.response ?? '').trim();
					const prediction = this.extractInlineCompletion(raw, prefix);
					if (prediction) {
						resolve([new vscode.InlineCompletionItem(prediction, new vscode.Range(position, position))]);
					} else {
						this.output.appendLine('Ollama returned empty prediction');
						resolve(null);
					}
				} catch (error) {
					this.output.appendLine(`Ollama error: ${String(error)}`);
					resolve(null);
				}
			}, 300);
		});
	}

	private extractInlineCompletion(raw: string, prefix: string): string {
		if (!raw) return '';
		try {
			const parsed = JSON.parse(raw);
			if (parsed.code && typeof parsed.code === 'string') {
				return parsed.code.trim();
			}
		} catch { }
		return raw.trim();
	}

	private async getInlineModel(): Promise<string | null> {
		const configured = vscode.workspace.getConfiguration('codemate').get<string>('inlineModel');
		if (configured?.trim()) return configured.trim();
		const now = Date.now();
		if (this.inlineModelCache && now - this.inlineModelCache.fetchedAt < this.inlineModelTtlMs) {
			return this.inlineModelCache.value;
		}
		try {
			const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET' });
			if (!response.ok) {
				this.inlineModelCache = { value: null, fetchedAt: now };
				return null;
			}
			const data = await response.json() as { models?: Array<{ name: string }> };
			const model = (data.models ?? [])[0]?.name ?? null;
			this.inlineModelCache = { value: model, fetchedAt: now };
			return model;
		} catch {
			this.inlineModelCache = { value: null, fetchedAt: now };
			return null;
		}
	}
}

// Chat-based Sidebar Provider with improved error detection
class ModernAgentSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'codemate.agentView';

	private context: vscode.ExtensionContext;
	private output: vscode.OutputChannel;
	private view: vscode.WebviewView | undefined;
	private lastFileEditor: vscode.TextEditor | undefined;
	private currentModel: string = '';
	private groqModel: string = '';
	private sessions: ChatSession[] = [];
	private currentSessionId: string | null = null;
	private readonly sessionsStorageKey = 'codemate.sessions';
	private readonly currentSessionStorageKey = 'codemate.currentSession';
	private readonly currentModelStorageKey = 'codemate.currentModel';
	private readonly groqModelStorageKey = 'codemate.groqModel';
	private pendingConfirms = new Map<string, (choice: string | null) => void>();
	private agentServiceProcess: import('child_process').ChildProcess | undefined;
	private agentServiceStarting: Promise<boolean> | null = null;

	private resolvePythonCommand(): { cmd: string; args: string[] } {
		const configured = vscode.workspace.getConfiguration('codemate').get<string>('pythonPath');
		const envPath = process.env.CODEMATE_PYTHON || process.env.PYTHON_PATH || process.env.PYTHON;
		const candidate = (configured || envPath || '').trim();
		if (candidate) {
			const parts = candidate.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
			const cleaned = parts.map(part => part.replace(/^"(.*)"$/, '$1'));
			if (cleaned.length > 0) {
				const cmd = cleaned[0];
				if (cmd.includes('\\') || cmd.includes('/')) {
					const fs = require('fs');
					if (fs.existsSync(cmd)) {
						return { cmd, args: cleaned.slice(1) };
					}
					this.output.appendLine(`[Python] Configured pythonPath not found: ${cmd}`);
				} else {
					return { cmd, args: cleaned.slice(1) };
				}
			}
		}
		if (process.platform === 'win32') {
			const pyLauncher = 'C:\\Windows\\py.exe';
			try {
				const fs = require('fs');
				if (fs.existsSync(pyLauncher)) {
					return { cmd: pyLauncher, args: ['-3'] };
				}
			} catch {
				// ignore
			}
			return { cmd: 'py', args: ['-3'] };
		}
		return { cmd: 'python3', args: [] };
	}
	private resolveMcpServerPath(): string | null {
		const fs = require('fs');
		const candidates: string[] = [];
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			candidates.push(path.join(workspaceRoot, 'mcp_server'));
		}
		candidates.push(path.join(this.context.extensionPath, 'mcp_server'));
		candidates.push(path.resolve(this.context.extensionPath, '..', 'mcp_server'));

		for (const candidate of candidates) {
			try {
				const serverPath = path.join(candidate, 'server.py');
				if (fs.existsSync(serverPath)) return candidate;
			} catch {
				// ignore
			}
		}
		return null;
	}

	private resolveMcpEnvPath(): string | null {
		const fs = require('fs');
		const candidates: string[] = [];
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			candidates.push(path.join(workspaceRoot, 'mcp_server', '.env'));
		}
		candidates.push(path.join(this.context.extensionPath, 'mcp_server', '.env'));
		candidates.push(path.resolve(this.context.extensionPath, '..', 'mcp_server', '.env'));

		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) return candidate;
			} catch {
				// ignore
			}
		}
		return null;
	}

	private loadDotEnvVars(): Record<string, string> {
		const envPath = this.resolveMcpEnvPath();
		if (!envPath) return {};
		try {
			const fs = require('fs');
			const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
			const vars: Record<string, string> = {};
			for (const line of lines) {
				const raw = line.trim();
				if (!raw || raw.startsWith('#') || !raw.includes('=')) continue;
				const [k, v] = raw.split('=', 2);
				const key = k?.trim();
				if (!key) continue;
				vars[key] = (v ?? '').trim().replace(/^['"]|['"]$/g, '');
			}
			return vars;
		} catch {
			return {};
		}
	}

	private resolveAgentServicePath(): string | null {
		const fs = require('fs');
		const candidates: string[] = [];
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			candidates.push(path.join(workspaceRoot, 'agents_service.py'));
		}
		candidates.push(path.join(this.context.extensionPath, 'agents_service.py'));
		candidates.push(path.resolve(this.context.extensionPath, '..', 'agents_service.py'));

		for (const candidate of candidates) {
			try {
				if (fs.existsSync(candidate)) return candidate;
			} catch {
				// ignore
			}
		}
		return null;
	}

	constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
		this.context = context;
		this.output = output;

		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor && activeEditor.document.uri.scheme === 'file') {
			this.lastFileEditor = activeEditor;
		}
		this.context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor && editor.document.uri.scheme === 'file') {
					this.lastFileEditor = editor;
				}
			})
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
		};

		view.webview.html = this.getHtml(view.webview);

		view.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case 'init':
					await this.handleInit();
					break;
				case 'sendMessage':
					await this.handleUserMessage(message.content);
					break;
				case 'applyChange':
					await this.handleApplyChange(message.messageId, message.changeIndex);
					break;
				case 'rejectChange':
					await this.handleRejectChange(message.messageId, message.changeIndex);
					break;
				case 'changeModel':
					this.currentModel = message.model;
					void this.context.globalState.update(this.currentModelStorageKey, this.currentModel);
					if (this.currentModel === 'Groq Model' && !this.groqModel) {
						this.postToWebview({ type: 'openSettings' });
					}
					break;
				case 'saveGroqModel':
					this.groqModel = String(message.model || '').trim();
					void this.context.globalState.update(this.groqModelStorageKey, this.groqModel);
					this.postToWebview({ type: 'groqModelSaved', model: this.groqModel });
					break;
				case 'testGroq':
					await this.runGroqTest();
					break;
				case 'refreshGroqModels':
					await this.sendGroqModelsToWebview();
					break;
				case 'newChat':
					this.handleNewChat();
					break;
				case 'clearHistory':
					await this.handleClearHistory();
					break;
				case 'selectSession':
					this.handleSelectSession(message.sessionId);
					break;
				case 'runGithubFlow':
					await this.runGithubManagerFlow();
					break;
				case 'confirmResult':
					{
						const resolver = this.pendingConfirms.get(message.id);
						if (resolver) {
							this.pendingConfirms.delete(message.id);
							resolver(message.choice ?? null);
						}
					}
					break;
			}
		});
	}

	// NEW: Enhanced error detection
	private detectErrorType(content: string): {
		hasError: boolean;
		errorType: 'traceback' | 'exception' | 'syntax' | 'runtime' | null;
		errorDetails?: {
			errorName?: string;
			lineNumber?: number;
			file?: string;
			missingAttribute?: string;
		};
	} {
		const text = content.toLowerCase();
		
		// Python traceback patterns
		if (content.includes('Traceback (most recent call last)') || 
		    /File ".*", line \d+/i.test(content)) {
			const errorMatch = content.match(/(\w+Error):/);
			const lineMatch = content.match(/line (\d+)/i);
			const fileMatch = content.match(/File "([^"]+)"/);
			const missingAttrMatch = content.match(/has no attribute '([^']+)'/i);
			
			return {
				hasError: true,
				errorType: 'traceback',
				errorDetails: {
					errorName: errorMatch?.[1],
					lineNumber: lineMatch ? parseInt(lineMatch[1]) : undefined,
					file: fileMatch?.[1],
					missingAttribute: missingAttrMatch?.[1]
				}
			};
		}

		// JavaScript/TypeScript errors
		if (content.includes('Error:') || content.includes('ReferenceError') || 
		    content.includes('TypeError') || content.includes('SyntaxError')) {
			return {
				hasError: true,
				errorType: 'exception'
			};
		}

		// Generic error patterns
		if (/error|exception|failed|crash|bug/i.test(text) && 
		    (text.includes('at line') || text.includes('on line') || /:\d+:\d+/.test(content))) {
			return {
				hasError: true,
				errorType: 'runtime'
			};
		}

		return { hasError: false, errorType: null };
	}

	// NEW: Enhanced request classification with error detection
	private classifyRequest(request: string, editor?: vscode.TextEditor): {
		propose: boolean;
		replaceAll: boolean;
		mode: 'fix' | 'change' | 'insert' | 'explain';
		errorDetails?: { missingAttribute?: string };
	} {
		const text = request.toLowerCase();
		
		// FIRST: Check for errors (highest priority)
		const errorDetection = this.detectErrorType(request);
		if (errorDetection.hasError) {
			return {
				propose: true,
				replaceAll: true,
				mode: 'fix',
				errorDetails: { missingAttribute: errorDetection.errorDetails?.missingAttribute }
			};
		}

		// Then check for explicit keywords
		const changeKeywords = ['edit', 'update', 'fix', 'refactor', 'rewrite', 'replace', 'debug', 'cleanup', 'optimize', 'improve', 'format', 'correct'];
		const insertKeywords = ['add', 'create', 'generate', 'write', 'implement', 'insert', 'append', 'scaffold', 'draft'];
		const explainKeywords = ['explain', 'why', 'what does', 'how does', 'describe', 'review', 'summarize', 'understand', 'clarify', 'tell me'];

		const wantsChange = changeKeywords.some(keyword => text.includes(keyword));
		const wantsInsert = insertKeywords.some(keyword => text.includes(keyword));
		const wantsExplain = explainKeywords.some(keyword => text.includes(keyword));

		if (wantsExplain && !wantsChange && !wantsInsert) {
			return { propose: false, replaceAll: false, mode: 'explain' };
		}

		if (wantsChange) {
			return { propose: true, replaceAll: true, mode: 'change' };
		}

		if (wantsInsert) {
			return { propose: true, replaceAll: false, mode: 'insert' };
		}

		return { propose: false, replaceAll: false, mode: 'explain' };
	}

	// NEW: Build prompt based on mode
	private buildSystemPrompt(
		mode: 'fix' | 'change' | 'insert' | 'explain',
		hasFileContext: boolean,
		errorDetails?: { missingAttribute?: string }
	): string {
		if (mode === 'fix') {
			const avoidAttr = errorDetails?.missingAttribute
				? `Do NOT use the missing attribute name "${errorDetails.missingAttribute}".`
				: '';
			return [
				'You are an expert debugging assistant.',
				'The user has encountered an error in their code.',
				'CRITICAL: You MUST provide the corrected code in a markdown code block.',
				'DO NOT just explain what\'s wrong - FIX IT and return the complete corrected code.',
				'Format: ```language\n[complete fixed code]\n```',
				'Be concise in your explanation before the code block.',
				avoidAttr
			].filter(Boolean).join(' ');
		}

		if (mode === 'change' && hasFileContext) {
			return [
				'You are an expert code editor.',
				'The user wants to modify existing code.',
				'Respond with the complete modified code in a markdown code block.',
				'Format: ```language\n[complete modified code]\n```',
				'Keep unrelated parts of the code unchanged.'
			].join(' ');
		}

		if (mode === 'insert' && hasFileContext) {
			return [
				'You are an expert code generator.',
				'Generate the requested code and return it in a markdown code block.',
				'Format: ```language\n[generated code]\n```',
				'Make sure the code integrates well with the existing context.'
			].join(' ');
		}

		return 'You are a helpful coding assistant. Answer questions clearly and concisely.';
	}

	private getEffectiveEditor(): vscode.TextEditor | undefined {
		const active = vscode.window.activeTextEditor;
		if (active && active.document.uri.scheme === 'file') return active;
		if (this.lastFileEditor && this.lastFileEditor.document.uri.scheme === 'file') return this.lastFileEditor;
		return undefined;
	}
	private async handleUserMessage(content: string): Promise<void> {
		if (!content.trim()) return;
		this.ensureSessionsLoaded();

		const session = this.getCurrentSession();
		const editor = this.getEffectiveEditor();
		
		// Create user message
		const userMessage: ChatMessage = {
			id: this.generateId(),
			role: 'user',
			content,
			timestamp: Date.now(),
			fileContext: editor ? {
				path: vscode.workspace.asRelativePath(editor.document.uri),
				language: editor.document.languageId,
				selection: !editor.selection.isEmpty ? {
					start: editor.document.offsetAt(editor.selection.start),
					end: editor.document.offsetAt(editor.selection.end)
				} : undefined
			} : undefined
		};

		session.messages.push(userMessage);
		this.updateSessionMetadata(session, userMessage.content);
		this.postToWebview({ type: 'messageAdded', message: userMessage });

		// Manager flow: file creation (with optional git actions)
		if (this.isFileCreateRequest(content)) {
			const assistantMessage: ChatMessage = {
				id: this.generateId(),
				role: 'assistant',
				content: '',
				timestamp: Date.now(),
				thinking: 'Preparing to generate file and git actions...'
			};
			session.messages.push(assistantMessage);
			this.postToWebview({ type: 'messageAdded', message: assistantMessage });
			await this.runFileAndGitFlowFromChat(content, assistantMessage);
			return;
		}

		// Manager flow: detect GitHub automation intent in chat
		if (this.isGithubAutomationRequest(content)) {
			const assistantMessage: ChatMessage = {
				id: this.generateId(),
				role: 'assistant',
				content: '',
				timestamp: Date.now(),
				thinking: 'Coordinating agents for README + commit + push...'
			};
			session.messages.push(assistantMessage);
			this.postToWebview({ type: 'messageAdded', message: assistantMessage });
			await this.runGithubManagerFlowFromChat(assistantMessage, userMessage.content);
			return;
		}

		// Create assistant message placeholder
		const assistantMessage: ChatMessage = {
			id: this.generateId(),
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			thinking: 'Analyzing your request...'
		};

		session.messages.push(assistantMessage);
		this.updateSessionMetadata(session);
		this.postToWebview({ type: 'messageAdded', message: assistantMessage });

		// Generate response
		await this.generateResponse(assistantMessage, userMessage, editor);
	}

	private async generateResponse(
		assistantMessage: ChatMessage,
		userMessage: ChatMessage,
		editor: vscode.TextEditor | undefined
	): Promise<void> {
		if (!this.currentModel) {
			assistantMessage.content = 'No model selected. Please select a model from the settings.';
			assistantMessage.thinking = undefined;
			this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
			return;
		}

		try {
			// Classify the request (includes error detection)
			const classification = this.classifyRequest(userMessage.content, editor);
			
			// Build context
			let contextText = '';
			if (editor) {
				const selection = editor.selection;
				const selectedText = !selection.isEmpty ? editor.document.getText(selection) : '';
				const fullText = editor.document.getText();
				contextText = selectedText || fullText.slice(0, 4000);
			}

			// Build system prompt based on classification
			const systemPrompt = this.buildSystemPrompt(classification.mode, !!editor, classification.errorDetails);
			
			// Build user prompt
			const prompt = this.buildUserPrompt(
				userMessage.content,
				contextText,
				userMessage.fileContext,
				classification.mode
			);

			// Update thinking message based on mode
			if (classification.mode === 'fix') {
				assistantMessage.thinking = 'Analyzing error and preparing fix...';
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
			}

			if (this.currentModel === 'Groq Model') {
				this.output.appendLine('[Groq] Sending chat completion request...');
				const groqContent = await this.callGroqChat(systemPrompt, prompt);
				this.output.appendLine(`[Groq] Response length: ${groqContent.length}`);
				let finalContent = groqContent || 'Groq returned an empty response.';
				// If Groq returns raw code without fences, wrap it so Apply/Reject can work
				if (!/```[\s\S]*?```/.test(finalContent) && classification.propose) {
					const lang = editor?.document.languageId || 'text';
					finalContent = `\`\`\`${lang}\n${finalContent.trim()}\n\`\`\``;
					this.output.appendLine(`[Groq] Wrapped response in ${lang} code fence`);
				}
				assistantMessage.content = finalContent;
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				// Propose changes if needed (same as Ollama flow)
				if (classification.propose && editor) {
					this.output.appendLine(`[Groq] Calling extractAndProposeChanges for message ${assistantMessage.id}`);
					this.extractAndProposeChanges(assistantMessage, editor, classification.replaceAll);
				} else {
					this.output.appendLine(`[Groq] Skipping extractAndProposeChanges - propose: ${classification.propose}, editor: ${!!editor}`);
				}
			} else {
				// Stream the response
				await this.streamOllamaResponse(
					this.currentModel,
					prompt,
					systemPrompt,
					assistantMessage,
					editor,
					classification
				);
			}
			
			// Validate fix responses and retry once if needed
			if (classification.mode === 'fix') {
				const hasCode = this.responseHasCodeBlock(assistantMessage.content);
				const usesMissingAttr = this.responseUsesMissingAttribute(
					assistantMessage.content,
					classification.errorDetails?.missingAttribute
				);
				if (!hasCode || usesMissingAttr) {
					assistantMessage.content = '';
					assistantMessage.thinking = 'Retrying with stricter fix...';
					this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
					const retryPrompt = this.buildSystemPrompt('fix', !!editor, classification.errorDetails) +
						' STRICT: Return only a single code block. No extra text.';
					await this.streamOllamaResponse(
						this.currentModel,
						prompt,
						retryPrompt,
						assistantMessage,
						editor,
						classification
					);
				}
			}

		} catch (error) {
			assistantMessage.content = `Error: ${String(error)}`;
			assistantMessage.thinking = undefined;
			this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
		}
	}

	private isFileCreateRequest(content: string): boolean {
		const text = content.toLowerCase();
		return /create|make|write|generate/.test(text) && /\.\w{1,6}\b/.test(text);
	}

	private getGitIntent(content: string): { wantsCommit: boolean; wantsPush: boolean } {
		const text = content.toLowerCase();
		const wantsCommit = text.includes('commit');
		const wantsPush = text.includes('push') || text.includes('github') || text.includes('repo');
		return { wantsCommit, wantsPush };
	}

	private isGithubAutomationRequest(content: string): boolean {
		const text = content.toLowerCase();
		const wantsReadme = text.includes('readme');
		const wantsCommit = text.includes('commit');
		const wantsPush = text.includes('push') || text.includes('publish');
		const wantsAdd = /\badd\b/.test(text) || text.includes('stage') || text.includes('git add');
		const mentionsGitHost = /(github|git hub|githb|githu|githug|gitlab|bitbucket|repo|repository)/.test(text);
		const mentionsGit = /\bgit\b/.test(text);
		const wantsGitOps = wantsCommit || wantsPush || wantsReadme || wantsAdd;
		return wantsGitOps && (mentionsGitHost || mentionsGit || wantsCommit || wantsPush);
	}

	private async runFileAndGitFlowFromChat(request: string, assistantMessage: ChatMessage): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				assistantMessage.content = 'No workspace folder found. Open the project folder first.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const fileName = this.extractFileName(request);
			const targetFile = fileName ? path.join(repoPath, fileName) : path.join(repoPath, 'test.py');

			const model = this.currentModel || 'qwen2.5-coder:1.5b';
			const code = await this.ollamaGenerateCode(model, request, targetFile);
			if (!code.trim()) {
				assistantMessage.content = 'Model did not return code.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			const preview = code.length > 500 ? `${code.slice(0, 500)}\n...` : code;
			const confirm = await this.requestSidebarConfirm(
				`Create/overwrite ${targetFile} with generated code?`,
				preview,
				['Yes', 'No']
			);
			if (confirm !== 'Yes') {
				assistantMessage.content = 'Cancelled. No files were written.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), Buffer.from(code, 'utf8'));

			const intent = this.getGitIntent(request);
			let gitAction: 'Commit+Push' | 'Commit only' | 'None' = 'None';
			if (intent.wantsPush) {
				gitAction = 'Commit+Push';
			} else if (intent.wantsCommit) {
				gitAction = 'Commit only';
			}

			if (gitAction === 'None') {
				assistantMessage.content = `Created ${path.basename(targetFile)}.`;
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			const confirmAction = await this.requestSidebarConfirm(
				'Commit and push the changes to GitHub?',
				'Choose an action:',
				['Commit+Push', 'Commit only', 'Cancel']
			);
			if (!confirmAction || confirmAction === 'Cancel') {
				assistantMessage.content = `Created ${path.basename(targetFile)}. Git actions skipped.`;
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			if (confirmAction === 'Commit only') {
				gitAction = 'Commit only';
			} else {
				gitAction = 'Commit+Push';
			}

			const commitRes = await this.callMcpTool('git_commit', {
				repo_path: repoPath,
				message: `feat: add ${path.basename(targetFile)}`
			});
			if (!commitRes?.ok) {
				assistantMessage.content = 'MCP git_commit failed.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			if (gitAction === 'Commit+Push') {
				const pushRes = await this.callMcpTool('git_push', {
					repo_path: repoPath,
					remote: 'origin',
					branch: 'main'
				});
				if (!pushRes?.ok) {
					assistantMessage.content = 'MCP git_push failed.';
					assistantMessage.thinking = undefined;
					this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
					return;
				}
			}

			assistantMessage.content = `Created ${path.basename(targetFile)}, committed${gitAction === 'Commit+Push' ? ' and pushed' : ''} successfully.`;
			assistantMessage.thinking = undefined;
			this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
		} catch (error) {
			assistantMessage.content = `File+Git flow error: ${String(error)}`;
			assistantMessage.thinking = undefined;
			this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
		}
	}

	private async requestSidebarConfirm(
		title: string,
		detail: string,
		choices: string[]
	): Promise<string | null> {
		const id = this.generateId();
		this.postToWebview({
			type: 'confirmAction',
			id,
			title,
			detail,
			choices
		});
		return await new Promise((resolve) => {
			this.pendingConfirms.set(id, resolve);
		});
	}

	private extractFileName(request: string): string | null {
		const match = request.match(/[\w.\-]+\.\w{1,6}/);
		return match ? match[0] : null;
	}

	private async ollamaGenerateCode(model: string, request: string, filePath: string): Promise<string> {
		if (model === 'Groq Model') {
			return await this.callGroqChat(
				'You are a code generator. Output ONLY the code for the file. No explanations. No markdown.',
				[
					`Write the full contents of a file named ${path.basename(filePath)}.`,
					`User request: ${request}`,
					'Return ONLY code. No explanations. No markdown. No backticks.'
				].join('\n')
			);
		}
		const prompt = [
			`Write the full contents of a file named ${path.basename(filePath)}.`,
			`User request: ${request}`,
			'Return ONLY code. No explanations. No markdown. No backticks.'
		].join('\n');

		const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				system: 'You are a code generator. Output ONLY the code for the file. No explanations. No markdown.',
				prompt,
				stream: false,
				options: { temperature: 0.2, num_predict: 800 }
			})
		});
		if (!response.ok) return '';
		const data = await response.json() as { response?: string };
		let output = (data.response || '').trim();

		// Guardrails: strip markdown/code fences if any leaked in
		output = output.replace(/```[\s\S]*?```/g, (match) => {
			return match.replace(/```[a-zA-Z]*\n?/, '').replace(/```$/, '');
		}).trim();

		// Basic sanity check: if it looks like explanation, retry once with stricter prompt
		if (!output || /explain|sorry|cannot|i can|i'm/i.test(output.slice(0, 200))) {
			const retry = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					system: 'STRICT: Return only raw code. If you include any explanation, the output is invalid.',
					prompt,
					stream: false,
					options: { temperature: 0.1, num_predict: 800 }
				})
			});
			if (!retry.ok) return output;
			const retryData = await retry.json() as { response?: string };
			let retryOut = (retryData.response || '').trim();
			retryOut = retryOut.replace(/```[\s\S]*?```/g, (match) => {
				return match.replace(/```[a-zA-Z]*\n?/, '').replace(/```$/, '');
			}).trim();
			return retryOut || output;
		}

		return output;
	}

	private async callGroqChat(system: string, prompt: string): Promise<string> {
		const apiKey = this.loadGroqApiKey();
		if (!apiKey) {
			throw new Error('GROQ_API_KEY not set');
		}
		if (!this.groqModel) {
			throw new Error('Groq model not set');
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 20000);
		const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: this.groqModel,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: prompt }
				],
				temperature: 0.2
			}),
			signal: controller.signal
		}).finally(() => clearTimeout(timeout));
		if (!response.ok) {
			const errText = await response.text();
			this.output.appendLine(`Groq API error: ${response.status} ${errText}`);
			throw new Error(`Groq API error: ${response.status} ${errText}`);
		}
		const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
		const content = data.choices?.[0]?.message?.content?.trim() || '';
		if (!content) {
			this.output.appendLine('Groq API returned empty content.');
		}
		return content;
	}

	private loadGroqApiKey(): string | null {
		const configured = vscode.workspace.getConfiguration('codemate').get<string>('groqApiKey');
		if (configured?.trim()) return configured.trim();
		if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
		const envVars = this.loadDotEnvVars();
		if (envVars.GROQ_API_KEY) return envVars.GROQ_API_KEY;
		return null;
	}


	private loadGithubOwnerName(): string | null {
		if (process.env.GITHUB_OWNER_NAME) return process.env.GITHUB_OWNER_NAME;
		const envVars = this.loadDotEnvVars();
		if (envVars.GITHUB_OWNER_NAME) return envVars.GITHUB_OWNER_NAME;
		return null;
	}


	private async isGitRepo(repoPath: string): Promise<boolean> {
		try {
			const { exec } = await import('child_process');
			return await new Promise((resolve) => {
				exec(`git -C "${repoPath}" rev-parse --is-inside-work-tree`, (err, stdout) => {
					if (err) return resolve(false);
					resolve(stdout.trim() === 'true');
				});
			});
		} catch {
			return false;
		}
	}

	private async ensureGitRemote(repoPath: string, url: string): Promise<void> {
		try {
			const { exec } = await import('child_process');
			await new Promise((resolve) => {
				exec(`git -C "${repoPath}" remote get-url origin`, (err) => {
					if (!err) return resolve(null);
					exec(`git -C "${repoPath}" remote add origin "${url}"`, () => resolve(null));
				});
			});
		} catch {
			// ignore
		}
	}

	private async generateCommitAndDescription(
		request: string,
		gitStatus: string
	): Promise<{ commitMessage: string; description: string }> {
		const fallback = {
			commitMessage: 'chore: update project',
			description: 'Updates pushed via CodeMate manager'
		};
		if (!this.currentModel) return fallback;

		const system = 'You generate concise git commit messages and GitHub repo descriptions.';
		const prompt = [
			'Return ONLY JSON with keys: commit, description.',
			'Rules:',
			'- commit: max 72 chars, conventional commit style if possible.',
			'- description: max 120 chars, plain text.',
			'',
			`User request: ${request}`,
			gitStatus ? `Git status:\n${gitStatus}` : ''
		].filter(Boolean).join('\n');

		try {
			let raw = '';
			if (this.currentModel === 'Groq Model') {
				raw = await this.callGroqChat(system, prompt);
			} else {
				const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: this.currentModel,
						system,
						prompt,
						stream: false,
						options: { temperature: 0.2, num_predict: 120 }
					})
				});
				if (response.ok) {
					const data = await response.json() as { response?: string };
					raw = (data.response || '').trim();
				}
			}

			const jsonMatch = raw.match(/\{[\s\S]*\}/);
			const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
			let commit = String(parsed.commit || parsed.message || parsed.commitMessage || '').trim();
			let description = String(parsed.description || parsed.repoDescription || '').trim();

			commit = commit.replace(/\s+/g, ' ').trim();
			description = description.replace(/\s+/g, ' ').trim();

			if (!commit) commit = fallback.commitMessage;
			if (commit.length > 72) commit = commit.slice(0, 72).trim();
			if (!description) description = fallback.description;
			if (description.length > 120) description = description.slice(0, 120).trim();

			return { commitMessage: commit, description };
		} catch {
			return fallback;
		}
	}

	private async generateReadmeFallback(
		repoPath: string,
		request: string,
		gitStatus: string
	): Promise<boolean> {
		if (!this.currentModel) return false;
		const fs = require('fs');
		const readmePath = path.join(repoPath, 'README.md');
		let existing = '';
		try {
			if (fs.existsSync(readmePath)) {
				existing = fs.readFileSync(readmePath, 'utf8');
			}
		} catch {
			existing = '';
		}

		const system = 'You are an expert technical writer. Update or create README.md. Return ONLY markdown.';
		const prompt = [
			'Task: Update README.md for this repository.',
			'Return ONLY markdown. No code fences.',
			`User request: ${request}`,
			gitStatus ? `Git status:\n${gitStatus}` : '',
			existing ? `Existing README (truncated):\n${existing.slice(0, 4000)}` : 'No README exists yet.'
		].filter(Boolean).join('\n');

		try {
			let output = '';
			if (this.currentModel === 'Groq Model') {
				output = await this.callGroqChat(system, prompt);
			} else {
				const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: this.currentModel,
						system,
						prompt,
						stream: false,
						options: { temperature: 0.2, num_predict: 1200 }
					})
				});
				if (response.ok) {
					const data = await response.json() as { response?: string };
					output = (data.response || '').trim();
				}
			}

			if (!output.trim()) return false;
			await vscode.workspace.fs.writeFile(vscode.Uri.file(readmePath), Buffer.from(output.trim(), 'utf8'));
			return true;
		} catch {
			return false;
		}
	}

	private async sendGroqModelsToWebview(): Promise<void> {
		const apiKey = this.loadGroqApiKey();
		if (!apiKey) {
			this.postToWebview({ type: 'groqModelsLoaded', models: [] });
			return;
		}
		try {
			const response = await fetch('https://api.groq.com/openai/v1/models', {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				}
			});
			if (!response.ok) {
				this.postToWebview({ type: 'groqModelsLoaded', models: [] });
				return;
			}
			const data = await response.json() as { data?: Array<{ id?: string }> };
			const models = (data.data ?? []).map(m => m.id).filter(Boolean) as string[];
			this.postToWebview({ type: 'groqModelsLoaded', models });
		} catch {
			this.postToWebview({ type: 'groqModelsLoaded', models: [] });
		}
	}

	private async runGroqTest(): Promise<void> {
		try {
			const result = await this.callGroqChat(
				'You are a test assistant. Reply with a single short sentence.',
				'Reply with the word OK and a short timestamp.'
			);
			this.postToWebview({ type: 'groqTestResult', ok: true, message: result });
		} catch (error) {
			this.postToWebview({ type: 'groqTestResult', ok: false, message: String(error) });
		}
	}

	private async runGithubManagerFlowFromChat(assistantMessage: ChatMessage, request: string): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				assistantMessage.content = 'No workspace folder found. Open the project folder first.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const isRepo = await this.isGitRepo(repoPath);
			if (!isRepo) {
				assistantMessage.content = 'This folder is not a git repo. Initialize git and add a remote first.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			const statusRes = await this.callMcpTool('git_status', { repo_path: repoPath });
			const statusText = typeof statusRes?.data?.stdout === 'string' ? statusRes.data.stdout : '';
			if (!statusText.trim()) {
				assistantMessage.content = 'No changes detected to commit.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}
			const { commitMessage, description } = await this.generateCommitAndDescription(request, statusText);

			const wantsReadme = /readme/i.test(request);
			if (wantsReadme) {
				let readmeOk = false;
				try {
					const projectName = path.basename(repoPath);
					const summary = 'Auto-generated README for the current project.';
					const bullets = [
						'Automated README generation via CodeMate agents',
						'Commit and push orchestrated by manager flow',
						'GitHub repo metadata updated via MCP'
					];

					const readmeResult = await this.callAgentService({
						agent: 'ReadmeAgent',
						task: 'generate_readme',
						project_name: projectName,
						summary,
						bullets,
						repo_path: repoPath,
						write: true,
						model: 'qwen2.5-coder:1.5b'
					});
					readmeOk = !!readmeResult && readmeResult.status === 'success';
				} catch (err) {
					this.output.appendLine(`[ReadmeAgent] ${String(err)}`);
					readmeOk = false;
				}

				if (!readmeOk) {
					readmeOk = await this.generateReadmeFallback(repoPath, request, statusText);
				}

				if (!readmeOk) {
					assistantMessage.content = 'README update failed. Start the agent service (http://127.0.0.1:7001) or check your model connection.';
					assistantMessage.thinking = undefined;
					this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
					return;
				}
			}

			let remoteUrl = await this.getGitRemoteUrl(repoPath);
			let owner: string | null = null;
			let repo: string | null = null;

			if (remoteUrl) {
				const parsed = this.parseGitHubRemote(remoteUrl);
				owner = parsed.owner;
				repo = parsed.repo;
				if (!owner || !repo) {
					assistantMessage.content = `Unrecognized GitHub remote: ${remoteUrl}`;
					assistantMessage.thinking = undefined;
					this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
					return;
				}
			} else {
				repo = path.basename(repoPath);
				owner = this.loadGithubOwnerName();

				const createRes = await this.callMcpTool('github_create_repo', {
					name: repo,
					private: false,
					dry_run: false,
					description
				});

				if (createRes?.ok) {
					const full = createRes?.data?.full_name;
					if (typeof full === 'string' && full.includes('/')) {
						const parts = full.split('/');
						owner = parts[0];
						repo = parts[1];
					}
				}

				if (!owner || !repo) {
					assistantMessage.content = 'Could not resolve GitHub owner/repo. Set GITHUB_OWNER_NAME in mcp_server/.env or add an origin remote.';
					assistantMessage.thinking = undefined;
					this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
					return;
				}

				const githubUrl = `https://github.com/${owner}/${repo}.git`;
				await this.ensureGitRemote(repoPath, githubUrl);
				remoteUrl = githubUrl;
			}

			const commitRes = await this.callMcpTool('git_commit', {
				repo_path: repoPath,
				message: commitMessage
			});
			if (!commitRes?.ok) {
				assistantMessage.content = 'MCP git_commit failed.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			const pushRes = await this.callMcpTool('git_push', {
				repo_path: repoPath,
				remote: 'origin',
				branch: 'main'
			});
			if (!pushRes?.ok) {
				assistantMessage.content = 'MCP git_push failed.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			const descRes = await this.callMcpTool('github_update_description', {
				owner,
				repo,
				description,
				dry_run: false
			});
			if (!descRes?.ok) {
				assistantMessage.content = 'MCP github_update_description failed.';
				assistantMessage.thinking = undefined;
				this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
				return;
			}

			assistantMessage.content = `Done. Committed (${commitMessage}) and pushed to https://github.com/${owner}/${repo}. Description updated.`;
			assistantMessage.thinking = undefined;
			this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
		} catch (error) {
			assistantMessage.content = `GitHub manager flow error: ${String(error)}`;
			assistantMessage.thinking = undefined;
			this.postToWebview({ type: 'messageUpdated', message: assistantMessage });
		}
	}

	private async getGitRemoteUrl(repoPath: string): Promise<string | null> {
		try {
			const { exec } = await import('child_process');
			return await new Promise((resolve) => {
				exec(`git -C "${repoPath}" config --get remote.origin.url`, (err, stdout) => {
					if (err) return resolve(null);
					const url = stdout.trim();
					resolve(url || null);
				});
			});
		} catch {
			return null;
		}
	}

	private parseGitHubRemote(remoteUrl: string): { owner: string | null; repo: string | null } {
		let url = remoteUrl.trim();
		if (url.startsWith('git@')) {
			// git@github.com:owner/repo.git
			const match = url.match(/git@github.com:(.+)\/(.+?)(\.git)?$/);
			if (match) return { owner: match[1], repo: match[2] };
		}
		if (url.startsWith('https://')) {
			// https://github.com/owner/repo.git
			const match = url.match(/https:\/\/github.com\/(.+)\/(.+?)(\.git)?$/);
			if (match) return { owner: match[1], repo: match[2] };
		}
		return { owner: null, repo: null };
	}

	private responseHasCodeBlock(content: string): boolean {
		return /```[\s\S]*?```/.test(content);
	}

	private responseUsesMissingAttribute(content: string, missingAttribute?: string): boolean {
		if (!missingAttribute) return false;
		return content.includes(missingAttribute);
	}

	private buildUserPrompt(
		userContent: string,
		context: string,
		fileContext: ChatMessage['fileContext'],
		mode: 'fix' | 'change' | 'insert' | 'explain'
	): string {
		let prompt = '';
		
		if (fileContext) {
			prompt += `File: ${fileContext.path}\n`;
			prompt += `Language: ${fileContext.language}\n\n`;
		}

		if (context) {
			if (mode === 'fix') {
				prompt += `Current code:\n\`\`\`\n${context}\n\`\`\`\n\n`;
				prompt += `Error encountered:\n${userContent}\n\n`;
				prompt += `Please provide the COMPLETE FIXED CODE in a markdown code block. Do not just explain - fix it and return the corrected code.`;
			} else {
				prompt += `Context:\n${context}\n\n`;
				prompt += `Request: ${userContent}`;
			}
		} else {
			prompt += `Request: ${userContent}`;
		}

		return prompt;
	}

	private async streamOllamaResponse(
		model: string,
		prompt: string,
		system: string,
		message: ChatMessage,
		editor: vscode.TextEditor | undefined,
		classification: { propose: boolean; replaceAll: boolean; mode: string }
	): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				const url = new URL(`${OLLAMA_BASE_URL}/api/generate`);
				const payload = JSON.stringify({
					model,
					prompt,
					system,
					stream: true,
					options: { temperature: 0.2, num_predict: 2048 }
				});

				const request = http.request(
					{
						method: 'POST',
						hostname: url.hostname,
						port: url.port || 80,
						path: url.pathname,
						headers: {
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(payload)
						}
					},
					(response) => {
						let buffer = '';

						response.on('data', (chunk) => {
							buffer += chunk.toString();
							const lines = buffer.split('\n');
							buffer = lines.pop() || '';

							for (const line of lines) {
								if (!line.trim()) continue;
								try {
									const data = JSON.parse(line);
									if (data.response) {
										message.content += data.response;
										message.thinking = undefined;
										
										this.postToWebview({
											type: 'messageUpdated',
											message: {
												...message,
												content: message.content
											}
										});
									}
								} catch (e) {
									// Ignore parse errors
								}
							}
						});

						response.on('end', () => {
							// Extract code blocks and create change proposals
							if (classification.propose && editor) {
								this.extractAndProposeChanges(message, editor, classification.replaceAll);
							}
							this.persistSessions();
							resolve();
						});

						response.on('error', reject);
					}
				);

				request.on('error', reject);
				request.write(payload);
				request.end();
			} catch (error) {
				reject(error);
			}
		});
	}

	private extractAndProposeChanges(message: ChatMessage, editor: vscode.TextEditor, replaceAllDefault: boolean): void {
		// More flexible regex to handle different line ending formats
		const codeBlockRegex = /```([^\s`]+)?[\s\r\n]+([\s\S]*?)```/g;
		let matches = [...message.content.matchAll(codeBlockRegex)];

		this.output.appendLine(`[extractAndProposeChanges] Message ${message.id}: Found ${matches.length} code blocks`);

		// Use the last code block if multiple exist
		if (matches.length > 1) {
			this.output.appendLine(`[extractAndProposeChanges] Multiple code blocks found, using the last one`);
			matches = [matches[matches.length - 1]];
		}

		if (matches.length > 0) {
			const replaceAll = replaceAllDefault && editor.selection.isEmpty;
			message.codeChanges = matches.map((match, idx) => {
				const originalCode = editor.selection.isEmpty
					? editor.document.getText()
					: editor.document.getText(editor.selection);
				const newCode = match[2].trim();
				const diff = this.buildDiffLines(originalCode, newCode);

				this.output.appendLine(`[extractAndProposeChanges] Code change ${idx}: ${newCode.length} chars, replaceAll: ${replaceAll}`);

				return {
					file: vscode.workspace.asRelativePath(editor.document.uri),
					originalCode,
					newCode,
					applied: false,
					replaceAll,
					diff
				};
			});

			this.output.appendLine(`[extractAndProposeChanges] Created ${message.codeChanges.length} code changes for message ${message.id}`);
			this.postToWebview({ type: 'messageUpdated', message });
			this.persistSessions();
		} else {
			this.output.appendLine(`[extractAndProposeChanges] No code blocks matched - code may be inline text`);
		}
	}

		private async handleApplyChange(messageId: string, changeIndex: number): Promise<void> {
		const message = this.findMessageById(messageId);

		this.output.appendLine(`[ApplyChange] Request: messageId=${messageId}, changeIndex=${changeIndex}`);
		this.output.appendLine(`[ApplyChange] State: message found=${!!message}, has codeChanges=${!!message?.codeChanges}, changes count=${message?.codeChanges?.length ?? 0}`);

		if (!message || !message.codeChanges || !message.codeChanges[changeIndex]) {
			this.output.appendLine(`[ApplyChange] FAILED - Cannot apply change`);
			if (!message) {
				this.output.appendLine(`[ApplyChange] Message with ID ${messageId} not found in any session`);
				vscode.window.showErrorMessage('Message not found. This might be a session sync issue.');
			} else if (!message.codeChanges) {
				this.output.appendLine(`[ApplyChange] Message ${messageId} has no codeChanges array`);
				this.output.appendLine(`[ApplyChange] Message content preview: ${message.content.substring(0, 200)}...`);
				vscode.window.showErrorMessage('No code changes found. The code block may not have been detected properly.');
			} else if (!message.codeChanges[changeIndex]) {
				this.output.appendLine(`[ApplyChange] Change index ${changeIndex} out of range (have ${message.codeChanges.length} changes)`);
				vscode.window.showErrorMessage(`Invalid change index: ${changeIndex}`);
			}
			return;
		}

		const change = message.codeChanges[changeIndex];
		this.output.appendLine(`[ApplyChange] Change details: file=${change.file}, replaceAll=${change.replaceAll}, codeLength=${change.newCode.length}`);

		let editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme !== 'file') {
			editor = undefined;
		}

		if (!editor) {
			this.output.appendLine(`[ApplyChange] No active editor, attempting to open file ${change.file}`);
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			const isAbsolute = /^[a-zA-Z]:\\/.test(change.file) || change.file.startsWith('/');
			if (!workspaceFolder && !isAbsolute) {
				vscode.window.showErrorMessage('No active editor and no workspace folder');
				return;
			}
			const targetUri = isAbsolute
				? vscode.Uri.file(change.file)
				: vscode.Uri.joinPath(workspaceFolder!.uri, change.file);
			try {
				const doc = await vscode.workspace.openTextDocument(targetUri);
				editor = await vscode.window.showTextDocument(doc, { preview: false });
				this.output.appendLine(`[ApplyChange] Opened file successfully`);
			} catch (err) {
				this.output.appendLine(`[ApplyChange] Failed to open file: ${err}`);
				vscode.window.showErrorMessage(`Failed to open file: ${change.file}`);
				return;
			}
		}

		this.output.appendLine(`[ApplyChange] Applying change ${changeIndex} to ${change.file}`);
		const applied = await editor.edit(editBuilder => {
			if (change.replaceAll) {
				const start = new vscode.Position(0, 0);
				const lastLine = editor.document.lineAt(Math.max(0, editor.document.lineCount - 1));
				editBuilder.replace(new vscode.Range(start, lastLine.range.end), change.newCode);
			} else if (editor.selection.isEmpty) {
				editBuilder.insert(editor.selection.active, change.newCode);
			} else {
				editBuilder.replace(editor.selection, change.newCode);
			}
		});

		if (!applied) {
			this.output.appendLine(`[ApplyChange] Editor edit returned false for ${change.file}`);
			vscode.window.showErrorMessage('Failed to apply change in editor');
			return;
		}

		this.output.appendLine(`[ApplyChange] Change applied successfully`);
		change.applied = true;
		this.postToWebview({ type: 'messageUpdated', message });
		this.persistSessions();
		vscode.window.showInformationMessage('Changes applied');
	}

	private async handleRejectChange(messageId: string, changeIndex: number): Promise<void> {
		const message = this.findMessageById(messageId);
		if (!message || !message.codeChanges) return;

		message.codeChanges.splice(changeIndex, 1);
		this.postToWebview({ type: 'messageUpdated', message });
		this.persistSessions();
	}

	// Session management methods
	private ensureSessionsLoaded(): void {
		const stored = this.context.globalState.get<ChatSession[]>(this.sessionsStorageKey);
		if (stored && Array.isArray(stored)) {
			this.sessions = stored;
		}
		const storedCurrent = this.context.globalState.get<string>(this.currentSessionStorageKey);
		if (storedCurrent && this.sessions.some(s => s.id === storedCurrent)) {
			this.currentSessionId = storedCurrent;
		}
		if (!this.currentSessionId && this.sessions.length > 0) {
			this.currentSessionId = this.sessions[0].id;
		}
	}

	private getCurrentSession(): ChatSession {
		this.ensureSessionsLoaded();
		let session = this.sessions.find(item => item.id === this.currentSessionId);
		if (!session) {
			session = this.createNewSession();
			this.sessions.unshift(session);
			this.currentSessionId = session.id;
		}
		return session;
	}

	private createNewSession(): ChatSession {
		return {
			id: this.generateId(),
			title: 'New chat',
			messages: [],
			createdAt: Date.now(),
			updatedAt: Date.now()
		};
	}

	private handleNewChat(): void {
		const newSession = this.createNewSession();
		this.sessions.unshift(newSession);
		this.currentSessionId = newSession.id;
		this.persistSessions();
		this.postToWebview({
			type: 'sessionsUpdated',
			sessions: this.getSessionSummaries(),
			currentSessionId: this.currentSessionId
		});
		this.postToWebview({ type: 'historyLoaded', messages: newSession.messages });
	}

	private async handleClearHistory(): Promise<void> {
		const choice = await this.requestSidebarConfirm(
			'Clear chat history?',
			'This will delete all chats and cannot be undone.',
			['Cancel', 'Clear']
		);
		if (choice !== 'Clear') return;

		this.sessions = [];
		this.currentSessionId = null;
		this.persistSessions();

		const newSession = this.createNewSession();
		this.sessions.unshift(newSession);
		this.currentSessionId = newSession.id;
		this.persistSessions();

		this.postToWebview({
			type: 'sessionsUpdated',
			sessions: this.getSessionSummaries(),
			currentSessionId: this.currentSessionId
		});
		this.postToWebview({ type: 'historyLoaded', messages: newSession.messages });
		vscode.window.showInformationMessage('Chat history cleared.');
	}

	private handleSelectSession(sessionId: string): void {
		this.ensureSessionsLoaded();
		const session = this.sessions.find(item => item.id === sessionId);
		if (!session) return;

		this.currentSessionId = session.id;
		this.persistSessions();
		this.postToWebview({
			type: 'sessionsUpdated',
			sessions: this.getSessionSummaries(),
			currentSessionId: this.currentSessionId
		});
		this.postToWebview({ type: 'historyLoaded', messages: session.messages });
	}

	private updateSessionMetadata(session: ChatSession, userContent?: string): void {
		if (userContent && session.title === 'New chat') {
			session.title = this.deriveSessionTitle(userContent);
		}
		session.updatedAt = Date.now();
		this.sortSessions();
		this.persistSessions();
		this.postToWebview({
			type: 'sessionsUpdated',
			sessions: this.getSessionSummaries(),
			currentSessionId: this.currentSessionId
		});
	}

	private getSessionSummaries(): Array<{ id: string; title: string; updatedAt: number }> {
		return this.sessions.map(session => ({
			id: session.id,
			title: session.title,
			updatedAt: session.updatedAt
		}));
	}

	private sortSessions(): void {
		this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private persistSessions(): void {
		void this.context.globalState.update(this.sessionsStorageKey, this.sessions);
		void this.context.globalState.update(this.currentSessionStorageKey, this.currentSessionId);
	}

	private deriveSessionTitle(content: string): string {
		const cleaned = content.replace(/\s+/g, ' ').trim();
		if (!cleaned) return 'New chat';
		if (cleaned.length <= 50) return cleaned;
		return `${cleaned.slice(0, 50).trim()}...`;
	}

	private findMessageById(messageId: string): ChatMessage | undefined {
		this.ensureSessionsLoaded();
		for (const session of this.sessions) {
			const message = session.messages.find(item => item.id === messageId);
			if (message) return message;
		}
		return undefined;
	}

	private buildDiffLines(oldText: string, newText: string): Array<{ type: 'add' | 'del' | 'ctx'; text: string }> | undefined {
		const oldLines = this.splitLines(oldText);
		const newLines = this.splitLines(newText);

		const maxLines = 2000;
		if (oldLines.length > maxLines || newLines.length > maxLines) {
			return undefined;
		}

		const maxCells = 4_000_000;
		if (oldLines.length * newLines.length > maxCells) {
			return undefined;
		}

		const n = oldLines.length;
		const m = newLines.length;
		const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				if (oldLines[i] === newLines[j]) {
					dp[i][j] = dp[i + 1][j + 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
				}
			}
		}

		const diff: Array<{ type: 'add' | 'del' | 'ctx'; text: string }> = [];
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (oldLines[i] === newLines[j]) {
				diff.push({ type: 'ctx', text: oldLines[i] });
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				diff.push({ type: 'del', text: oldLines[i] });
				i++;
			} else {
				diff.push({ type: 'add', text: newLines[j] });
				j++;
			}
		}
		while (i < n) {
			diff.push({ type: 'del', text: oldLines[i] });
			i++;
		}
		while (j < m) {
			diff.push({ type: 'add', text: newLines[j] });
			j++;
		}

		return diff;
	}

	private splitLines(text: string): string[] {
		if (!text) return [];
		return text.split(/\r?\n/);
	}

	private generateId(): string {
		return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	}

	private postToWebview(payload: unknown): void {
		this.view?.webview.postMessage(payload);
	}

	private async runGithubManagerFlow(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showErrorMessage('No workspace folder found. Open the project folder first.');
				return;
			}

			const repoPath = workspaceFolder.uri.fsPath;
			const remoteUrl = await this.getGitRemoteUrl(repoPath);
			if (!remoteUrl) {
				vscode.window.showErrorMessage('Could not resolve Git remote. Set origin and try again.');
				return;
			}

			const { owner, repo } = this.parseGitHubRemote(remoteUrl);
			if (!owner || !repo) {
				vscode.window.showErrorMessage(`Unrecognized GitHub remote: ${remoteUrl}`);
				return;
			}

			const projectName = repo;
			const summary = 'Auto-generated README for the current project.';
			const bullets = [
				'Automated README generation via CodeMate agents',
				'Commit and push orchestrated by manager flow',
				'GitHub repo metadata updated via MCP'
			];

			const readmeResult = await this.callAgentService({
				agent: 'ReadmeAgent',
				task: 'generate_readme',
				project_name: projectName,
				summary,
				bullets,
				repo_path: repoPath,
				write: true,
				model: 'qwen2.5-coder:1.5b'
			});

			if (!readmeResult || readmeResult.status !== 'success') {
				vscode.window.showErrorMessage('ReadmeAgent failed. Check agent service.');
				return;
			}

			const commitRes = await this.callMcpTool('git_commit', {
				repo_path: repoPath,
				message: 'docs: add README via CodeMate manager'
			});

			if (!commitRes?.ok) {
				vscode.window.showErrorMessage('MCP git_commit failed. Check output.');
				return;
			}

			const pushRes = await this.callMcpTool('git_push', {
				repo_path: repoPath,
				remote: 'origin',
				branch: 'main'
			});

			if (!pushRes?.ok) {
				vscode.window.showErrorMessage('MCP git_push failed. Check output.');
				return;
			}

			const descRes = await this.callMcpTool('github_update_description', {
				owner,
				repo,
				description: 'README generated and pushed via CodeMate manager',
				dry_run: false
			});

			if (!descRes?.ok) {
				vscode.window.showErrorMessage('MCP github_update_description failed. Check output.');
				return;
			}

			vscode.window.showInformationMessage(`Done. README generated for ${repo}, committed, pushed, and description updated.`);
		} catch (error) {
			vscode.window.showErrorMessage(`GitHub manager flow error: ${String(error)}`);
		}
	}

	private async callAgentService(payload: Record<string, unknown>): Promise<any> {
		const repoPath = typeof payload.repo_path === 'string' ? payload.repo_path : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
		const ready = await this.ensureAgentServiceRunning(repoPath);
		if (!ready) {
			throw new Error('Agent service not available on http://127.0.0.1:7001');
		}

		const run = async () => {
			const response = await fetch('http://127.0.0.1:7001/agent/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!response.ok) {
				throw new Error(`Agent service error: ${response.status}`);
			}
			return response.json();
		};

		try {
			return await run();
		} catch (err) {
			this.output.appendLine(`[AgentService] fetch failed, retrying: ${String(err)}`);
			const retryReady = await this.ensureAgentServiceRunning(repoPath);
			if (!retryReady) throw err;
			return await run();
		}
	}

	private async ensureAgentServiceRunning(repoPath: string): Promise<boolean> {
		if (await this.pingAgentService(repoPath)) {
			this.postToWebview({ type: 'agentStatus', status: 'ready' });
			return true;
		}
		if (this.agentServiceStarting) return await this.agentServiceStarting;

		this.agentServiceStarting = (async () => {
			this.postToWebview({ type: 'agentStatus', status: 'starting' });
			const servicePath = this.resolveAgentServicePath();
			if (!servicePath) {
				this.output.appendLine('[AgentService] agents_service.py not found in workspace or extension.');
				this.postToWebview({ type: 'agentStatus', status: 'error', detail: 'missing' });
				return false;
			}

			try {
				const { spawn } = await import('child_process');
				const python = this.resolvePythonCommand();
				this.output.appendLine('[AgentService] Starting agents_service.py...');
				const proc = spawn(python.cmd, [...python.args, servicePath], {
					cwd: path.dirname(servicePath),
					stdio: ['ignore', 'pipe', 'pipe'],
					env: { ...process.env, ...this.loadDotEnvVars() },
					detached: true
				});
				this.agentServiceProcess = proc;
				proc.stdout.on('data', (d) => this.output.appendLine(`[AgentService] ${String(d).trim()}`));
				proc.stderr.on('data', (d) => this.output.appendLine(`[AgentService] ${String(d).trim()}`));
				proc.on('error', (e) => this.output.appendLine(`[AgentService] spawn error: ${String(e)}`));
				proc.unref();
			} catch (err) {
				this.output.appendLine(`[AgentService] start failed: ${String(err)}`);
				this.postToWebview({ type: 'agentStatus', status: 'error', detail: 'start_failed' });
				return false;
			}

			for (let i = 0; i < 15; i++) {
				if (await this.pingAgentService(repoPath)) {
					this.postToWebview({ type: 'agentStatus', status: 'ready' });
					return true;
				}
				await new Promise((r) => setTimeout(r, 300));
			}
			this.postToWebview({ type: 'agentStatus', status: 'error', detail: 'timeout' });
			return false;
		})();

		try {
			return await this.agentServiceStarting;
		} finally {
			this.agentServiceStarting = null;
		}
	}

	private async pingAgentService(repoPath: string): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 800);
			const response = await fetch('http://127.0.0.1:7001/agent/smoke_test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repo_path: repoPath || '.' }),
				signal: controller.signal
			});
			clearTimeout(timeout);
			return response.ok || response.status === 400;
		} catch {
			return false;
		}
	}

	private async callMcpTool(toolName: string, args: Record<string, unknown>): Promise<any> {
		const { spawn } = await import('child_process');
		const python = this.resolvePythonCommand();

		return new Promise((resolve, reject) => {
			const mcpCwd = this.resolveMcpServerPath();
			if (!mcpCwd) {
				this.output.appendLine('[MCP] mcp_server not found in workspace or extension.');
				return reject(new Error('mcp_server not found'));
			}
			const proc = spawn(python.cmd, [...python.args, 'server.py'], {
				cwd: mcpCwd,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, ...this.loadDotEnvVars() }
			});

			const send = (msg: any) => {
				proc.stdin.write(JSON.stringify(msg) + '\n');
			};

			let buffer = '';
			const messages: any[] = [];

			proc.stdout.on('data', (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						messages.push(JSON.parse(line));
					} catch {
						// ignore
					}
				}

				// Look for tool result
				const toolMsg = messages.find(m => m.id === 3);
				if (toolMsg) {
					proc.kill();
					try {
						const text = toolMsg.result?.content?.[0]?.text;
						const parsed = text ? JSON.parse(text) : null;
						resolve(parsed);
					} catch {
						resolve(toolMsg);
					}
				}
			});

			proc.on('error', reject);

			send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
			send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
			send({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: toolName, arguments: args }
			});
		});
	}

	private async handleInit(): Promise<void> {
		try {
			// Load available models
			const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
			if (response.ok) {
				const data = await response.json() as { models?: Array<{ name: string }> };
				const models = (data.models ?? []).map(m => m.name);
				models.push('Groq Model');
				const savedModel = this.context.globalState.get<string>(this.currentModelStorageKey) || '';
				this.currentModel = savedModel && models.includes(savedModel) ? savedModel : (models[0] || '');
				this.groqModel = this.context.globalState.get<string>(this.groqModelStorageKey) || '';
				this.postToWebview({ type: 'modelsLoaded', models, currentModel: this.currentModel });
				this.postToWebview({ type: 'groqModelSaved', model: this.groqModel });
				await this.sendGroqModelsToWebview();
			}

			// Load sessions
			this.ensureSessionsLoaded();
			this.postToWebview({
				type: 'sessionsLoaded',
				sessions: this.getSessionSummaries(),
				currentSessionId: this.currentSessionId
			});

			// Load current session messages
			const session = this.getCurrentSession();
			this.postToWebview({ type: 'historyLoaded', messages: session.messages });
		} catch (error) {
			this.output.appendLine(`Init error: ${String(error)}`);
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.js')
		);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>CodeMate</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		
		:root {
			--bg-primary: #0f1115;
			--bg-secondary: #151a22;
			--bg-tertiary: #1d2430;
			--border: rgba(255, 255, 255, 0.08);
			--text-primary: #f3f0ea;
			--text-secondary: #9aa4b2;
			--accent: #f4b860;
			--accent-hover: #ffcf8a;
			--accent-2: #5fb4a8;
			--success: #7ee3b2;
			--error: #f48771;
			--add-bg: rgba(52, 120, 72, 0.2);
			--del-bg: rgba(136, 53, 53, 0.2);
			--shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
			--glow: 0 0 0 1px rgba(255, 255, 255, 0.06), 0 12px 30px rgba(0, 0, 0, 0.35);
		}

		body {
			font-family: 'Space Grotesk', 'Segoe UI Variable', 'Bahnschrift', 'Trebuchet MS', sans-serif;
			background: var(--bg-primary);
			color: var(--text-primary);
			display: flex;
			height: 100vh;
			overflow: hidden;
			position: relative;
			letter-spacing: 0.2px;
		}

		body::before {
			content: '';
			position: fixed;
			inset: 0;
			background:
				radial-gradient(800px 400px at 15% -10%, rgba(244, 184, 96, 0.18), transparent 60%),
				radial-gradient(700px 380px at 90% 10%, rgba(95, 180, 168, 0.2), transparent 60%),
				radial-gradient(900px 520px at 50% 120%, rgba(80, 110, 160, 0.2), transparent 65%);
			pointer-events: none;
			z-index: 0;
		}

		body::after {
			content: '';
			position: fixed;
			inset: 0;
			background-image: linear-gradient(120deg, rgba(255, 255, 255, 0.03) 0%, transparent 35%, rgba(255, 255, 255, 0.02) 100%);
			mix-blend-mode: screen;
			opacity: 0.6;
			pointer-events: none;
			z-index: 0;
		}

		.sidebar {
			width: 200px;
			background: linear-gradient(180deg, rgba(21, 26, 34, 0.98) 0%, rgba(15, 18, 24, 0.98) 100%);
			border-right: 1px solid var(--border);
			display: flex;
			flex-direction: column;
			flex-shrink: 0;
			backdrop-filter: blur(6px);
		}

		.sidebar-header {
			padding: 12px;
			border-bottom: 1px solid var(--border);
			background: rgba(15, 18, 24, 0.85);
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.new-chat-btn {
			width: 100%;
			padding: 8px 12px;
			background: linear-gradient(135deg, rgba(244, 184, 96, 0.9), rgba(255, 207, 138, 0.9));
			border: 1px solid rgba(255, 255, 255, 0.15);
			border-radius: 6px;
			color: #1a1a1a;
			font-size: 12px;
			cursor: pointer;
			font-weight: 500;
			box-shadow: 0 8px 18px rgba(244, 184, 96, 0.2);
		}

		.new-chat-btn:hover {
			transform: translateY(-1px);
			box-shadow: 0 10px 20px rgba(244, 184, 96, 0.3);
		}

		.clear-history-btn {
			width: 100%;
			padding: 6px 10px;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: rgba(21, 26, 34, 0.5);
			color: var(--text-secondary);
			font-size: 11px;
			cursor: pointer;
		}

		.clear-history-btn:hover {
			border-color: rgba(255, 207, 138, 0.6);
			background: rgba(244, 184, 96, 0.1);
			color: var(--accent-hover);
		}

		.chats-container {
			flex: 1;
			overflow-y: auto;
			padding: 8px;
		}

		.chat-item {
			padding: 8px 12px;
			margin-bottom: 4px;
			border-radius: 6px;
			cursor: pointer;
			border: 1px solid transparent;
			transition: transform 0.15s ease, border-color 0.2s ease, background 0.2s ease;
		}

		.chat-item:hover {
			background: rgba(29, 36, 48, 0.7);
			transform: translateX(2px);
		}

		.chat-item.active {
			background: rgba(95, 180, 168, 0.15);
			border-color: rgba(95, 180, 168, 0.6);
		}

		.chat-title {
			font-size: 12px;
			color: var(--text-primary);
			margin-bottom: 2px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.chat-meta {
			font-size: 10px;
			color: var(--text-secondary);
		}

		.chats-empty {
			padding: 16px;
			text-align: center;
			font-size: 11px;
			color: var(--text-secondary);
		}

		.main {
			flex: 1;
			display: flex;
			flex-direction: column;
			position: relative;
			z-index: 1;
		}

		.messages-container {
			flex: 1;
			overflow-y: auto;
			padding: 20px 18px 28px;
			display: flex;
			flex-direction: column;
			gap: 16px;
		}

		.message {
			display: flex;
			flex-direction: column;
			gap: 8px;
			animation: rise 0.35s ease both;
		}

		.message:nth-child(odd) {
			animation-delay: 0.02s;
		}

		.message-header {
			display: flex;
			align-items: center;
			gap: 8px;
			font-size: 12px;
			color: var(--text-secondary);
		}

		.message-role {
			font-weight: 600;
			color: var(--accent);
			letter-spacing: 0.6px;
			text-transform: uppercase;
			font-size: 10px;
		}

		.message-content {
			padding: 12px;
			border-radius: 8px;
			background: rgba(21, 26, 34, 0.85);
			border: 1px solid rgba(255, 255, 255, 0.08);
			box-shadow: var(--glow);
			line-height: 1.6;
			font-size: 13px;
		}

		.message.user .message-content {
			background: linear-gradient(135deg, rgba(244, 184, 96, 0.12), rgba(95, 180, 168, 0.1));
			border-color: rgba(244, 184, 96, 0.25);
		}

		.file-context {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			background: rgba(29, 36, 48, 0.8);
			border: 1px solid var(--border);
			border-radius: 4px;
			font-size: 11px;
			color: var(--text-secondary);
		}

		.file-icon {
			width: 14px;
			height: 14px;
		}

		.code-block {
			margin: 8px 0;
			border-radius: 6px;
			overflow: hidden;
			background: rgba(29, 36, 48, 0.9);
			border: 1px solid rgba(255, 255, 255, 0.08);
			box-shadow: var(--glow);
		}

		.code-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 8px 12px;
			background: rgba(21, 26, 34, 0.9);
			border-bottom: 1px solid var(--border);
			font-size: 11px;
			color: var(--text-secondary);
		}

		.code-actions {
			display: flex;
			gap: 6px;
		}

		.code-actions button {
			padding: 4px 8px;
			font-size: 11px;
			border: 1px solid var(--border);
			background: rgba(21, 26, 34, 0.8);
			color: var(--text-primary);
			border-radius: 4px;
			cursor: pointer;
			transition: transform 0.15s ease, border-color 0.2s ease, background 0.2s ease;
		}

		.code-actions button:hover {
			background: rgba(244, 184, 96, 0.2);
			border-color: rgba(244, 184, 96, 0.6);
			transform: translateY(-1px);
		}

		.code-actions button.success {
			background: var(--success);
			border-color: var(--success);
			color: #000;
		}

		pre {
			margin: 0;
			padding: 12px;
			overflow-x: auto;
			font-family: 'Cascadia Code', 'JetBrains Mono', 'Consolas', 'SFMono-Regular', monospace;
			font-size: 12px;
			line-height: 1.5;
		}

		.diff {
			padding: 0;
		}

		.diff-line {
			padding: 2px 12px;
			font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
			font-size: 12px;
			line-height: 1.5;
		}

		.diff-line.add {
			background: var(--add-bg);
			color: #9af0b5;
		}

		.diff-line.del {
			background: var(--del-bg);
			color: #ff9a9a;
		}

		.diff-line.ctx {
			color: var(--text-secondary);
		}

		.thinking {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			background: rgba(29, 36, 48, 0.8);
			border-radius: 6px;
			font-size: 12px;
			color: var(--text-secondary);
		}

		.thinking-dots {
			display: flex;
			gap: 4px;
		}

		.thinking-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: var(--accent);
			animation: pulse 1.4s infinite;
		}

		.thinking-dot:nth-child(2) { animation-delay: 0.2s; }
		.thinking-dot:nth-child(3) { animation-delay: 0.4s; }

		@keyframes pulse {
			0%, 60%, 100% { opacity: 0.3; }
			30% { opacity: 1; }
		}

		@keyframes rise {
			from { transform: translateY(8px); opacity: 0; }
			to { transform: translateY(0); opacity: 1; }
		}

		.input-container {
			padding: 12px;
			background: rgba(21, 26, 34, 0.95);
			border-top: 1px solid var(--border);
			overflow: visible;
		}

		.input-wrapper {
			display: flex;
			gap: 8px;
			margin-top: 6px;
			margin-bottom: 8px;
		}

		.input-field {
			flex: 1;
			padding: 10px 12px;
			background: rgba(29, 36, 48, 0.9);
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 6px;
			color: var(--text-primary);
			font-size: 13px;
			font-family: inherit;
			resize: none;
			min-height: 38px;
			max-height: 120px;
			overflow-y: auto;
			scrollbar-width: none; /* Firefox */
		}

		.input-field::-webkit-scrollbar {
			width: 0;
			height: 0;
		}

		.input-field:focus {
			outline: none;
			border-color: rgba(244, 184, 96, 0.6);
			box-shadow: 0 0 0 3px rgba(244, 184, 96, 0.15);
		}

		.send-btn {
			padding: 0 16px;
			background: linear-gradient(135deg, rgba(244, 184, 96, 0.95), rgba(95, 180, 168, 0.9));
			border: none;
			border-radius: 6px;
			color: #111;
			font-size: 13px;
			cursor: pointer;
			font-weight: 500;
			box-shadow: 0 8px 20px rgba(95, 180, 168, 0.2);
		}

		.send-btn:hover {
			transform: translateY(-1px);
			box-shadow: 0 10px 22px rgba(95, 180, 168, 0.3);
		}

		.send-btn:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			overflow: visible;
		}

		.model-picker {
			position: relative;
			display: inline-flex;
			align-items: center;
			gap: 6px;
		}

		.model-btn {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 6px 10px;
			background: rgba(29, 36, 48, 0.9);
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 6px;
			color: var(--text-primary);
			font-size: 11px;
			cursor: pointer;
			line-height: 1;
		}

		.model-btn:hover {
			border-color: rgba(244, 184, 96, 0.6);
		}

		.model-btn svg {
			width: 14px;
			height: 14px;
		}

		.model-label {
			max-width: 140px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.model-menu {
			position: absolute;
			left: 0;
			bottom: calc(100% + 6px);
			min-width: 220px;
			max-width: calc(100vw - 24px);
			background: rgba(21, 26, 34, 0.96);
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 10px;
			box-shadow: var(--shadow);
			padding: 6px;
			display: none;
			z-index: 10;
			max-height: 220px;
			overflow-y: auto;
		}

		.model-menu.open {
			display: block;
		}

		.model-item {
			padding: 8px 10px;
			border-radius: 6px;
			font-size: 12px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
		}

		.model-item:hover {
			background: rgba(29, 36, 48, 0.9);
		}

		.model-item.active {
			background: rgba(95, 180, 168, 0.2);
			border: 1px solid rgba(95, 180, 168, 0.4);
		}

		.model-check {
			font-size: 12px;
			color: var(--success);
		}

		.scrollbar-thin::-webkit-scrollbar {
			width: 8px;
		}

		.scrollbar-thin::-webkit-scrollbar-track {
			background: rgba(15, 17, 21, 0.8);
		}

		.scrollbar-thin::-webkit-scrollbar-thumb {
			background: rgba(255, 255, 255, 0.12);
			border-radius: 4px;
		}

		.scrollbar-thin::-webkit-scrollbar-thumb:hover {
			background: rgba(244, 184, 96, 0.35);
		}
			
		/* Sidebar toggle overrides */
		:root {
			--sidebar-width: 220px;
			--topbar-height: 40px;
		}

		body {
			position: relative;
		}

		.sidebar {
			width: var(--sidebar-width);
			position: absolute;
			left: 0;
			top: 0;
			height: 100%;
			z-index: 5;
			transition: transform 0.2s ease, width 0.2s ease;
			overflow: hidden;
			padding-top: var(--topbar-height);
		}

		body.sidebar-collapsed .sidebar {
			transform: translateX(calc(-1 * var(--sidebar-width)));
			border-right: none;
			pointer-events: none;
		}

		.main {
			position: relative;
			width: 100%;
			padding-left: var(--sidebar-width);
			transition: padding-left 0.2s ease;
		}

		body.sidebar-collapsed .main {
			padding-left: 0;
		}

		.topbar {
			height: var(--topbar-height);
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 0 12px;
			border-bottom: 1px solid var(--border);
			background: rgba(21, 26, 34, 0.9);
			flex-shrink: 0;
			position: relative;
			z-index: 6;
			backdrop-filter: blur(6px);
		}

		.topbar-title {
			font-size: 12px;
			color: var(--text-secondary);
			letter-spacing: 0.04em;
			text-transform: uppercase;
			margin-right: auto;
		}

		.status-pill {
			padding: 4px 8px;
			border-radius: 999px;
			font-size: 10px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			color: var(--text-secondary);
			background: rgba(29, 36, 48, 0.7);
			white-space: nowrap;
		}

		.status-pill.hidden {
			display: none;
		}

		.status-pill.starting {
			color: #ffd37a;
			border-color: rgba(244, 184, 96, 0.6);
			background: rgba(244, 184, 96, 0.15);
		}

		.status-pill.ready {
			color: #7ee3b2;
			border-color: rgba(95, 180, 168, 0.6);
			background: rgba(95, 180, 168, 0.15);
		}

		.status-pill.error {
			color: #f48771;
			border-color: rgba(244, 135, 113, 0.6);
			background: rgba(244, 135, 113, 0.15);
		}

		.icon-btn {
			width: 28px;
			height: 28px;
			border-radius: 6px;
			border: 1px solid rgba(255, 255, 255, 0.08);
			background: rgba(29, 36, 48, 0.7);
			color: var(--text-primary);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			transition: transform 0.15s ease, border-color 0.2s ease, background 0.2s ease;
		}

		.icon-btn:hover {
			border-color: rgba(244, 184, 96, 0.6);
			background: rgba(21, 26, 34, 0.9);
			transform: translateY(-1px);
		}

		.icon-btn svg {
			width: 16px;
			height: 16px;
		}

		.confirm-overlay {
			position: fixed;
			inset: 0;
			background: rgba(5, 8, 12, 0.72);
			display: none;
			align-items: center;
			justify-content: center;
			z-index: 999;
		}

		.confirm-overlay.open {
			display: flex;
		}

		.confirm-modal {
			width: 90%;
			max-width: 420px;
			background: rgba(21, 26, 34, 0.96);
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 10px;
			padding: 16px;
			box-shadow: var(--shadow);
		}

		.confirm-title {
			font-size: 14px;
			font-weight: 600;
			margin-bottom: 8px;
		}

		.confirm-detail {
			font-size: 12px;
			color: var(--text-secondary);
			white-space: pre-wrap;
			max-height: 200px;
			overflow: auto;
			border: 1px solid var(--border);
			padding: 8px;
			border-radius: 6px;
			background: var(--bg-tertiary);
		}

		.confirm-actions {
			display: flex;
			gap: 8px;
			margin-top: 12px;
			justify-content: flex-end;
		}

		.confirm-btn {
			padding: 6px 10px;
			border: 1px solid var(--border);
			background: rgba(29, 36, 48, 0.8);
			color: var(--text-primary);
			border-radius: 6px;
			cursor: pointer;
			font-size: 12px;
			transition: transform 0.15s ease, border-color 0.2s ease, background 0.2s ease;
		}

		.confirm-btn:hover {
			border-color: rgba(244, 184, 96, 0.6);
			background: rgba(244, 184, 96, 0.15);
			transform: translateY(-1px);
		}

	</style>
</head>
<body class="sidebar-collapsed">
	<div class="sidebar">
		<div class="sidebar-header">
			<button id="newChat" class="new-chat-btn">+ New Chat</button>
			<button id="clearHistory" class="clear-history-btn" title="Clear chat history">Clear History</button>
		</div>
		<div id="chats" class="chats-container scrollbar-thin"></div>
	</div>

	<div class="main">
		<div class="topbar">
			<button id="toggleSidebar" class="icon-btn" title="Chat history">
				<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
					<path d="M12 7a1 1 0 0 1 1 1v4.4l2.8 1.6a1 1 0 1 1-1 1.7l-3.3-1.9A1 1 0 0 1 11 13V8a1 1 0 0 1 1-1z"/>
					<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8a8 8 0 0 1-8 8z"/>
				</svg>
			</button>
			<span class="topbar-title">Chat</span>
			<div id="agentStatus" class="status-pill hidden">Agent: idle</div>
			<button id="settingsButton" class="icon-btn" title="Settings">⚙</button>
		</div>
		<div class="messages-container scrollbar-thin" id="messages"></div>
		
		<div class="input-container">
			<div class="toolbar">
				<div class="model-picker">
					<button id="modelButton" class="model-btn" title="Select model">
						<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
							<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8a8 8 0 0 1-8 8z"/>
							<path d="M8 9h8v2H8zm0 4h5v2H8z"/>
						</svg>
						<span id="modelLabel" class="model-label">Select model</span>
					</button>
					<div id="modelMenu" class="model-menu"></div>
				</div>
			</div>
			<div class="input-wrapper">
				<textarea 
					id="input" 
					class="input-field" 
					placeholder="Ask me to write, edit, fix, or explain code..."
					rows="1"
				></textarea>
				<button id="send" class="send-btn">Send</button>
			</div>
		</div>
	</div>

	<div id="confirmOverlay" class="confirm-overlay">
		<div class="confirm-modal">
			<div id="confirmTitle" class="confirm-title">Confirm</div>
			<div id="confirmDetail" class="confirm-detail"></div>
			<div id="confirmButtons" class="confirm-actions"></div>
		</div>
	</div>

		<div id="settingsOverlay" class="confirm-overlay">
			<div class="confirm-modal">
				<div class="confirm-title">Groq Settings</div>
				<div class="confirm-detail">
					<div style="margin-bottom: 8px;">Select a Groq model or enter one manually.</div>
					<select id="groqModelSelect" style="width: 100%; margin-bottom: 8px;"></select>
					<input id="groqModelInput" type="text" placeholder="e.g. llama-3.3-70b-versatile" style="width: 100%; padding: 6px;" />
				</div>
				<div class="confirm-actions">
					<button id="groqRefresh" class="confirm-btn">Refresh</button>
					<button id="groqTest" class="confirm-btn">Test</button>
					<button id="groqSave" class="confirm-btn">Save</button>
				</div>
			</div>
		</div>

	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

export function deactivate() {}











