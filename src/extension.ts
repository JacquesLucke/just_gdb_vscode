import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

const currentLineDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

interface PacketFromGDB {
	functionName: string,
	args: object,
};

interface HandleStopEventArgs {
	filePath: string,
	line: number,
};

interface BacktraceRequestFinishedArgs {
	frames: string[];
};

interface HoverRequestFinishedArgs {
	expression: string,
	value: string,
};

interface HoverRequestFailedArgs {
	expression: string,
};

interface HoverRequestInfo {
	expression: string,
	resolve: (value: string) => void;
	reject: () => void;
};

class DebugSession {
	gdbBinaryPath: string;
	gdbArgs: string[];
	terminalWriteEmitter: vscode.EventEmitter<string>;
	terminal: vscode.Terminal;
	gdbProcess: child_process.ChildProcess | null = null;
	startupFinished: () => void;
	private currentTerminalLine: string = "";
	private currentPacketStr: string | null = null;
	registeredCallablesByName = new Map<string, (args: object) => void>();
	pendingHoverRequests: HoverRequestInfo[] = [];

	constructor(gdbBinaryPath: string, args: string[], terminalName: string, startupFinished: () => void) {
		this.gdbBinaryPath = gdbBinaryPath;
		this.gdbArgs = args;
		this.startupFinished = startupFinished;
		this.terminalWriteEmitter = new vscode.EventEmitter<string>();
		this.terminal = vscode.window.createTerminal({
			name: terminalName,
			pty: {
				onDidWrite: this.terminalWriteEmitter.event,
				open: this.onTerminalOpen.bind(this),
				close: this.onTerminalClose.bind(this),
				handleInput: this.onUserInputInTerminal.bind(this),
			}
		});
		vscode.commands.executeCommand('setContext', 'just-gdb.isDebugging', true);

		const callables = [
			this.handleContinueEvent,
			this.handleStopEvent,
			this.hoverRequestFinished,
			this.hoverRequestFailed,
			this.backtraceRequestFinished,
		];
		for (const callable of callables) {
			this.registeredCallablesByName.set(callable.name, callable.bind(this));
		}
	}

	private onTerminalOpen() {
		// Only create the process once the terminal is open, so that the
		// initial output is not ignored by the terminal.
		this.gdbProcess = child_process.spawn(this.gdbBinaryPath, this.gdbArgs);
		this.gdbProcess.stdout?.on('data', this.onProcessStdout.bind(this));
		this.gdbProcess.stderr?.on('data', this.onProcessStderr.bind(this));
		this.gdbProcess.on('close', this.onProcessClose.bind(this));

		this.sendInternalCommandToGDB("source " + gdbExtensionPath);
		this.startupFinished();
	}

	private onTerminalClose() {
		this.gdbProcess?.kill();
	}

	private onUserInputInTerminal(data: string) {
		if (data.charCodeAt(0) == 3) { // Ctrl+C
			this.interrupt();
			return;
		}
		if (data.endsWith("\r")) { // Enter
			this.terminalWriteEmitter.fire("\n\r");
			this.sendUserCommandToGDB(this.currentTerminalLine);
			this.currentTerminalLine = "";
			return;
		}
		if (data === '\x7f') { // Backspace
			this.terminalWriteEmitter.fire('\x1b[D');
			this.terminalWriteEmitter.fire('\x1b[P');
			this.currentTerminalLine = this.currentTerminalLine.slice(0, -1);
			return;
		}
		if (data === '\t') { // Tab
			// Auto-complete is not quite working yet, ignore for now.
			return;
		}
		this.currentTerminalLine += data;
		this.terminalWriteEmitter.fire(data);
	}

	private onProcessStdout(data: Buffer) {
		this.processOutputToTerminal(data);
		const dataStr = data.toString();
		this.tryDetectPackets(dataStr);

	}

