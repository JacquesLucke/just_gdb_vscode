import * as vscode from 'vscode';
import * as child_process from 'child_process';


let gdb_process: child_process.ChildProcessWithoutNullStreams | null = null;

export function activate(context: vscode.ExtensionContext) {

	const commands: [string, any][] = [
		['just-gdb.startGDB', COMMAND_startGDB],
		['just-gdb.run', COMMAND_run],
		['just-gdb.pause', COMMAND_pause],
		['just-gdb.playground', COMMAND_playground],
	];

	for (const item of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(item[0], item[1]));
	}

	vscode.window.createTreeView("gdbThreads", { treeDataProvider: new ThreadsViewProvider() });
}

export function deactivate() { }

function COMMAND_startGDB() {
	if (gdb_process !== null) {
		return;
	}


	const writeEmitter = new vscode.EventEmitter<string>();

	let line = "";
	const terminal = vscode.window.createTerminal({
		name: 'My Terminal', pty: {
			onDidWrite: writeEmitter.event,
			open: () => {
				gdb_process = child_process.spawn("gdb", ["/home/jacques/Documents/test_c_debug/a.out"])

				const handle_gdb_output = (data: Buffer) => {
					const data_str = data.toString();
					const lines = data_str.split("\n");
					for (let i = 0; i < lines.length - 1; i++) {
						writeEmitter.fire(lines[i] + "\n\r");
					}
					writeEmitter.fire(lines[lines.length - 1]);
					if (data_str.endsWith("\n")) {
						writeEmitter.fire("\n\r")
					}
				};

				gdb_process.stdout.on('data', handle_gdb_output);
				gdb_process.stderr.on('data', handle_gdb_output);
				gdb_process.on('close', on_gdb_close);

				vscode.debug.onDidChangeBreakpoints((e) => {
					for (const breakpoint of e.added) {
						if (breakpoint instanceof vscode.SourceBreakpoint) {
							if (gdb_process !== null) {
								const command = "b " + breakpoint.location.uri.fsPath + ":" + breakpoint.location.range.start.line;
								writeEmitter.fire(command + "\n\r");
								gdb_process.stdin.write(command + "\n");
							}
						}
					}
					for (const breakpoint of e.removed) {
						if (breakpoint instanceof vscode.SourceBreakpoint) {
							if (gdb_process != null) {
								const command = "clear " + breakpoint.location.uri.fsPath + ":" + breakpoint.location.range.start.line;
								writeEmitter.fire(command + "\n\r");
								gdb_process.stdin.write(command + "\n");
							}
						}
					}
				});
			},
			close: () => { },
			handleInput: (data: string) => {
				console.log(data.charCodeAt(0));
				if (data === '\r') { // Enter
					writeEmitter.fire('\n\r');
					gdb_process?.stdin.write(line);
					gdb_process?.stdin.write('\n');
					line = '';
					return;
				}
				if (data === '\x7f') { // Backspace
					writeEmitter.fire('\x1b[D');
					writeEmitter.fire('\x1b[P');
					return;
				}
				if (data === '\t') {
					writeEmitter.fire('tab');
					return;
				}
				line += data;
				writeEmitter.fire(data);
			},
		}
	});
	terminal.show();


}

function COMMAND_run() {
	if (gdb_process === null) {
		return;
	}
	// gdb_process.stdin.write("b main.cc:8\n");
	gdb_process.stdin.write("run\n");
}

function COMMAND_pause() {
	if (gdb_process === null) {
		return;
	}
	gdb_process.kill('SIGINT');
	gdb_process.stdin.write("p i\n");
}

let currentLine = 1;

const currentLineDecorationType = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor("editor.stackFrameHighlightBackground"),
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

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

function on_gdb_close(status_code: number) {
	gdb_process = null;
}


class ThreadsViewProvider implements vscode.TreeDataProvider<ThreadsViewItem>{
	getTreeItem(element: ThreadsViewItem) {
		return element;
	}

	getChildren(element?: ThreadsViewItem): vscode.ProviderResult<ThreadsViewItem[]> {
		if (element) {
			return [];
		}
		else {
			return [new ThreadsViewItem(), new ThreadsViewItem()];
		}

	}
};

class ThreadsViewItem extends vscode.TreeItem {
	constructor() {
		super("Hello World");
	}
};
