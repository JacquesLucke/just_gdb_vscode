import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

const currentLineDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

class DebugSession {
	gdbBinaryPath: string;
	gdbArgs: string[];
	terminalWriteEmitter: vscode.EventEmitter<string>;
	terminal: vscode.Terminal;
	gdbProcess: child_process.ChildProcess | null = null;
	private currentTerminalLine: string = "";
	private currentPacketStr: string | null = null;

	constructor(gdbBinaryPath: string, args: string[], terminalName: string) {
		this.gdbBinaryPath = gdbBinaryPath;
		this.gdbArgs = args;
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
	}

	private onTerminalOpen() {
		// Only create the process once the terminal is open, so that the
		// initial output is not ignored by the terminal.
		this.gdbProcess = child_process.spawn(this.gdbBinaryPath, this.gdbArgs);
		this.gdbProcess.stdout?.on('data', this.onProcessStdout.bind(this));
		this.gdbProcess.stderr?.on('data', this.onProcessStderr.bind(this));
		this.gdbProcess.on('close', this.onProcessClose.bind(this));

		this.sendCommandToTerminalAndGDB("source " + gdbExtensionPath);
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
			this.forwardTextToGDB(this.currentTerminalLine + "\n");
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
			// Auto-complete is not quite working yet.
			this.forwardTextToGDB(this.currentTerminalLine);
			this.forwardTextToGDB('\t');
			this.terminalWriteEmitter.fire('\n\r');
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

	private processPacket(packet: any) {
		const packetType = packet['type'];

		if (packetType == "current_position") {
			let filePath: string = packet['file_path'];
			const line: number = packet["line"];
			if (filePath == "main.cc") {
				filePath = "/home/jacques/Documents/test_c_debug/main.cc";
			}
			vscode.window.showTextDocument(vscode.Uri.file(filePath)).then((editor) => {
				const range = new vscode.Range(line, 0, line, 100000);
				editor.setDecorations(currentLineDecorationType, [range]);
			});
			console.log("update position")
		}
		if (packetType == "continue") {
			console.log("continue");
			vscode.window.activeTextEditor?.setDecorations(currentLineDecorationType, []);
		}
	}

	private onProcessStderr(data: Buffer) {
		this.processOutputToTerminal(data);
	}
	private onProcessClose() {
		debugSession = null;
		this.gdbProcess?.kill();
		this.terminalWriteEmitter.fire("\n\r\n\rGDB exited.\n\r");
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

	sendCommandToTerminalAndGDB(command: string) {
		this.terminalWriteEmitter.fire(command + "\n\r");
		this.forwardTextToGDB(command + "\n");
	}

	forwardTextToGDB(text: string) {
		this.gdbProcess?.stdin?.write(text);
	}

	interrupt() {
		this.gdbProcess?.kill('SIGINT');
	}
};


let debugSession: DebugSession | null = null;

export function activate(context: vscode.ExtensionContext) {

	const commands: [string, any][] = [
		['just-gdb.startGDB', COMMAND_startGDB],
		['just-gdb.run', COMMAND_run],
		['just-gdb.pause', COMMAND_pause],
		['just-gdb.playground', COMMAND_playground],
		['just-gdb.stepOver', COMMAND_stepOver],
		['just-gdb.stepInto', COMMAND_stepInto],
		['just-gdb.stepOut', COMMAND_stepOut],
	];

	for (const item of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(item[0], item[1]));
	}

	// vscode.window.createTreeView("gdbThreads", { treeDataProvider: new ThreadsViewProvider() });
}

export function deactivate() { }

const mainDir = path.dirname(__dirname);
const sourceDir = path.join(mainDir, "src");
const gdbExtensionPath = path.join(sourceDir, "gdb_extension.py")


function COMMAND_startGDB() {
	if (debugSession !== null) {
		return;
	}

	debugSession = new DebugSession("gdb", ["/home/jacques/Documents/test_c_debug/a.out"], "GDB");
	debugSession.terminal.show();
}

function COMMAND_run() {
	if (debugSession === null) {
		return;
	}
	debugSession.forwardTextToGDB("run\n");
}

function COMMAND_pause() {
	debugSession?.interrupt();
}

function COMMAND_stepOver() {
	debugSession?.sendCommandToTerminalAndGDB("n");
}

function COMMAND_stepInto() {
	debugSession?.sendCommandToTerminalAndGDB("s");
}

function COMMAND_stepOut() {
	debugSession?.sendCommandToTerminalAndGDB("finish");
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


// class ThreadsViewProvider implements vscode.TreeDataProvider<ThreadsViewItem>{
// 	getTreeItem(element: ThreadsViewItem) {
// 		return element;
// 	}

// 	getChildren(element?: ThreadsViewItem): vscode.ProviderResult<ThreadsViewItem[]> {
// 		if (element) {
// 			return [];
// 		}
// 		else {
// 			return [new ThreadsViewItem(), new ThreadsViewItem()];
// 		}

// 	}
// };

// class ThreadsViewItem extends vscode.TreeItem {
// 	constructor() {
// 		super("Hello World");
// 	}
// };
