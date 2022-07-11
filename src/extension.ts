import * as vscode from "vscode";
import * as child_process from "child_process";
import * as path from "path";

const currentLineDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor(
    "editor.stackFrameHighlightBackground"
  ),
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

const focusedLineDecorationType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor(
    "editor.focusedStackFrameHighlightBackground"
  ),
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

interface PacketFromGDB {
  functionName: string;
  args: object;
}

interface HandleStopEventArgs {}

interface HandleExitedEventArgs {}

interface CurrentPositionRequestFailedArgs {}

interface CurrentPositionRequestFinishedArgs {
  isNewestFrame: boolean;
  filePath: string;
  line: number;
}

interface FoundInferiorContextArgs {
  inferiorID: number;
  inferiorName: string;
}

interface FoundThreadContextArgs {
  inferiorID: number;
  globalThreadID: number;
  threadName: string;
}

interface FoundFrameContextArgs {
  inferiorID: number;
  globalThreadID: number;
  functionName: string;
  level: number;
}

interface HoverRequestFinishedArgs {
  expression: string;
  value: string;
}

interface HoverRequestFailedArgs {
  expression: string;
}

interface HoverRequestInfo {
  expression: string;
  resolve: (value: string) => void;
  reject: () => void;
}

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
  gdbAcceptsInputs: boolean = false;

  constructor(
    gdbBinaryPath: string,
    args: string[],
    terminalName: string,
    startupFinished: () => void
  ) {
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
      },
    });

    const callables = [
      this.handleContinueEvent,
      this.handleStopEvent,
      this.handleExitedEvent,
      this.hoverRequestFinished,
      this.hoverRequestFailed,
      this.foundInferiorContext,
      this.foundThreadContext,
      this.foundFrameContext,
      this.currentPositionRequestFinished,
      this.currentPositionRequestFailed,
    ];
    for (const callable of callables) {
      this.registeredCallablesByName.set(callable.name, callable.bind(this));
    }
  }

  private onTerminalOpen() {
    // Only create the process once the terminal is open, so that the
    // initial output is not ignored by the terminal.
    this.gdbProcess = child_process.spawn(this.gdbBinaryPath, this.gdbArgs);
    this.gdbProcess.stdout?.on("data", this.onProcessStdout.bind(this));
    this.gdbProcess.stderr?.on("data", this.onProcessStderr.bind(this));
    this.gdbProcess.on("close", this.onProcessClose.bind(this));

    this.updateGDBAcceptsInput(true);
    this.executeInternalCommandInGDB("source " + gdbExtensionPath);
    this.startupFinished();
  }

  private cleanupAfterSession() {
    this.clearLineDecorations();
    this.resetContextView();
    this.updateGDBAcceptsInput(false);
  }

  private onTerminalClose() {
    this.gdbProcess?.kill();
    this.cleanupAfterSession();
  }

  private onUserInputInTerminal(data: string) {
    if (data.charCodeAt(0) == 3) {
      // Ctrl+C
      this.interrupt();
      return;
    }
    if (!this.gdbAcceptsInputs) {
      return;
    }
    if (data.endsWith("\r")) {
      // Enter
      this.terminalWriteEmitter.fire("\n\r");
      this.executeUserCommandInGDB(this.currentTerminalLine);
      this.currentTerminalLine = "";
      return;
    }
    if (data === "\x7f") {
      // Backspace
      this.terminalWriteEmitter.fire("\x1b[D");
      this.terminalWriteEmitter.fire("\x1b[P");
      this.currentTerminalLine = this.currentTerminalLine.slice(0, -1);
      return;
    }
    if (data === "\t") {
      // Tab
      // Auto-complete is not quite working yet, ignore for now.
      return;
    }
    this.currentTerminalLine += data;
    this.terminalWriteEmitter.fire(data);
  }

  private onProcessStdout(data: Buffer) {
    const dataStr = data.toString();
    const internalDataTag = "##!@";

    let remainingStr = dataStr;
    let strForTerminal = "";

    while (remainingStr.length > 0) {
      const nextTagIndex = remainingStr.indexOf(internalDataTag);
      if (nextTagIndex === -1) {
        if (this.currentPacketStr === null) {
          strForTerminal += remainingStr;
          break;
        } else {
          this.currentPacketStr += dataStr;
          break;
        }
      } else {
        if (this.currentPacketStr === null) {
          strForTerminal += remainingStr.slice(0, nextTagIndex);
          remainingStr = remainingStr.slice(
            nextTagIndex + internalDataTag.length
          );
          this.currentPacketStr = "";
        } else {
          const packetStr =
            this.currentPacketStr + remainingStr.slice(0, nextTagIndex);
          remainingStr = remainingStr.slice(
            nextTagIndex + internalDataTag.length
          );
          this.processPacket(packetStr);
          this.currentPacketStr = null;
        }
      }
    }

    if (strForTerminal.length > 0) {
      const lines = strForTerminal.split("\n");
      const lastLine = lines[lines.length - 1];
      if (lastLine.length == 0) {
        lines.pop();
      }
      for (let i = 0; i < lines.length - 1; i++) {
        this.terminalWriteEmitter.fire(lines[i]);
        this.terminalWriteEmitter.fire("\n\r");
      }
      this.terminalWriteEmitter.fire(lines[lines.length - 1]);
      if (strForTerminal.endsWith("\n")) {
        this.terminalWriteEmitter.fire("\n\r");
      }
    }
  }

  private processPacket(packetStr: string) {
    const packet: PacketFromGDB = JSON.parse(packetStr);
    const f = this.registeredCallablesByName.get(packet.functionName);
    if (f === undefined) {
      console.log(`Cannot find function ${packet.functionName}`);
      return;
    }
    f(packet.args);
  }

  private onProcessStderr(data: Buffer) {
    console.log(data.toString());
    this.terminalWriteEmitter.fire(data.toString());
  }
  private onProcessClose() {
    globalDebugSession = null;
    this.gdbProcess?.kill();
    this.terminalWriteEmitter.fire("\n\r\n\rGDB exited.\n\r");
    this.cleanupAfterSession();
  }

  executePythonFunctionInGDB(functionName: string, args: object) {
    const argsStr = JSON.stringify(args);
    const argsBase64 = Buffer.from(argsStr).toString("base64");
    this.forwardCommandToGDB(
      `python invoke_function_from_vscode("${functionName}", "${argsBase64}")`
    );
    this.terminalWriteEmitter.fire(`Internal Python Call: ${functionName}\n\r`);
  }

  executeInternalCommandInGDB(command: string) {
    this.forwardCommandToGDB(command);
    this.terminalWriteEmitter.fire(`Internal Command: ${command}\n\r`);
  }

  executeUserCommandInGDB(command: string) {
    this.forwardCommandToGDB(command);
  }

  forwardCommandToGDB(command: string) {
    this.gdbProcess?.stdin?.write(command + "\n");
  }

  interrupt() {
    this.gdbProcess?.kill("SIGINT");
  }

  clearLineDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(currentLineDecorationType, []);
      editor.setDecorations(focusedLineDecorationType, []);
    }
  }

  resetContextView() {
    if (contextViewProvider) {
      availableContextsCache.clear();
      contextViewProvider.refresh();
    }
  }

  handleContinueEvent(args: any) {
    this.clearLineDecorations();
    this.resetContextView();
    this.updateGDBAcceptsInput(false);
  }

  handleStopEvent(args: HandleStopEventArgs) {
    this.updateGDBAcceptsInput(true);
    this.executePythonFunctionInGDB("request_current_position", {});
  }

  handleExitedEvent(args: HandleExitedEventArgs) {
    this.updateGDBAcceptsInput(true);
  }

  updateGDBAcceptsInput(acceptsInput: boolean) {
    this.gdbAcceptsInputs = acceptsInput;
    vscode.commands.executeCommand(
      "setContext",
      "just-gdb.gdbAcceptsInput",
      acceptsInput
    );
  }

  currentPositionRequestFinished(args: CurrentPositionRequestFinishedArgs) {
    let filePath: string = args.filePath;
    const line: number = args.line;
    vscode.window.showTextDocument(vscode.Uri.file(filePath)).then((editor) => {
      const range = new vscode.Range(line, 0, line, 100000);
      const decorationType = args.isNewestFrame
        ? currentLineDecorationType
        : focusedLineDecorationType;
      editor.setDecorations(decorationType, [range]);
      editor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
      // Would be nice to move the vscode window to the front here, but there does
      // not seem to be an API for that.
    });
  }

  currentPositionRequestFailed(args: CurrentPositionRequestFailedArgs) {}

  hoverRequestFinished(args: HoverRequestFinishedArgs) {
    const remainingRequests = [];
    for (const request of this.pendingHoverRequests) {
      if (request.expression == args.expression) {
        request.resolve(args.value);
      } else {
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
      } else {
        remainingRequests.push(request);
      }
    }
    this.pendingHoverRequests = remainingRequests;
  }

  foundInferiorContext(args: FoundInferiorContextArgs) {
    availableContextsCache.addInferior(args);
    contextViewProvider?.refresh();
  }

  foundThreadContext(args: FoundThreadContextArgs) {
    availableContextsCache.addThread(args);
    contextViewProvider?.refresh();
  }

  foundFrameContext(args: FoundFrameContextArgs) {
    availableContextsCache.addFrame(args);
    contextViewProvider?.refresh();
  }
}

