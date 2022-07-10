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
    invoke_vscode_function("handleStopEvent")


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


def send_found_inferior(inferior):
    invoke_vscode_function(
        "foundInferiorContext",
        inferiorID=inferior.num,
        inferiorName=inferior.progspace.filename,
    )


def send_found_thread(inferior, thread):
    invoke_vscode_function(
        "foundThreadContext",
        inferiorID=inferior.num,
        globalThreadID=thread.global_num,
        threadName="<no name>" if thread.name is None else thread.name,
    )


def send_found_frame(inferior, thread, frame):
    invoke_vscode_function(
        "foundFrameContext",
        inferiorID=inferior.num,
        globalThreadID=thread.global_num,
        functionName=str(frame.function()),
        level=frame.level(),
    )


@vscode_callable
def request_backtrace_for_current_thread():
    thread = gdb.selected_thread()
    frame = gdb.newest_frame()
    inferior = thread.inferior

    send_found_inferior(inferior)
    send_found_thread(inferior, thread)

    while frame is not None:
        send_found_frame(inferior, thread, frame)
        frame = frame.older()


@vscode_callable
def request_all_threads_in_inferior(inferior_id: int):
    for inferior in gdb.inferiors():
        if inferior.num == inferior_id:
            break
    else:
        return

    send_found_inferior(inferior)
    for thread in inferior.threads():
        send_found_thread(inferior, thread)


@vscode_callable
def request_current_position():
    frame = gdb.newest_frame()
    while frame is not None:
        sal = frame.find_sal()
        if sal is None:
            frame = frame.older()
            continue
        symtab = sal.symtab
        if symtab is None:
            frame = frame.older()
            continue
        is_newest_frame = frame == gdb.newest_frame()
        filepath = symtab.fullname()
        # GDB line indices start at 1.
        line = sal.line - 1
        invoke_vscode_function(
            "currentPositionRequestFinished",
            isNewestFrame=is_newest_frame,
            filePath=filepath,
            line=line,
        )
        return
    invoke_vscode_function("currentPositionRequestFailed")