	private tryDetectPackets(dataStr: string) {
		const startTag = "##!@";
		const endTag = [...startTag].reverse().join('');

		if (this.currentPacketStr === null) {
			const packetStart = dataStr.indexOf(startTag);
			if (packetStart === -1) {
				return;
			}
			const packetEnd = dataStr.indexOf(endTag, packetStart);
			if (packetEnd === -1) {
				this.currentPacketStr = dataStr.slice(packetStart);
				return;
			}
			const packetStr = dataStr.slice(packetStart + startTag.length, packetEnd);
			const packet = JSON.parse(packetStr);
			this.processPacket(packet);
			const remainingPacketStr = dataStr.slice(packetEnd + endTag.length);
			this.tryDetectPackets(remainingPacketStr);
			return;
		}
		const packetEnd = dataStr.indexOf(endTag);
		if (packetEnd === -1) {
			this.currentPacketStr += dataStr;
			return;
		}
		const packetStr = this.currentPacketStr + dataStr.slice(0, packetEnd);
		const packet = JSON.parse(packetStr);
		this.processPacket(packet);
		const remainingPacketStr = dataStr.slice(packetEnd + endTag.length);
		this.tryDetectPackets(remainingPacketStr);
	}

	private processPacket(packet: PacketFromGDB) {
		const f = this.registeredCallablesByName.get(packet.functionName);
		if (f !== undefined) {
			f(packet.args);
		}
	}

	private onProcessStderr(data: Buffer) {
		this.processOutputToTerminal(data);
	}
	private onProcessClose() {
		globalDebugSession = null;
		this.gdbProcess?.kill();
		this.terminalWriteEmitter.fire("\n\r\n\rGDB exited.\n\r");
		vscode.commands.executeCommand('setContext', 'just-gdb.isDebugging', false);
	}

	private processOutputToTerminal(data: Buffer) {
		const data_str = data.toString();
		// Todo: Figure out why just replacing \n with \n\r did not work correctly.
		const lines = data_str.split("\n");
		for (let i = 0; i < lines.length - 1; i++) {
			this.terminalWriteEmitter.fire(lines[i] + "\n\r");
		}
		this.terminalWriteEmitter.fire(lines[lines.length - 1]);
		if (data_str.endsWith("\n")) {
			this.terminalWriteEmitter.fire("\n\r");
		}
	}

	executePythonFunction(functionName: string, args: object) {
		const argsStr = JSON.stringify(args);
		const argsBase64 = Buffer.from(argsStr).toString('base64');
		this.sendInternalCommandToGDB(`python invoke_function_from_vscode("${functionName}", "${argsBase64}")`);
	}

	forwardTextToGDB(text: string) {
		this.gdbProcess?.stdin?.write(text);
	}

	sendInternalCommandToGDB(command: string) {
		this.gdbProcess?.stdin?.write(command + '\n')
	}

	sendUserCommandToGDB(command: string) {
		this.gdbProcess?.stdin?.write(command + '\n');
	}

	interrupt() {
		this.gdbProcess?.kill('SIGINT');
	}

	handleContinueEvent(args: any) {
		vscode.window.activeTextEditor?.setDecorations(currentLineDecorationType, []);
		if (contextViewProvider) {
			contextViewProvider.stackFrames = [];
			contextViewProvider.refresh();
		}
	}

	handleStopEvent(args: HandleStopEventArgs) {
		let filePath: string = args.filePath;
		const line: number = args.line;
		if (filePath == 'main.cc') {
			filePath = '/home/jacques/Documents/test_c_debug/main.cc';
		}
		vscode.window.showTextDocument(vscode.Uri.file(filePath)).then((editor) => {
			const range = new vscode.Range(line, 0, line, 100000);
			editor.setDecorations(currentLineDecorationType, [range]);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			// Would be nice to move the vscode window to the front here, but there does
			// not seem to be an API for that.
		});
	}

	hoverRequestFinished(args: HoverRequestFinishedArgs) {
		const remainingRequests = [];
		for (const request of this.pendingHoverRequests) {
			if (request.expression == args.expression) {
				request.resolve(args.value);
			}
			else {
				remainingRequests.push(request);
			}
		}
		this.pendingHoverRequests = remainingRequests;
	}