let globalDebugSession: DebugSession | null = null;
let contextViewProvider: ContextViewProvider | null = null;

export function activate(context: vscode.ExtensionContext) {
  const commands: [string, any][] = [
    ["just-gdb.start", COMMAND_start],
    ["just-gdb.pause", COMMAND_pause],
    ["just-gdb.playground", COMMAND_playground],
    ["just-gdb.stepOver", COMMAND_stepOver],
    ["just-gdb.stepInto", COMMAND_stepInto],
    ["just-gdb.stepOut", COMMAND_stepOut],
    ["just-gdb.continue", COMMAND_continue],
    ["just-gdb.loadSelectedContext", COMMAND_loadSelectedContext],
    ["just-gdb.checkForMoreThreads", COMMAND_checkForMoreThreads],
    ["just-gdb.loadAllAvailableContexts", COMMAND_loadAllAvailableContexts],
  ];

  for (const item of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(item[0], item[1])
    );
  }

  const hoverProvider: vscode.HoverProvider = {
    provideHover(document, position, token) {
      if (globalDebugSession === null) {
        return;
      }
      if (!globalDebugSession.gdbAcceptsInputs) {
        return;
      }
      const lineStr = document.lineAt(position.line).text;
      const hoverIndex = position.character;
      let startIndex = hoverIndex;
      while (
        startIndex > 0 &&
        lineStr[startIndex - 1].match(/[a-zA-Z0-9_\.]/)
      ) {
        startIndex--;
      }
      let endIndex = hoverIndex;
      while (
        endIndex < lineStr.length - 1 &&
        lineStr[endIndex].match(/[a-zA-Z0-9_]/)
      ) {
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
          },
        });
        globalDebugSession?.executePythonFunctionInGDB("request_hover_value", {
          expression,
        });
      });
    },
  };

  vscode.languages.registerHoverProvider("cpp", hoverProvider);
  vscode.languages.registerHoverProvider("c", hoverProvider);

  contextViewProvider = new ContextViewProvider();
  vscode.window.createTreeView("gdbContext", {
    treeDataProvider: contextViewProvider,
  });

  // Start loading breakpoints. Also see https://github.com/microsoft/vscode/issues/130138.
  vscode.debug.breakpoints;

  vscode.debug.onDidChangeBreakpoints((e) => {
    if (globalDebugSession === null) {
      return;
    }
    // Todo: Potentially interrupt the application to set breakpoints.
    if (e.added.length > 0) {
      globalDebugSession.executePythonFunctionInGDB("set_breakpoints", {
        vscode_breakpoints: e.added,
      });
    }
    if (e.removed.length > 0) {
      globalDebugSession.executePythonFunctionInGDB("remove_breakpoints", {
        vscode_breakpoints: e.removed,
      });
    }
  });
}

