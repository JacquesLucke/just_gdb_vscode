import json

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
    frames.append(str(frame))
    frame = frame.older()
  send_data_to_vscode({
    "type": "backtrace",
    "frames": frames,
  })
