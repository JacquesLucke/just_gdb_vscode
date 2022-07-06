def print_file_stack():
  frame = gdb.newest_frame()
  while frame is not None:
    print(frame.find_sal().symtab.filename)
    frame = frame.older()