export function deactivate() {}

const mainDir = path.dirname(__dirname);
const sourceDir = path.join(mainDir, "src");
const gdbExtensionPath = path.join(sourceDir, "gdb_extension.py");

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
  const gdbPath = globalConfig.get<string>("gdbPath", "gdb");

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
  const program = debugPreset.program.replace(
    "${workspaceFolder}",
    workspaceFolder.uri.fsPath
  );
  const programIsSet = program.length > 0;
  const runDirectly = debugPreset.runDirectly;

  globalDebugSession = await new Promise<DebugSession>((resolve) => {
    const newDebugSession = new DebugSession(gdbPath, [], "gdb", () => {
      resolve(newDebugSession);
    });
  });
  if (globalDebugSession === null) {
    return;
  }

  globalDebugSession.terminal.show();
  if (programIsSet) {
    globalDebugSession.executeInternalCommandInGDB(`file ${program}`);
  }
  if (vscode.debug.breakpoints.length > 0) {
    globalDebugSession.executePythonFunctionInGDB("set_breakpoints", {
      vscode_breakpoints: vscode.debug.breakpoints,
    });
  }
  if (programIsSet && runDirectly) {
    globalDebugSession.executeInternalCommandInGDB("run");
    globalDebugSession.updateGDBAcceptsInput(false);
  }

  contextViewProvider?.refresh();
}

