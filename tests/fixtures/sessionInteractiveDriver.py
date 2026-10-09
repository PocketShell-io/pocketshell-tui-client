import re,os,sys,pty,fcntl,termios,struct,subprocess,select,time,json,signal
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',29,91,0,0));before=termios.tcgetattr(slave)
def child_setup():
 os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
env={'PATH':'/usr/bin:/bin','HOME':os.environ['HOME'],'PSC_FIXTURE_PROCESS_MODULE':sys.argv[3]}
p=subprocess.Popen([sys.argv[1],'--import',sys.argv[2],sys.argv[4]],stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=child_setup)
data=b'';deadline=time.monotonic()+12
def until(marker):
 global data
 while marker not in data:
  if time.monotonic()>deadline:raise RuntimeError('Synthetic PTY witness deadline: '+repr(data[-1000:]))
  r,_,_=select.select([master],[],[],0.1)
  if r:
   try:chunk=os.read(master,65536)
   except OSError:raise RuntimeError('PTY ended before '+repr(marker)+repr(data[-1000:]))
   if not chunk:raise RuntimeError('PTY EOF before witness')
   data+=chunk
try:
 until(b'PROMPT_READY');os.write(master,b'literal\n');until(b'BYTES:6c69746572616c0a')
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',37,113,0,0));until(b'RESIZE:37:113')
 os.write(master,b'\x02');time.sleep(0.05);os.write(master,b'd');until(b'RESULT:')
 p.wait(timeout=4)
 child_pid=int(re.search(rb'CHILD_PID:(\d+)',data).group(1))
 try:os.kill(child_pid,0);child_alive=True
 except ProcessLookupError:child_alive=False
 print(json.dumps({'childAliveAfterExit':child_alive,'transcript':data.decode('utf8','replace'),'terminalRestored':termios.tcgetattr(slave)==before,'nodeExit':p.returncode,'geometry':list(struct.unpack('HHHH',fcntl.ioctl(slave,termios.TIOCGWINSZ,b'\0'*8)))[:2]}))
finally:
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master);os.close(slave)