	hoverRequestFailed(args: HoverRequestFailedArgs) {
		const remainingRequests = [];
		for (const request of this.pendingHoverRequests) {
			if (request.expression == args.expression) {
				request.reject();
			}
			else {
				remainingRequests.push(request);
			}
		}
		this.pendingHoverRequests = remainingRequests;
	}

	backtraceRequestFinished(args: BacktraceRequestFinishedArgs) {
		if (contextViewProvider !== null) {
			contextViewProvider.stackFrames = args.frames;
			contextViewProvider.refresh();
			return false;
		}
	}
};


let globalDebugSession: DebugSession | null = null;
let contextViewProvider: ContextViewProvider | null = null;

export function activate(context: vscode.ExtensionContext) {

	const commands: [string, any][] = [
		['just-gdb.start', COMMAND_start],
		['just-gdb.pause', COMMAND_pause],
		['just-gdb.playground', COMMAND_playground],
		['just-gdb.stepOver', COMMAND_stepOver],
		['just-gdb.stepInto', COMMAND_stepInto],
		['just-gdb.stepOut', COMMAND_stepOut],
		['just-gdb.continue', COMMAND_continue],
		['just-gdb.loadBacktrace', COMMAND_loadBacktrace],
	];

	for (const item of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(item[0], item[1]));
	}

	const hoverProvider: vscode.HoverProvider = {
		provideHover(document, position, token) {
			if (globalDebugSession === null) {
				return;
			}
			const lineStr = document.lineAt(position.line).text;
			const hoverIndex = position.character;
			let startIndex = hoverIndex;
			while (startIndex > 0 && lineStr[startIndex - 1].match(/[a-zA-Z0-9_\.]/)) {
				startIndex--;
			}
			let endIndex = hoverIndex;
			while (endIndex < lineStr.length - 1 && lineStr[endIndex].match(/[a-zA-Z0-9_]/)) {
				endIndex++;
			}
			const expression = lineStr.slice(startIndex, endIndex);
			if (expression.length == 0) {
				return undefined;
			}

			return new Promise((hoverRresolve, hoverReject) => {
				globalDebugSession?.pendingHoverRequests.push({
					expression: expression,
					resolve: (value: string) => {
						hoverRresolve(new vscode.Hover(value));
					},
					reject: () => {
						hoverReject();
					}
				});
				globalDebugSession?.sendInternalCommandToGDB("python request_hover_value(\"" + expression + "\")")
			});
		}
	};

	vscode.languages.registerHoverProvider('cpp', hoverProvider);
	vscode.languages.registerHoverProvider('c', hoverProvider);

	contextViewProvider = new ContextViewProvider();
	vscode.window.createTreeView("gdbContext", { treeDataProvider: contextViewProvider });

	// Start loading breakpoints. Also see https://github.com/microsoft/vscode/issues/130138.
	vscode.debug.breakpoints;

	vscode.debug.onDidChangeBreakpoints(e => {
		if (globalDebugSession === null) {
			return;
		}
		// Todo: Potentially interrupt the application to set breakpoints.
		globalDebugSession.executePythonFunction("set_breakpoints", {
			vscode_breakpoints: e.added,
		});
		globalDebugSession.executePythonFunction('remove_breakpoints', {
			vscode_breakpoints: e.removed,
		});
	});
}

export function deactivate() { }

const mainDir = path.dirname(__dirname);
const sourceDir = path.join(mainDir, "src");
const gdbExtensionPath = path.join(sourceDir, "gdb_extension.py")


function getGlobalConfig() {
	return vscode.workspace.getConfiguration("justGDB");
}

function getCurrentWorkspaceFolder() {
	const editor = vscode.window.activeTextEditor;
	if (editor?.document) {
		const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (folder !== undefined) {
			return folder;
		}
	}
	const folders = vscode.workspace.workspaceFolders;
	if (folders === undefined || folders.length === 0) {
		return undefined;
	}
	return folders[0];
}

function getAppConfig(workspaceFolder: vscode.WorkspaceFolder) {
	return vscode.workspace.getConfiguration("justGDB", workspaceFolder);
}

interface DebugPreset {
	program: string;
	runDirectly: boolean;
}