function COMMAND_pause() {
  globalDebugSession?.interrupt();
}

function COMMAND_stepOver() {
  if (globalDebugSession?.gdbAcceptsInputs) {
    globalDebugSession.executeInternalCommandInGDB("n");
  }
}

function COMMAND_stepInto() {
  if (globalDebugSession?.gdbAcceptsInputs) {
    globalDebugSession.executeInternalCommandInGDB("s");
  }
}

function COMMAND_stepOut() {
  if (globalDebugSession?.gdbAcceptsInputs) {
    globalDebugSession.executeInternalCommandInGDB("finish");
  }
}

function COMMAND_continue() {
  if (globalDebugSession?.gdbAcceptsInputs) {
    globalDebugSession.executeInternalCommandInGDB("c");
  }
}

function COMMAND_loadSelectedContext() {
  if (globalDebugSession?.gdbAcceptsInputs) {
    globalDebugSession.executePythonFunctionInGDB(
      "request_backtrace_for_current_thread",
      {}
    );
  }
}

function COMMAND_checkForMoreThreads(inferiorID: number) {
  if (globalDebugSession?.gdbAcceptsInputs) {
    globalDebugSession.executePythonFunctionInGDB(
      "request_all_threads_in_inferior",
      {
        inferior_id: inferiorID,
      }
    );
  }
}

