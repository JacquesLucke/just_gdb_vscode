import json
import base64

start_tag = "##!@"
end_tag = start_tag[::-1]

def send_data_to_vscode(data: object):
  data_to_send = start_tag + json.dumps(data) + end_tag
  print(data_to_send)

def handle_stop(event):
  file_names = []
  frame = gdb.newest_frame()
  while frame is not None:
    if sal := frame.find_sal():
      if symtab := sal.symtab:
        if filename := symtab.filename:
          send_data_to_vscode({
            "type": "current_position",
            "file_path": filename,
            "line": sal.line - 1,
          })
          return
    frame = frame.older()

gdb.events.stop.connect(handle_stop)


def handle_continue(event):
  send_data_to_vscode({
    "type": "continue",
  })

gdb.events.cont.connect(handle_continue)

def request_hover_value(expression: str):
  try:
    value = gdb.parse_and_eval(expression)
  except:
    send_data_to_vscode({
      "type": "hover_value_fail",
      "expression": expression,
    })
    return
  value_str = str(value)
  send_data_to_vscode({
    "type": "hover_value",
    "expression": expression,
    "value": value_str,
  })

def request_backtrace():
  frame = gdb.newest_frame()
  frames = []
  while frame is not None:
    frames.append(str(frame.function()))
    frame = frame.older()
  send_data_to_vscode({
    "type": "backtrace",
    "frames": frames,
  })

def execute_function(function_name: str, kwargs_base64: str):
  kwargs_str = base64.b64decode(kwargs_base64)
  kwargs = json.loads(kwargs_str)
  f = allowed_functions_by_name[function_name]
  f(**kwargs)

def set_breakpoints(vscode_breakpoints):
  for vscode_breakpoint in vscode_breakpoints:
    if 'location' in vscode_breakpoint:
      path = vscode_breakpoint['location']['uri']['path']
      line = vscode_breakpoint['location']['range'][0]['line'] + 1
      gdb.Breakpoint(source=path, line=line)

def remove_breakpoints(vscode_breakpoints):
  for vscode_breakpoint in vscode_breakpoints:
    if 'location' in vscode_breakpoint:
      path = vscode_breakpoint['location']['uri']['path']
      line = vscode_breakpoint['location']['range'][0]['line'] + 1
      location_str = f"-source {path} -line {line}"
      for breakpoint in gdb.breakpoints():
        if breakpoint.location == location_str:
          breakpoint.delete()


allowed_function_list = [
  set_breakpoints,
  remove_breakpoints,
]
allowed_functions_by_name = {f.__name__ : f for f in allowed_function_list}
