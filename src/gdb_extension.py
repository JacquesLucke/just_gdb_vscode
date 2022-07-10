import gdb
import json
import base64

internal_data_tag = "##!@"


def send_data_to_vscode(data: object):
    data_to_send = internal_data_tag + json.dumps(data) + internal_data_tag
    print(data_to_send, end="", flush=True)


def invoke_vscode_function(name: str, **kwargs):
    send_data_to_vscode(
        {
            "functionName": name,
            "args": kwargs,
        }
    )


def handle_stop(event):
    file_names = []
    frame = gdb.newest_frame()
    while frame is not None:
        if sal := frame.find_sal():
            if symtab := sal.symtab:
                if filename := symtab.filename:
                    invoke_vscode_function(
                        "handleStopEvent", filePath=filename, line=sal.line - 1
                    )
                    return
        frame = frame.older()


gdb.events.stop.connect(handle_stop)


def handle_continue(event):
    invoke_vscode_function(
        "handleContinueEvent",
    )


gdb.events.cont.connect(handle_continue)


def invoke_function_from_vscode(function_name: str, kwargs_base64: str):
    kwargs_str = base64.b64decode(kwargs_base64)
    kwargs = json.loads(kwargs_str)
    f = registered_callables_by_name[function_name]
    f(**kwargs)


registered_callables_by_name = {}


def vscode_callable(func):
    registered_callables_by_name[func.__name__] = func
    return func


@vscode_callable
def set_breakpoints(vscode_breakpoints):
    for vscode_breakpoint in vscode_breakpoints:
        if "location" in vscode_breakpoint:
            path = vscode_breakpoint["location"]["uri"]["path"]
            line = vscode_breakpoint["location"]["range"][0]["line"] + 1
            gdb.Breakpoint(source=path, line=line)


@vscode_callable
def remove_breakpoints(vscode_breakpoints):
    for vscode_breakpoint in vscode_breakpoints:
        if "location" in vscode_breakpoint:
            path = vscode_breakpoint["location"]["uri"]["path"]
            line = vscode_breakpoint["location"]["range"][0]["line"] + 1
            location_str = f"-source {path} -line {line}"
            for breakpoint in gdb.breakpoints():
                if breakpoint.location == location_str:
                    breakpoint.delete()


@vscode_callable
def request_hover_value(expression: str):
    try:
        value = gdb.parse_and_eval(expression)
    except:
        invoke_vscode_function(
            "hoverRequestFailed",
            expression=expression,
        )
        return
    value_str = str(value)
    invoke_vscode_function(
        "hoverRequestFinished", expression=expression, value=value_str
    )


@vscode_callable
def request_backtrace():
    frame = gdb.newest_frame()
    frames = []
    while frame is not None:
        frames.append(str(frame.function()))
        frame = frame.older()
    invoke_vscode_function(
        "backtraceRequestFinished",
        frames=frames,
    )
