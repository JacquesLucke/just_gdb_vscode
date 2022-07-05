import * as vscode from 'vscode';
import * as child_process from 'child_process';


let gdb_process: child_process.ChildProcessWithoutNullStreams | null = null;

export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand('direct-gdb.helloWorld', () => {
		if (gdb_process === null) {
			gdb_process = child_process.spawn("gdb", ["/home/jacques/Documents/test_c_debug/a.out"])
			gdb_process.stdout.on('data', on_gdb_stdout);
			gdb_process.on('close', on_gdb_close);
		}
		else {
			gdb_process.stdin.write("run\n");
		}
	});

	context.subscriptions.push(disposable);
}

export function deactivate() { }

function on_gdb_stdout(data: Buffer) {
	console.log(data.toString());
}

function on_gdb_close(status_code: number) {
	console.log('Closed');
}