function COMMAND_loadAllAvailableContexts() {
  if (globalDebugSession?.gdbAcceptsInputs) {
    globalDebugSession.executePythonFunctionInGDB(
      "request_all_available_contexts",
      {}
    );
  }
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

class FrameContextCache {
  level: number;
  functionName: string;

  constructor(functionName: string, level: number) {
    this.functionName = functionName;
    this.level = level;
  }
}

class ThreadContextCache {
  globalID: number;
  threadName: string;
  frames = new Map<number, FrameContextCache>();

  constructor(globalID: number, threadName: string) {
    this.globalID = globalID;
    this.threadName = threadName;
  }
}

class InferiorContextCache {
  inferiorID: number;
  inferiorName: string;
  threads = new Map<number, ThreadContextCache>();

  constructor(inferiorID: number, inferiorName: string) {
    this.inferiorID = inferiorID;
    this.inferiorName = inferiorName;
  }
}

class AvailableContextsCache {
  inferiors = new Map<number, InferiorContextCache>();

  clear() {
    this.inferiors.clear();
  }

  addInferior(data: FoundInferiorContextArgs) {
    if (this.inferiors.has(data.inferiorID)) {
      return;
    }
    this.inferiors.set(
      data.inferiorID,
      new InferiorContextCache(data.inferiorID, data.inferiorName)
    );
  }

  addThread(data: FoundThreadContextArgs) {
    const inferior = this.inferiors.get(data.inferiorID);
    if (inferior === undefined || inferior.threads.has(data.globalThreadID)) {
      return;
    }
    inferior.threads.set(
      data.globalThreadID,
      new ThreadContextCache(data.globalThreadID, data.threadName)
    );
  }

  addFrame(data: FoundFrameContextArgs) {
    const inferior = this.inferiors.get(data.inferiorID);
    const thread = inferior?.threads.get(data.globalThreadID);
    if (thread === undefined || thread.frames.has(data.level)) {
      return;
    }
    thread.frames.set(
      data.level,
      new FrameContextCache(data.functionName, data.level)
    );
  }
}

const availableContextsCache = new AvailableContextsCache();

class ContextViewProvider implements vscode.TreeDataProvider<ContextViewItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ContextViewItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ContextViewItem) {
    return element;
  }

  getChildren(
    element?: ContextViewItem
  ): vscode.ProviderResult<ContextViewItem[]> {
    if (element) {
      if (element instanceof ContextInferiorItem) {
        const items = [];
        items.push(new LoadThreadsInInferiorContextItem(element.inferior));
        for (const thread of element.inferior.threads.values()) {
          items.push(new ContextThreadItem(thread));
        }
        return items;
      }
      if (element instanceof ContextThreadItem) {
        const items = [];
        const levels = [...element.thread.frames.keys()];
        levels.sort();
        for (const level of levels) {
          const frame = element.thread.frames.get(level)!;
          items.push(new ContextFrameItem(frame));
        }
        return items;
      }
      return [];
    }
    const topLevelItems = [];
    if (globalDebugSession === null) {
      topLevelItems.push(new StartDebuggingContextItem());
    } else {
      topLevelItems.push(new LoadAllAvailableContextsItem());
      if (availableContextsCache.inferiors.size == 0) {
        topLevelItems.push(new LoadSelectedContextItem());
      } else {
        for (const inferior of availableContextsCache.inferiors.values()) {
          topLevelItems.push(new ContextInferiorItem(inferior));
        }
      }
    }
    return topLevelItems;
  }
}

class ContextViewItem extends vscode.TreeItem {}

class StartDebuggingContextItem extends ContextViewItem {
  constructor() {
    super("Start");
    this.command = {
      title: "Start",
      command: "just-gdb.start",
    };
  }
}

class LoadSelectedContextItem extends ContextViewItem {
  constructor() {
    super("Load Selected");
    this.command = {
      title: "Load selected context",
      command: "just-gdb.loadSelectedContext",
    };
  }
}

class LoadThreadsInInferiorContextItem extends ContextViewItem {
  constructor(inferior: InferiorContextCache) {
    super("Check for more threads");
    this.command = {
      title: "Check for more threads",
      command: "just-gdb.checkForMoreThreads",
      arguments: [inferior.inferiorID],
    };
  }
}

class LoadAllAvailableContextsItem extends ContextViewItem {
  constructor() {
    super("Load all available contexts");
    this.command = {
      title: "Load all available contexts",
      command: "just-gdb.loadAllAvailableContexts",
    };
  }
}

class ContextInferiorItem extends ContextViewItem {
  inferior: InferiorContextCache;

  constructor(inferior: InferiorContextCache) {
    super(inferior.inferiorName);
    this.inferior = inferior;
    this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
  }
}

class ContextThreadItem extends ContextViewItem {
  thread: ThreadContextCache;

  constructor(thread: ThreadContextCache) {
    super(thread.threadName);
    this.thread = thread;
    this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
  }
}

class ContextFrameItem extends ContextViewItem {
  frame: FrameContextCache;

  constructor(frame: FrameContextCache) {
    super(frame.functionName);
    this.frame = frame;
  }
}
