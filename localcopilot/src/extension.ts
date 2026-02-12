import * as vscode from 'vscode';
import * as http from 'http';

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
	const output = vscode.window.createOutputChannel('LocalCopilot');
	context.subscriptions.push(output);
	output.appendLine('LocalCopilot activated');

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
		const configured = vscode.workspace.getConfiguration('localcopilot').get<string>('inlineModel');
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
	public static readonly viewType = 'localcopilot.agentView';

	private context: vscode.ExtensionContext;
	private output: vscode.OutputChannel;
	private view: vscode.WebviewView | undefined;
	private currentModel: string = '';
	private sessions: ChatSession[] = [];
	private currentSessionId: string | null = null;
	private readonly sessionsStorageKey = 'localcopilot.sessions';
	private readonly currentSessionStorageKey = 'localcopilot.currentSession';

	constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
		this.context = context;
		this.output = output;
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
					break;
				case 'newChat':
					this.handleNewChat();
					break;
				case 'selectSession':
					this.handleSelectSession(message.sessionId);
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

	private async handleUserMessage(content: string): Promise<void> {
		if (!content.trim()) return;
		this.ensureSessionsLoaded();

		const session = this.getCurrentSession();
		const editor = vscode.window.activeTextEditor;
		
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

			// Stream the response
			await this.streamOllamaResponse(
				this.currentModel,
				prompt,
				systemPrompt,
				assistantMessage,
				editor,
				classification
			);
			
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
		const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
		let matches = [...message.content.matchAll(codeBlockRegex)];

		// Use the last code block if multiple exist
		if (matches.length > 1) {
			matches = [matches[matches.length - 1]];
		}

		if (matches.length > 0) {
			const replaceAll = replaceAllDefault && editor.selection.isEmpty;
			message.codeChanges = matches.map(match => {
				const originalCode = editor.selection.isEmpty
					? editor.document.getText()
					: editor.document.getText(editor.selection);
				const newCode = match[2].trim();
				const diff = this.buildDiffLines(originalCode, newCode);

				return {
					file: vscode.workspace.asRelativePath(editor.document.uri),
					originalCode,
					newCode,
					applied: false,
					replaceAll,
					diff
				};
			});

			this.postToWebview({ type: 'messageUpdated', message });
		}
	}

	private async handleApplyChange(messageId: string, changeIndex: number): Promise<void> {
		const message = this.findMessageById(messageId);
		if (!message || !message.codeChanges || !message.codeChanges[changeIndex]) return;

		const change = message.codeChanges[changeIndex];
		const editor = vscode.window.activeTextEditor;

		if (!editor) {
			vscode.window.showErrorMessage('No active editor');
			return;
		}

		await editor.edit(editBuilder => {
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

	private async handleInit(): Promise<void> {
		try {
			// Load available models
			const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
			if (response.ok) {
				const data = await response.json() as { models?: Array<{ name: string }> };
				const models = (data.models ?? []).map(m => m.name);
				this.currentModel = models[0] || '';
				this.postToWebview({ type: 'modelsLoaded', models, currentModel: this.currentModel });
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
	<title>LocalCopilot</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		
		:root {
			--bg-primary: #1e1e1e;
			--bg-secondary: #252526;
			--bg-tertiary: #2d2d30;
			--border: #3e3e42;
			--text-primary: #cccccc;
			--text-secondary: #858585;
			--accent: #0e639c;
			--accent-hover: #1177bb;
			--success: #4ec9b0;
			--error: #f48771;
			--add-bg: #1e3a1e;
			--del-bg: #3a1e1e;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			background: var(--bg-primary);
			color: var(--text-primary);
			display: flex;
			height: 100vh;
			overflow: hidden;
		}

		.sidebar {
			width: 200px;
			background: var(--bg-secondary);
			border-right: 1px solid var(--border);
			display: flex;
			flex-direction: column;
			flex-shrink: 0;
		}

		.sidebar-header {
			padding: 12px;
			border-bottom: 1px solid var(--border);
		}

		.new-chat-btn {
			width: 100%;
			padding: 8px 12px;
			background: var(--accent);
			border: none;
			border-radius: 6px;
			color: white;
			font-size: 12px;
			cursor: pointer;
			font-weight: 500;
		}

		.new-chat-btn:hover {
			background: var(--accent-hover);
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
		}

		.chat-item:hover {
			background: var(--bg-tertiary);
		}

		.chat-item.active {
			background: var(--bg-tertiary);
			border-color: var(--accent);
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
		}

		.messages-container {
			flex: 1;
			overflow-y: auto;
			padding: 16px;
			display: flex;
			flex-direction: column;
			gap: 16px;
		}

		.message {
			display: flex;
			flex-direction: column;
			gap: 8px;
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
		}

		.message-content {
			padding: 12px;
			border-radius: 8px;
			background: var(--bg-secondary);
			border: 1px solid var(--border);
			line-height: 1.6;
			font-size: 13px;
		}

		.message.user .message-content {
			background: var(--bg-tertiary);
		}

		.file-context {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			background: var(--bg-tertiary);
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
			background: var(--bg-tertiary);
			border: 1px solid var(--border);
		}

		.code-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 8px 12px;
			background: var(--bg-secondary);
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
			background: var(--bg-tertiary);
			color: var(--text-primary);
			border-radius: 4px;
			cursor: pointer;
		}

		.code-actions button:hover {
			background: var(--accent);
			border-color: var(--accent);
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
			font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
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
			color: #90ee90;
		}

		.diff-line.del {
			background: var(--del-bg);
			color: #ff6b6b;
		}

		.diff-line.ctx {
			color: var(--text-secondary);
		}

		.thinking {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			background: var(--bg-tertiary);
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

		.input-container {
			padding: 12px;
			background: var(--bg-secondary);
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
			background: var(--bg-tertiary);
			border: 1px solid var(--border);
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
			border-color: var(--accent);
		}

		.send-btn {
			padding: 0 16px;
			background: var(--accent);
			border: none;
			border-radius: 6px;
			color: white;
			font-size: 13px;
			cursor: pointer;
			font-weight: 500;
		}

		.send-btn:hover {
			background: var(--accent-hover);
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
			background: var(--bg-tertiary);
			border: 1px solid var(--border);
			border-radius: 6px;
			color: var(--text-primary);
			font-size: 11px;
			cursor: pointer;
			line-height: 1;
		}

		.model-btn:hover {
			border-color: var(--accent);
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
			background: var(--bg-secondary);
			border: 1px solid var(--border);
			border-radius: 10px;
			box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
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
			background: var(--bg-tertiary);
		}

		.model-item.active {
			background: rgba(14, 99, 156, 0.25);
			border: 1px solid rgba(14, 99, 156, 0.4);
		}

		.model-check {
			font-size: 12px;
			color: var(--success);
		}

		.scrollbar-thin::-webkit-scrollbar {
			width: 8px;
		}

		.scrollbar-thin::-webkit-scrollbar-track {
			background: var(--bg-primary);
		}

		.scrollbar-thin::-webkit-scrollbar-thumb {
			background: var(--border);
			border-radius: 4px;
		}

		.scrollbar-thin::-webkit-scrollbar-thumb:hover {
			background: var(--text-secondary);
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
		}

		.topbar {
			height: var(--topbar-height);
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 0 12px;
			border-bottom: 1px solid var(--border);
			background: var(--bg-secondary);
			flex-shrink: 0;
			position: relative;
			z-index: 6;
		}

		.topbar-title {
			font-size: 12px;
			color: var(--text-secondary);
			letter-spacing: 0.04em;
			text-transform: uppercase;
		}

		.icon-btn {
			width: 28px;
			height: 28px;
			border-radius: 6px;
			border: 1px solid var(--border);
			background: var(--bg-tertiary);
			color: var(--text-primary);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
		}

		.icon-btn:hover {
			border-color: var(--accent);
			background: var(--bg-secondary);
		}

		.icon-btn svg {
			width: 16px;
			height: 16px;
		}

	</style>
</head>
<body class="sidebar-collapsed">
	<div class="sidebar">
		<div class="sidebar-header">
			<button id="newChat" class="new-chat-btn">+ New Chat</button>
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

	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}

export function deactivate() {}
