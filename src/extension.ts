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
}

export function deactivate() { }

function COMMAND_startGDB() {
	if (gdb_process !== null) {
		return;
	}
	gdb_process = child_process.spawn("gdb", ["/home/jacques/Documents/test_c_debug/a.out"])
	gdb_process.stdout.on('data', on_gdb_stdout);
	gdb_process.on('close', on_gdb_close);
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
	const editor = vscode.window.visibleTextEditors[0];
	editor.setDecorations(currentLineDecorationType, [new vscode.Range(currentLine, 0, currentLine, 100000)]);
	currentLine++;
}

function on_gdb_stdout(data: Buffer) {
	console.log(data.toString());
}

function on_gdb_close(status_code: number) {
	gdb_process = null;
}