async function COMMAND_start() {
	if (globalDebugSession !== null) {
		globalDebugSession.terminal.show();
		vscode.window.showErrorMessage("GDB session is active already.");
		return;
	}

	const globalConfig = getGlobalConfig();
	const gdbPath = globalConfig.get<string>('gdbPath', 'gdb');

	const workspaceFolder = getCurrentWorkspaceFolder();
	if (workspaceFolder === undefined) {
		vscode.window.showErrorMessage("There is no workspace folder.");
		return;
	}
	const appConfig = getAppConfig(workspaceFolder);
	if (appConfig === undefined) {
		vscode.window.showErrorMessage("Could not find app configuration.");
		return;
	}
	const debugPresets = appConfig.get<DebugPreset[]>("debugPresets", []);
	if (debugPresets.length === 0) {
		vscode.window.showErrorMessage("No debug preset found.");
		return;
	}
	const debugPreset = debugPresets[0];
	const program = debugPreset.program.replace("${workspaceFolder}", workspaceFolder.uri.fsPath);
	const runDirectly = debugPreset.runDirectly;

	globalDebugSession = await new Promise<DebugSession>((resolve) => {
		const newDebugSession = new DebugSession(gdbPath, [], 'gdb', () => { resolve(newDebugSession); });
	});
	if (globalDebugSession === null) {
		return;
	}

	globalDebugSession.terminal.show();
	if (vscode.debug.breakpoints.length > 0) {
		globalDebugSession.executePythonFunction("set_breakpoints", {
			vscode_breakpoints: vscode.debug.breakpoints
		});
	}

	if (program.length > 0) {
		globalDebugSession.sendInternalCommandToGDB(`file ${program}`);
		if (runDirectly) {
			globalDebugSession.sendInternalCommandToGDB('run');
		}
	}
}


function COMMAND_pause() {
	globalDebugSession?.interrupt();
}

function COMMAND_stepOver() {
	globalDebugSession?.sendInternalCommandToGDB("n");
}

function COMMAND_stepInto() {
	globalDebugSession?.sendInternalCommandToGDB("s");
}

function COMMAND_stepOut() {
	globalDebugSession?.sendInternalCommandToGDB("finish");
}

function COMMAND_continue() {
	globalDebugSession?.sendInternalCommandToGDB("c");
}

function COMMAND_loadBacktrace() {
	globalDebugSession?.sendInternalCommandToGDB("python request_backtrace()");
}

// let currentLine = 1;

// const currentLineDecorationType = vscode.window.createTextEditorDecorationType({
// 	isWholeLine: true,
// 	backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
// 	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
// });

function COMMAND_playground() {
	// const editor = vscode.window.visibleTextEditors[0];
	// editor.setDecorations(currentLineDecorationType, [new vscode.Range(currentLine, 0, currentLine, 100000)]);
	// currentLine++;

	// const terminal = vscode.window.createTerminal("GDB", "gdb");
	// terminal.show();
	// terminal.sendText("r\t\t", false);
	// setTimeout(() => {
	// 	terminal.processId.then((value) => {
	// 		if (value !== undefined) {
	// 			process.kill(value, 'SIGINT');
	// 		}
	// 	})
	// }, 2000);

	// console.log(process.argv0);
}


class ContextViewProvider implements vscode.TreeDataProvider<ContextViewItem>{
	private _onDidChangeTreeData = new vscode.EventEmitter<ContextViewItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	stackFrames: string[] = [];

	refresh() {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: ContextViewItem) {
		return element;
	}

	getChildren(element?: ContextViewItem): vscode.ProviderResult<ContextViewItem[]> {
		if (element) {
			return [];
		}
		else {
			let items = [];
			items.push(new LoadBacktraceItem());
			for (let name of this.stackFrames) {
				items.push(new StackFrameItem(name));
			}
			return items;
		}
	}
};

class ContextViewItem extends vscode.TreeItem {
};



class LoadBacktraceItem extends ContextViewItem {
	constructor() {
		super("Load");
		this.command = {
			title: "Load",
			command: "just-gdb.loadBacktrace",
		};
	}
};

class StackFrameItem extends ContextViewItem {
	constructor(label: string) {
		super(label);
	}
};
